/**
 * S13 命令登记端到端：source.* 经 /api/cli/:command 的执行路径 + CLI
 * 子进程真实调用（复用 S8/S9 测试基建：真实 startServer 随机端口 +
 * esbuild 单文件 CLI 产物 + 隔离 FEISHU_SYNC_HOME）。
 *
 * 数据准备：PUT /api/config 指定临时 knowledgeBaseRoot，第二个
 * LocalMapStore 连接向 <home>/feishu-sync.db 写入 docx 行，磁盘放规范
 * feishu_sync 头文件——source.edit 全链（edit-status → edit → revert）
 * 不触达 lark-cli，可完整走通；source.push 在 feishuWrite 默认关闭下
 * 停在 403 feishu_write_disabled（写门语义可达即验收）。
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startServer, type StartedServer } from '../src/index.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';

const exec = promisify(execFile);

const DESKTOP_TOKEN = 'test-desktop-token-s13-0123456789abcdef';
const CLI_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'feishu-sync-cli.cjs');

let server: StartedServer;
let home: string;
let kbRoot: string;
let store: LocalMapStore;
let previousHome: string | undefined;

function isolateHome(): string {
  previousHome = process.env.FEISHU_SYNC_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sync-cli-src-'));
  process.env.FEISHU_SYNC_HOME = dir;
  return dir;
}

const sha = (text: string): string => crypto.createHash('sha256').update(text, 'utf-8').digest('hex');

function yamlHeader(objToken: string): string {
  return [
    '<!--',
    'feishu_sync:',
    `  obj_token: "${objToken}"`,
    `  wiki_node_token: "wikicnS13${objToken}"`,
    `  space_id: "spaceS13"`,
    '  obj_type: "docx"',
    `  original_link: "https://x.feishu.cn/wiki/wikicnS13${objToken}"`,
    '  fetch_date: "2026-10-27T00:00:00.000Z"',
    '  last_synced_modify_time: "2026-10-27T00:00:00.000Z"',
    '-->',
    '',
    '',
  ].join('\n');
}

/** 造一篇可编辑 docx：磁盘文件 + documents 行 + synced 基线。 */
function seedDocx(objToken: string, body: string): { absPath: string } {
  const relPath = `策划/S13-${objToken}.md`;
  const absPath = path.join(kbRoot, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, yamlHeader(objToken) + body);
  store.upsertDocument({
    objToken,
    wikiNodeToken: `wikicnS13${objToken}`,
    objType: 'docx',
    title: `S13 测试文档 ${objToken}`,
    localMdPath: absPath,
    lastSyncedModifyTime: '2026-10-27T00:00:00.000Z',
    lastSyncedAt: '2026-10-27T00:00:00.000Z',
    status: 'synced',
    localRelPath: relPath,
  } as never);
  store.markDocumentSynced({
    objToken,
    syncedObjEditTime: 1759000000,
    localMdPath: absPath,
    lastSyncedModifyTime: '2026-10-27T00:00:00.000Z',
    lastSyncedAt: '2026-10-27T00:00:00.000Z',
  });
  return { absPath };
}

async function api(
  method: 'GET' | 'POST' | 'PUT',
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${server.url}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': DESKTOP_TOKEN, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

/** CLI 令牌域调用 POST /api/cli/:command。 */
async function cliCommand(
  command: string,
  args: Record<string, unknown>,
  extraBody: Record<string, unknown> = {},
): Promise<{ status: number; json: any }> {
  const endpoint = JSON.parse(fs.readFileSync(path.join(home, 'run', 'endpoint.json'), 'utf-8'));
  const response = await fetch(`${server.url}/api/cli/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cli-Token': endpoint.cliToken },
    body: JSON.stringify({ args, ...extraBody }),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

interface CliRun { code: number; stdout: string; stderr: string }

async function cli(args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_SCRIPT, '--home', home, ...args], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

const BODY_A = '# S13 文档\n\n正文第一段，包含可编辑锚点 ALPHA。\n';
const BODY_B = '# S13 文档\n\n正文第一段，包含可编辑锚点 ALPHA。\n\n追加的第二段（CLI 写入）。\n';

beforeAll(async () => {
  home = isolateHome();
  // 始终重新打包：命令表/位置参数映射可能在本切片更新，复用旧产物会
  // 漏掉新登记的 source.* 命令（existsSync 短路仅适用于冻结命令面的套件）。
  const { bundleCli } = await import('../scripts/lib/cli-bundle.mjs');
  await bundleCli();
  server = await startServer({
    desktopMode: true,
    desktopToken: DESKTOP_TOKEN,
    configPath: path.join(home, 'config.json'),
    port: 0,
    hostname: '127.0.0.1',
  });
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's13-kb-'));
  const configured = await api('PUT', '/api/config', { knowledgeBaseRoot: kbRoot });
  expect(configured.status).toBe(200);
  // 第二连接写 documents 行（server 已建库；additive 迁移幂等）。
  store = new LocalMapStore(path.join(home, 'feishu-sync.db'));
  store.initialize();
  // 开启命令行访问 → 发布 endpoint.json
  const enabled = await api('POST', '/api/cli/enable', { enabled: true });
  expect(enabled.status).toBe(200);
}, 240_000);

afterAll(async () => {
  await server.close().catch(() => undefined);
  store?.close?.();
  if (previousHome === undefined) delete process.env.FEISHU_SYNC_HOME;
  else process.env.FEISHU_SYNC_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
  if (kbRoot) fs.rmSync(kbRoot, { recursive: true, force: true });
}, 120_000);

// ---------------------------------------------------------------------------
// /api/cli/:command 执行路径（S8 模式）
// ---------------------------------------------------------------------------

describe('source.* 经 /api/cli/:command 执行', () => {
  const TOKEN = 'doxcnS13Api001';

  it('前置：seed 文档就绪', () => {
    const { absPath } = seedDocx(TOKEN, BODY_A);
    expect(fs.existsSync(absPath)).toBe(true);
  });

  it('source.edit-status：返回 bodyHash 与 editState=null', async () => {
    const result = await cliCommand('source.edit-status', { objToken: TOKEN });
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    expect(result.json.data.bodyHash).toBe(sha(BODY_A));
    expect(result.json.data.editState).toBeNull();
    expect(result.json.data.relPath).toContain(TOKEN);
  });

  it('source.edit 无 confirm → 422 confirmation_required（不触达编辑）', async () => {
    const result = await cliCommand('source.edit', { objToken: TOKEN, baseHash: sha(BODY_A), newText: BODY_B });
    expect(result.status).toBe(422);
    expect(result.json.error.code).toBe('confirmation_required');
    expect(result.json.error.details).toEqual({ field: 'confirm', value: 'EDIT' });
  });

  it('source.edit 带 confirm → 落盘 dirty（header 字节不变）', async () => {
    const result = await cliCommand(
      'source.edit',
      { objToken: TOKEN, baseHash: sha(BODY_A), newText: BODY_B },
      { confirm: 'EDIT' },
    );
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    expect(result.json.data.state.state).toBe('dirty');
    expect(result.json.data.state.editCount).toBe(1);

    const onDisk = fs.readFileSync(path.join(kbRoot, '策划', `S13-${TOKEN}.md`), 'utf-8');
    expect(onDisk.startsWith(yamlHeader(TOKEN))).toBe(true);
    expect(onDisk).toBe(yamlHeader(TOKEN) + BODY_B);
  });

  it('source.edit baseHash 过期 → 409 source_edit_conflict 透传', async () => {
    const result = await cliCommand(
      'source.edit',
      { objToken: TOKEN, baseHash: sha(BODY_A), newText: BODY_A },
      { confirm: 'EDIT' },
    );
    expect(result.status).toBe(409);
    expect(result.json.error.code).toBe('source_edit_conflict');
    // 注：/api/cli 单步错误包络只透传 code/message/httpStatus，不含上游
    // details（currentBodyHash 需另走 source.edit-status 查询）。
    const after = await cliCommand('source.edit-status', { objToken: TOKEN });
    expect(after.json.data.bodyHash).toBe(sha(BODY_B));
  });

  it('source.push-preview：dirty 行 + feishuWrite 关闭 → blocked write_disabled', async () => {
    const result = await cliCommand('source.push-preview', { objToken: TOKEN });
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    expect(result.json.data.mode).toBe('blocked');
    expect(result.json.data.blockedReason).toBe('write_disabled');
  });

  it('source.push 无 confirm → 422；带 PUSH → 403 feishu_write_disabled（写门可达）', async () => {
    const gate = await cliCommand('source.push', { objToken: TOKEN });
    expect(gate.status).toBe(422);
    expect(gate.json.error.code).toBe('confirmation_required');
    expect(gate.json.error.details).toEqual({ field: 'confirm', value: 'PUSH' });

    const pushed = await cliCommand('source.push', { objToken: TOKEN }, { confirm: 'PUSH' });
    expect(pushed.status).toBe(403);
    expect(pushed.json.ok).toBe(false);
    expect(pushed.json.error.code).toBe('feishu_write_disabled');
  });

  it('source.push --allow-overwrite 语义：请求体 confirm 升级 OVERWRITE_CLOUD', async () => {
    // 走 403 写门即证明派生请求体通过了路由 confirm 校验（OVERWRITE_CLOUD
    // 分支若校验失败会是 400 confirmation_required）。
    const result = await cliCommand('source.push', { objToken: TOKEN, allowOverwrite: true }, { confirm: 'PUSH' });
    expect(result.status).toBe(403);
    expect(result.json.error.code).toBe('feishu_write_disabled');
  });

  it('source.revert 无 confirm → 422；带 REVERT → 恢复正文并清 dirty', async () => {
    const gate = await cliCommand('source.revert', { objToken: TOKEN });
    expect(gate.status).toBe(422);
    expect(gate.json.error.details).toEqual({ field: 'confirm', value: 'REVERT' });

    const result = await cliCommand('source.revert', { objToken: TOKEN }, { confirm: 'REVERT' });
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);

    const onDisk = fs.readFileSync(path.join(kbRoot, '策划', `S13-${TOKEN}.md`), 'utf-8');
    expect(onDisk).toBe(yamlHeader(TOKEN) + BODY_A);
    const status = await cliCommand('source.edit-status', { objToken: TOKEN });
    expect(status.json.data.editState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLI 子进程端到端（S9 基建）
// ---------------------------------------------------------------------------

describe('CLI 子进程：source edit / push', () => {
  const TOKEN = 'doxcnS13E2E002';

  it('source edit <token> --new-text --base-hash --yes → 退出码 0 且落盘', async () => {
    seedDocx(TOKEN, BODY_A);

    const status = await cli(['--json', 'source', 'edit-status', TOKEN]);
    expect(status.code).toBe(0);
    const baseHash = JSON.parse(status.stdout).data.bodyHash;
    expect(baseHash).toBe(sha(BODY_A));

    const edited = await cli(['--json', 'source', 'edit', TOKEN, '--base-hash', baseHash, '--new-text', BODY_B, '--yes']);
    expect(edited.code).toBe(0);
    const envelope = JSON.parse(edited.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.state.state).toBe('dirty');

    const onDisk = fs.readFileSync(path.join(kbRoot, '策划', `S13-${TOKEN}.md`), 'utf-8');
    expect(onDisk).toBe(yamlHeader(TOKEN) + BODY_B);
  }, 60_000);

  it('source edit 无 --yes → 退出码 4（本地 confirm 预检）', async () => {
    const run = await cli(['--json', 'source', 'edit', TOKEN, '--base-hash', sha(BODY_B), '--new-text', BODY_A]);
    expect(run.code).toBe(4);
    expect(JSON.parse(run.stdout).error.code).toBe('confirmation_required');
  }, 60_000);

  it('source push <token>：无 --yes → 4；--yes → 业务错误 1（feishu_write_disabled）', async () => {
    const unconfirmed = await cli(['--json', 'source', 'push', TOKEN]);
    expect(unconfirmed.code).toBe(4);
    expect(JSON.parse(unconfirmed.stdout).error.code).toBe('confirmation_required');

    const pushed = await cli(['--json', 'source', 'push', TOKEN, '--yes']);
    expect(pushed.code).toBe(1);
    const envelope = JSON.parse(pushed.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('feishu_write_disabled');
  }, 60_000);

  it('source revert <token> --yes → 退出码 0 且正文还原', async () => {
    const run = await cli(['--json', 'source', 'revert', TOKEN, '--yes']);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).ok).toBe(true);
    const onDisk = fs.readFileSync(path.join(kbRoot, '策划', `S13-${TOKEN}.md`), 'utf-8');
    expect(onDisk).toBe(yamlHeader(TOKEN) + BODY_A);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T3b-02：CLI 令牌不能自行开启 feishuWrite（命令表禁止路径 + 消费者丢弃）
// ---------------------------------------------------------------------------

describe('CLI 令牌 vs feishuWrite 开关（T3b-02）', () => {
  it('CLI config.set feishuWrite → 400 forbidden_path，不触达 PUT', async () => {
    const result = await cliCommand('config.set', { path: 'feishuWrite', value: { enabled: true } });
    expect(result.status).toBe(400);
    expect(result.json.error.code).toBe('forbidden_path');
    expect(result.json.error.message).toContain('feishuWrite');
    // 开关保持关闭
    const config = await api('GET', '/api/config');
    expect(config.json.feishuWrite?.enabled ?? false).toBe(false);
  });

  it('内部转发携带 actor=cli：PUT /api/config 的 feishuWrite 被丢弃（其余字段生效）', async () => {
    // 直接验证消费者侧兑底：CLI actor 标记的 PUT 不改 feishuWrite
    const result = await api('PUT', '/api/config', {
      feishuWrite: { enabled: true },
      pollIntervalMinutes: 77,
    }, { 'X-Feishu-Sync-Actor': 'cli' });
    expect(result.status).toBe(200);
    expect(result.json.config.feishuWrite?.enabled ?? false).toBe(false);
    expect(result.json.config.pollIntervalMinutes).toBe(77);
  });

  it('desktop 正常修改 feishuWrite 回归（改后立即改回，不影响后续用例）', async () => {
    const enable = await api('PUT', '/api/config', { feishuWrite: { enabled: true } });
    expect(enable.status).toBe(200);
    expect(enable.json.config.feishuWrite.enabled).toBe(true);
    const disable = await api('PUT', '/api/config', { feishuWrite: { enabled: false } });
    expect(disable.status).toBe(200);
    expect(disable.json.config.feishuWrite.enabled).toBe(false);
  });
});
