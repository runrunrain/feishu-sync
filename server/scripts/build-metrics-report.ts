#!/usr/bin/env node
/**
 * build-metrics-report.ts — pi-amagi 构建度量只读报告（WP-F / kb-build-speedup）
 *
 * 读取 kb_builds（sqlite readonly）与构建权威落盘记录（staging build-actors
 * 账本、各 epoch 的 amagi dispatch journal / dispatch-rejections.jsonl），
 * 复用生产端同一聚合函数（kb-build-service.collectLeaderOrchestrationMetricsFromDisk
 * → build-metrics.aggregateLeaderOrchestrationMetrics），打印人读摘要。
 *
 * 只读：不写任何文件、不回填旧构建、不解析模型会话 JSONL。
 *
 * 用法：
 *   npx tsx scripts/build-metrics-report.ts <buildId> [--home <FEISHU_SYNC_HOME>]
 * 退出码：0=报告输出（允许存在数据缺口）；1=用法错误或构建不存在。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectLeaderOrchestrationMetricsFromDisk } from '../src/kb/kb-build-service.js';

interface CliArgs {
  buildId: string;
  home: string;
}

function parseArgs(argv: string[]): CliArgs | null {
  const positional: string[] = [];
  let home: string | undefined;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--home') {
      home = argv[index + 1];
      index += 1;
    } else if (arg && !arg.startsWith('--')) {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) return null;
  return { buildId: positional[0], home: home ?? process.env.FEISHU_SYNC_HOME ?? path.join(os.homedir(), '.feishu-sync') };
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value * 1000) / 10}%`;
}

function main(): number {
  const args = parseArgs(process.argv);
  if (!args) {
    console.error('用法：npx tsx scripts/build-metrics-report.ts <buildId> [--home <FEISHU_SYNC_HOME>]');
    return 1;
  }
  const dbPath = path.join(args.home, 'feishu-sync.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`数据库不存在：${dbPath}`);
    return 1;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT * FROM kb_builds WHERE id = ?').get(args.buildId) as Record<string, unknown> | undefined;
    if (!row) {
      console.error(`构建不存在：${args.buildId}`);
      return 1;
    }
    // 输出根：config.json 的 standardKb.outputRoot；缺省回退 <home>/standard-kb。
    let outputRoot = path.join(args.home, 'standard-kb');
    try {
      const configPath = path.join(args.home, 'config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
          standardKb?: { outputRoot?: string };
        };
        if (config.standardKb?.outputRoot) outputRoot = config.standardKb.outputRoot;
      }
    } catch {
      /* config 不可读时用缺省输出根 */
    }

    console.log(`构建 ${args.buildId}`);
    console.log(`  状态            ${String(row.status)}（${String(row.orchestration_mode ?? 'legacy')}）`);
    console.log(`  时间            ${String(row.started_at ?? '—')} → ${String(row.finished_at ?? '—（未收口）')}`);
    console.log(`  源/产出         sources=${Number(row.source_total ?? 0)}，docs_written=${Number(row.docs_written ?? 0)}，docs_deleted=${Number(row.docs_deleted ?? 0)}`);
    if (row.error_code) console.log(`  错误            ${String(row.error_code)}: ${String(row.error_message ?? '').slice(0, 160)}`);

    const metricsRaw = typeof row.metrics_json === 'string' && row.metrics_json ? row.metrics_json : null;
    let stored: { orchestration?: Record<string, unknown> } | null = null;
    if (metricsRaw) {
      try { stored = JSON.parse(metricsRaw) as { orchestration?: Record<string, unknown> }; } catch { stored = null; }
    }
    console.log(`  metrics_json    ${metricsRaw ? (stored?.orchestration ? '已含 orchestration 段' : '无 orchestration 段（旧采集或非 pi-amagi）') : '空'}`);

    console.log('');
    console.log('—— 现场重算（权威落盘记录，与终态写入同函数）——');
    const metrics = collectLeaderOrchestrationMetricsFromDisk({
      buildId: args.buildId,
      row,
      outputRoot,
      dataRoot: args.home,
    });
    if (!metrics) {
      console.log('  无可用来源：build-actors 账本与 epoch 记录均缺失（构建未跑编排流水或现场已清理）');
      return 0;
    }
    console.log(`  墙钟 wallClockMs          ${fmtMs(metrics.wallClockMs)}（${metrics.wallClockMs} ms）`);
    console.log(`  产出/工作集               docs=${metrics.docsPublished} / sources=${metrics.sourcesTotal}`);
    console.log(`  派发（含 resume 身份）    作者(luban)=${metrics.authorDispatches ?? '不可得'}，审查(diting)=${metrics.reviewDispatches ?? '不可得'}，调研(baize)=${metrics.researchDispatches ?? '不可得'}`);
    if (metrics.revisionRounds) {
      const rounds = metrics.revisionRounds;
      console.log(`  审查轮数                  文档=${rounds.docsReviewed}，回执=${rounds.totalReviews}，每篇中位数=${rounds.roundsMedian ?? '—'}，最大=${rounds.roundsMax ?? '—'}`);
      const fv = rounds.firstVerdicts;
      console.log(`  首审结论                  pass=${fv.pass} / needs_revision=${fv.needs_revision} / insufficient=${fv.insufficient_material} / fail=${fv.fail} → 首审通过率 ${pct(rounds.firstPassRate)}`);
    } else {
      console.log('  审查轮数                  不可得（reviews.json 缺失/损坏，见口径说明）');
      console.log('  首审结论                  不可得（同上）');
    }
    if (metrics.publishRejections === null) {
      console.log('  发布拒绝                  不可得（publish-requests.json 缺失/损坏，见口径说明）');
    } else {
      const rejections = Object.entries(metrics.publishRejections);
      console.log(`  发布拒绝                  ${rejections.length > 0 ? rejections.map(([code, count]) => `${code}×${count}`).join(', ') : '无'}`);
    }
    if (!metrics.dispatchRejections) {
      console.log('  派发拒绝                  不可得（dispatch-rejections.jsonl 缺失/损坏；WP-F 之前的构建无此审计文件）');
    } else {
      const dispatchRejections = Object.entries(metrics.dispatchRejections);
      console.log(`  派发拒绝                  ${dispatchRejections.length > 0 ? dispatchRejections.map(([code, count]) => `${code}×${count}`).join(', ') : '无'}`);
    }
    console.log(`  模型池运行并发            peak=${metrics.pool.peakInflight ?? '—'}，avg=${metrics.pool.avgInflight ?? '—'}（口径：${metrics.pool.derivation}）`);
    if (metrics.pool.submittedPeakInflight !== undefined || metrics.pool.submittedAvgInflight !== undefined) {
      console.log(`  派发在途（含排队）        peak=${metrics.pool.submittedPeakInflight ?? '—'}，avg=${metrics.pool.submittedAvgInflight ?? '—'}`);
    } else {
      console.log('  派发在途（含排队）        —（无 journal，未推导）');
    }
    if (metrics.firstDraftToPublish) {
      const draft = metrics.firstDraftToPublish;
      console.log(`  首稿→发布                 ${draft.count} 篇，p50=${draft.count > 0 ? fmtMs(draft.p50Ms) : '—'}，p90=${draft.count > 0 ? fmtMs(draft.p90Ms) : '—'}，max=${draft.count > 0 ? fmtMs(draft.maxMs) : '—'}`);
    } else {
      console.log('  首稿→发布                 —（未到达发布或 receipts.json 不可得，见口径说明）');
    }
    if (metrics.notes && metrics.notes.length > 0) {
      console.log('  口径说明');
      for (const note of metrics.notes) console.log(`    - ${note}`);
    }
    console.log('');
    console.log('—— 来源 ——');
    console.log(`  kb_builds        ${dbPath}`);
    console.log(`  build-actors     ${path.join(outputRoot, '.staging', args.buildId, 'build-actors')}`);
    console.log(`  epochs           ${path.join(args.home, 'agent', 'builds', args.buildId, 'epochs')}`);
    return 0;
  } finally {
    db.close();
  }
}

process.exit(main());
