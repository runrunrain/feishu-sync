/**
 * F10/ENOTEMPTY 修正轮专项：KbBuildService.shutdown 的 OS 级收口判定。
 *
 * 背景（fix2-runtime-report §九取证）：pipelineRuns 清空 ≠ quiescence——
 * termination-unconfirmed 的活子任务（pi FileAuthStorageBackend 惰性写者）
 * 在 home 被 rm 成功后仍会重建 auth.json。因此 shutdown 报告必须把
 * 持久/内存 termination-unconfirmed 纳入 unsettled 判定，quiesced=true
 * 才允许消费方清理运行目录；cancelled/流水线完成本身不是 OS 退出事实。
 *
 * 本文件测两层：
 * 1. resolveKbShutdownQuiescence（纯判定，覆盖三条专项验收）；
 * 2. KbBuildService.shutdown 的持久事实扫描（真实磁盘锚点/账本 degraded →
 *    fail-closed；无事实空根 → quiesced）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  KbBuildService,
  resolveKbShutdownQuiescence,
  type KbShutdownMemoryFact,
} from '../src/kb/kb-build-service.js';

describe('resolveKbShutdownQuiescence（OS 级收口纯判定）', () => {
  const base = { cancelled: ['b1'], unsettledRuns: [] as string[] };

  it('专项①：流水线已完（pipelineRuns 空）但终止对账 unconfirmed → 仍报未收口（quiesced=false）', () => {
    const memoryFacts: KbShutdownMemoryFact[] = [
      { buildId: 'b1', hasLeader: true, terminationState: 'unconfirmed' },
    ];
    const report = resolveKbShutdownQuiescence({ ...base, memoryFacts, diskOutcomes: [] });
    expect(report.unsettled).toEqual([]);
    expect(report.timedOut).toBe(false);
    expect(report.quiesced).toBe(false); // cancelled/流水线完成 ≠ OS 退出
    expect(report.unconfirmedTerminations).toEqual([
      expect.objectContaining({ buildId: 'b1', source: 'memory' }),
    ]);
  });

  it('专项①变体：有 Leader 但终止记录缺失（崩溃未落账窗口）→ 也不能当已收口', () => {
    const report = resolveKbShutdownQuiescence({
      ...base,
      memoryFacts: [{ buildId: 'b1', hasLeader: true, terminationState: null }],
      diskOutcomes: [],
    });
    expect(report.quiesced).toBe(false);
    expect(report.unconfirmedTerminations[0]?.note).toContain('无终止对账结果');
  });

  it('专项②：持久事实新鲜对账 confirmed 才允许清理（quiesced=true）；cancelled 但 OS 已确认不算未收口', () => {
    const report = resolveKbShutdownQuiescence({
      ...base,
      memoryFacts: [{ buildId: 'b1', hasLeader: true, terminationState: 'confirmed' }],
      diskOutcomes: [{ buildId: 'b1', outcome: 'confirmed' }],
    });
    expect(report.quiesced).toBe(true);
    expect(report.unconfirmedTerminations).toEqual([]);
  });

  it('专项②对称：内存 unconfirmed 可被同构建磁盘新鲜 confirmed 下调（OS 级证据覆盖旧内存结论）', () => {
    const report = resolveKbShutdownQuiescence({
      ...base,
      memoryFacts: [{ buildId: 'b1', hasLeader: true, terminationState: 'unconfirmed' }],
      diskOutcomes: [{ buildId: 'b1', outcome: 'confirmed', note: '锚点个体全部退出' }],
    });
    expect(report.quiesced).toBe(true);
  });

  it('专项③：shutdown 超时（流水线未收口）→ 如实返回 unsettled/timedOut，quiesced=false', () => {
    const report = resolveKbShutdownQuiescence({
      cancelled: ['b1'],
      unsettledRuns: ['b1'],
      memoryFacts: [{ buildId: 'b1', hasLeader: true, terminationState: 'confirmed' }],
      diskOutcomes: [{ buildId: 'b1', outcome: 'confirmed' }],
    });
    expect(report.unsettled).toEqual(['b1']);
    expect(report.timedOut).toBe(true);
    expect(report.quiesced).toBe(false);
  });

  it('持久对账 unconfirmed（active 条目已过 60s 保留期的构建）→ disk-reconcile 未收口', () => {
    const report = resolveKbShutdownQuiescence({
      ...base,
      memoryFacts: [],
      diskOutcomes: [{ buildId: 'b_old', outcome: 'unconfirmed', note: '锚点根存活未确认' }],
    });
    expect(report.quiesced).toBe(false);
    expect(report.unconfirmedTerminations).toEqual([
      expect.objectContaining({ buildId: 'b_old', source: 'disk-reconcile', note: '锚点根存活未确认' }),
    ]);
  });

  it('持久对账不可得（unavailable）或扫描整体失败（null）→ fail-closed 未收口', () => {
    const unavailable = resolveKbShutdownQuiescence({
      ...base, memoryFacts: [], diskOutcomes: [{ buildId: 'b_x', outcome: 'unavailable', note: '对账失败：EACCES' }],
    });
    expect(unavailable.quiesced).toBe(false);
    expect(unavailable.unconfirmedTerminations[0]?.source).toBe('scan-unavailable');

    const scanFailed = resolveKbShutdownQuiescence({
      ...base,
      memoryFacts: [{ buildId: 'b1', hasLeader: true, terminationState: 'unconfirmed' }],
      diskOutcomes: null,
    });
    expect(scanFailed.quiesced).toBe(false);
    expect(scanFailed.unconfirmedTerminations[0]?.note).toContain('扫描整体不可得');
  });

  it('无 Leader 的构建（排队/早期失败，无 OS 写者）不参与收口判定', () => {
    const report = resolveKbShutdownQuiescence({
      ...base,
      memoryFacts: [{ buildId: 'b_queued', hasLeader: false, terminationState: null }],
      diskOutcomes: [],
    });
    expect(report.quiesced).toBe(true);
  });
});

describe('KbBuildService.shutdown 持久事实扫描（真实磁盘）', () => {
  const roots: string[] = [];
  const mkRoot = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-shutdown-'));
    roots.push(root);
    return root;
  };
  afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

  const makeService = (dataRoot: string) =>
    new KbBuildService({ dataRoot } as ConstructorParameters<typeof KbBuildService>[0]);
  const storeStub = { updateKbBuild: () => undefined, getKbBuild: () => null } as never;

  it('并发shutdown共享收口内核，第一同步步已封闭新准入', async () => {
    const service = makeService(mkRoot());
    const scanner = service as unknown as { scanDiskResidualFacts: () => Promise<[]> };
    const scan = vi.spyOn(scanner, 'scanDiskResidualFacts').mockResolvedValue([]);
    const first = service.shutdown(storeStub);
    const second = service.shutdown(storeStub);
    await expect(service.createBuild(storeStub, { mode: 'full' })).rejects.toMatchObject({ code: 'kb_shutdown_in_progress' });
    const [a, b] = await Promise.all([first, second]);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(a.quiesced).toBe(true);
  });

  it('账本 degraded（旧事实不可读）→ fail-closed unconfirmed，quiesced=false', async () => {
    const root = mkRoot();
    const buildRoot = path.join(root, 'agent', 'builds', 'b_degraded');
    fs.mkdirSync(path.join(buildRoot, 'epochs'), { recursive: true });
    fs.writeFileSync(path.join(buildRoot, 'process-ledger.json'), '{ 不是 JSON');
    const report = await makeService(root).shutdown(storeStub, { timeoutMs: 1_000 });
    expect(report.quiesced).toBe(false);
    expect(report.unconfirmedTerminations).toEqual([
      expect.objectContaining({ buildId: 'b_degraded', source: 'disk-reconcile' }),
    ]);
  }, 30_000);

  it('账本JSON可读但条目字段不完整，也必须degraded而不是当无旧运行', async () => {
    const root = mkRoot();
    const buildRoot = path.join(root, 'agent', 'builds', 'b_bad_schema');
    fs.mkdirSync(buildRoot, { recursive: true });
    fs.writeFileSync(path.join(buildRoot, 'process-ledger.json'), JSON.stringify({ version: 1, entries: [{ launchId: 'x', pid: process.pid }] }));
    const report = await makeService(root).shutdown(storeStub, { timeoutMs: 1_000 });
    expect(report.quiesced).toBe(false);
    expect(report.unconfirmedTerminations[0]?.note).toContain('degraded');
  });

  it('空数据根（无任何构建事实）→ quiesced=true，清理允许', async () => {
    const root = mkRoot();
    const report = await makeService(root).shutdown(storeStub, { timeoutMs: 1_000 });
    expect(report.quiesced).toBe(true);
    expect(report.unsettled).toEqual([]);
    expect(report.unconfirmedTerminations).toEqual([]);
  }, 30_000);

  it('内存已空但构建根无法枚举，也不得假称quiesced', async () => {
    const root = mkRoot();
    fs.mkdirSync(path.join(root, 'agent'));
    fs.writeFileSync(path.join(root, 'agent', 'builds'), '占位导致ENOTDIR');
    const report = await makeService(root).shutdown(storeStub, { timeoutMs: 1_000 });
    expect(report.quiesced).toBe(false);
    expect(report.unconfirmedTerminations).toContainEqual(expect.objectContaining({ buildId: '*', source: 'scan-unavailable' }));
  });

  it('无进程事实的锚点构建目录（个体均已退出）→ 磁盘对账 confirmed，quiesced=true', async () => {
    const root = mkRoot();
    const home = path.join(root, 'agent', 'builds', 'b_dead', 'epochs', 'e1', 'home', 'amagi', 'data', 'process-audits', 'owned');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'launch-anchor.json'), JSON.stringify({
      version: 1,
      taskId: 't_dead',
      runs: [{ backendRunId: 'r1', rootPid: 999_999, pgid: 999_999, rootIdentityToken: 'darwin:boot:1', leaderPid: 999_999, at: Date.now() }],
    }));
    const report = await makeService(root).shutdown(storeStub, { timeoutMs: 1_000 });
    expect(report.quiesced).toBe(true); // pid 999999 不存活 → 个体 exited，无活写者
  }, 30_000);
});
