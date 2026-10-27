/**
 * 真实模型端到端 smoke（可选验证，设计 §15 未知项 + Leader steer #1/#2）
 *
 * 通过显式 pi-agent-dir 模式让 pi 自行使用本机已配置凭据（本脚本不读/
 * 不打印任何 auth/key 文件），对临时无敏感 fixture 做最小真实调用：
 *   1. Discuss 一轮真实问答（含 raw_read 工具往返——验证纯 JSON Schema
 *      工具参数在 pi 1.4 的执行期校验 + GLM openai-completions 工具调用）
 *   2. Work 一次 ws_write（显式授权 Workspace、审计落盘）
 *   3. 最小 KB 构建（2 个 fixture 源 → 发布 → CURRENT 指针）
 *
 * 运行（启动器必须把 FEISHU_SYNC_HOME 指向临时目录——server 模块在
 * import 时绑定 config 路径，绝不触碰真实 ~/.feishu-sync）：
 *   FEISHU_SYNC_HOME=$(mktemp -d) npx tsx scripts/agent-real-model-smoke.ts
 * 退出码 0 = 全部通过；2 = 无可用模型（如实退出）；1 = 失败。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const MODEL = process.env.FEISHU_PI_SMOKE_MODEL || 'amagi-glm/glm-5.3-flash';

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.info(`[${ok ? 'PASS' : 'FAIL'}] ${name}: ${detail}`);
}

async function main(): Promise<number> {
  const smokeHome = process.env.FEISHU_SYNC_HOME;
  const realHome = path.join(os.homedir(), '.feishu-sync');
  if (!smokeHome || path.resolve(smokeHome) === path.resolve(realHome)) {
    console.error(`[smoke] 拒绝运行：FEISHU_SYNC_HOME 必须指向临时目录而非真实数据根（当前：${smokeHome ?? '未设置'}）`);
    return 1;
  }
  // dataRoot = FEISHU_SYNC_HOME（启动器给的临时目录）：config/DB/agent
  // 目录全部落在里面，server 的 ConfigManager/LocalMapStore 与本脚本共享。
  const dataRoot = smokeHome;
  const kbRoot = path.join(dataRoot, 'raw-kb');
  const outputRoot = path.join(dataRoot, 'standard-kb');
  // workspace 必须在 dataRoot 之外（validateWorkspacePath 拒绝与数据根重叠）
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-smoke-ws-'));
  fs.mkdirSync(kbRoot, { recursive: true });

  // fixture：2 个临时源（无敏感内容）
  fs.mkdirSync(path.join(kbRoot, '战斗'), { recursive: true });
  fs.writeFileSync(path.join(kbRoot, '战斗', '结算.md'), [
    '<!--',
    'feishu_sync:',
    '  obj_token: tok_smoke_1',
    '  obj_type: docx',
    '-->',
    '# 战斗结算',
    '',
    '结算顺序：先结算格挡，再结算减伤，最后结算暴击。',
    '伤害公式：最终伤害 = 攻击力 × (1 - 减伤率) × 暴击倍率。',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(kbRoot, '战斗', '行动.md'), [
    '<!--',
    'feishu_sync:',
    '  obj_token: tok_smoke_2',
    '  obj_type: docx',
    '-->',
    '# 行动规则',
    '',
    '每回合双方各行动一次，速度高者先手。技能消耗怒气。',
    '',
  ].join('\n'));

  // 动态 import（data-root 已由外层环境变量控制）
  const { startServer } = await import('../src/index.js');
  const { LocalMapStore } = await import('../src/modules/local-map-store.js');

  const store = new LocalMapStore(path.join(dataRoot, 'feishu-sync.db'));
  store.initialize();
  const now = new Date().toISOString();
  for (const [token, rel] of [['tok_smoke_1', '战斗/结算.md'], ['tok_smoke_2', '战斗/行动.md']] as const) {
    store.upsertDocument({
      objToken: token,
      wikiNodeToken: null,
      objType: 'docx',
      title: rel.endsWith('结算.md') ? '战斗结算' : '行动规则',
      localMdPath: path.join(kbRoot, rel),
      lastSyncedModifyTime: now,
      lastSyncedAt: now,
      status: 'synced',
      localRelPath: rel,
      syncState: 'synced',
      syncedObjEditTime: 1,
      observedObjEditTime: 1,
    } as never);
  }

  // 写 config（pi-agent-dir 模式 + 低成本模型）
  const configPath = path.join(smokeHome, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    llm: {
      openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: '', model: 'glm-4-flash', temperature: 0.2,
      primaryChannel: 'direct', fallbackOnFailure: false,
    },
    pollIntervalMinutes: 30,
    knowledgeBaseRoot: kbRoot,
    watchedRoots: [],
    requiredScopes: [],
    enableAutoStart: false,
    enableNotifications: false,
    agent: {
      runtime: {},
      model: { source: 'pi-agent-dir', piModel: MODEL, thinkingLevel: 'off', contextWindow: 128000, maxTokens: 8192 },
      maxConcurrentProcesses: 2,
      idleTimeoutMinutes: 10,
      workspaces: [],
    },
    standardKb: {
      outputRoot, retainReleases: 3, buildBatchSize: 10,
      promptTimeoutMinutes: 5, buildTimeoutMinutes: 10, autoBuildAfterSync: false,
    },
  }));

  const server = await startServer({ desktopMode: true, desktopToken: 'smoke-token', port: 0, hostname: '127.0.0.1' });
  const base = server.url;
  const headers = { 'X-Desktop-Token': 'smoke-token', 'Content-Type': 'application/json' };
  console.info(`[smoke] server at ${base}（model=${MODEL}）`);

  try {
    // ---- 就绪探测（真实 pi probe，不发 prompt）----
    const statusResponse = await fetch(`${base}/api/agent/status`, { headers });
    const status = await statusResponse.json() as { code: string; message: string; model?: { model: string | null; available: string[] } };
    record('agent status', statusResponse.status === 200, `code=${status.code} model=${status.model?.model ?? null} available=${status.model?.available.length ?? 0}`);
    if (status.code !== 'ready' || !status.model?.available?.includes(MODEL)) {
      console.error(`[smoke] 模型不可用（code=${status.code}），如实退出不冒充。message=${status.message}`);
      return 2;
    }

    // ---- 1. Discuss 真实问答 + 工具往返 ----
    const created = await fetch(`${base}/api/agent/sessions`, {
      method: 'POST', headers, body: JSON.stringify({ title: 'smoke-discuss', mode: 'discuss' }),
    });
    const session = await created.json() as { id: string };
    record('create session', created.status === 201, `id=${session.id}`);

    const marker = `SMOKE_DISCUSS_${crypto.randomBytes(3).toString('hex')}`;
    const accepted = await fetch(`${base}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({
        text: `请用 raw_read 工具读取 objToken 为 tok_smoke_1 的文档，然后只回复一行：${marker} 以及文档中伤害公式的原文。不要输出其他内容。`,
      }),
    });
    record('send message accepted', accepted.status === 202, `status=${accepted.status}`);

    // 等待运行结束（SSE 或轮询 session 状态 + messages）
    const deadline = Date.now() + 4 * 60_000;
    let discussOk = false;
    let detail = 'timeout';
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const dto = (await (await fetch(`${base}/api/agent/sessions/${session.id}`, { headers })).json()) as {
        state: string; lastError: { code: string; message: string } | null;
      };
      if (dto.state === 'error') { detail = `error: ${dto.lastError?.code} ${dto.lastError?.message?.slice(0, 200)}`; break; }
      if (dto.state === 'idle') {
        const messages = (await (await fetch(`${base}/api/agent/sessions/${session.id}/messages`, { headers })).json()) as {
          messages: Array<{ role: string; text?: string; tool?: { name: string; isError: boolean } }>;
        };
        const toolCalls = messages.messages.filter((message) => message.role === 'tool');
        const assistant = messages.messages.filter((message) => message.role === 'assistant');
        const hasMarker = assistant.some((message) => (message.text ?? '').includes(marker));
        // 工具往返必须真正成功：raw_read 结果非 error，且助手复述了文档
        // 独有的公式内容（marker 只证明回复，不证明读到了内容）
        const rawReadOk = toolCalls.some((message) => message.tool?.name === 'raw_read' && !message.tool?.isError);
        const formulaEchoed = assistant.some((message) => (message.text ?? '').includes('攻击力'));
        discussOk = hasMarker && rawReadOk && formulaEchoed;
        detail = `assistant=${assistant.length} toolResults=${toolCalls.length} rawReadOk=${rawReadOk} formula=${formulaEchoed} marker=${hasMarker}`;
        break;
      }
    }
    record('discuss roundtrip (real model + raw_read tool)', discussOk, detail);

    // ---- 2. Work 一次 ws_write ----
    const wsCreated = await fetch(`${base}/api/agent/workspaces`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'smoke-ws', path: workspace }),
    });
    const ws = await wsCreated.json() as { id?: string; error?: string };
    record('register workspace', wsCreated.status === 201, `id=${ws.id ?? ws.error}`);
    const switched = await fetch(`${base}/api/agent/sessions/${session.id}/mode`, {
      method: 'POST', headers,
      body: JSON.stringify({ mode: 'work', workspaceId: ws.id, confirm: 'WORK' }),
    });
    record('switch to work', switched.status === 200, `status=${switched.status}`);

    const fileMarker = `ws_write_${crypto.randomBytes(3).toString('hex')}.md`;
    await fetch(`${base}/api/agent/sessions/${session.id}/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({
        text: `请用 ws_write 工具在 Workspace 根目录创建文件 ${fileMarker}，内容为一行：real-work-ok。完成后只回复 WORK_DONE。`,
      }),
    });
    const wsDeadline = Date.now() + 4 * 60_000;
    let workOk = false;
    let workDetail = 'timeout';
    while (Date.now() < wsDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const dto = (await (await fetch(`${base}/api/agent/sessions/${session.id}`, { headers })).json()) as {
        state: string; lastError: { code: string; message: string } | null;
      };
      if (dto.state === 'error') { workDetail = `error: ${dto.lastError?.code}`; break; }
      if (dto.state === 'idle') {
        const written = fs.existsSync(path.join(workspace, fileMarker))
          && fs.readFileSync(path.join(workspace, fileMarker), 'utf-8').includes('real-work-ok');
        const auditPath = path.join(dataRoot, 'agent', 'audit', `${session.id}.jsonl`);
        const auditOk = fs.existsSync(auditPath) && fs.readFileSync(auditPath, 'utf-8').includes('"tool":"ws_write"');
        workOk = written && auditOk;
        workDetail = `file=${written} audit=${auditOk}`;
        break;
      }
    }
    record('work ws_write (real)', workOk, workDetail);

    // ---- 3. 最小 KB 构建 ----
    const buildStarted = await fetch(`${base}/api/kb/builds`, {
      method: 'POST', headers, body: JSON.stringify({ mode: 'full', confirm: 'BUILD' }),
    });
    const build = await buildStarted.json() as { id?: string; error?: string; message?: string };
    record('start build', buildStarted.status === 202, `id=${build.id ?? `${build.error}:${build.message}`}`);
    if (build.id) {
      const buildDeadline = Date.now() + 8 * 60_000;
      let buildOk = false;
      let buildDetail = 'timeout';
      while (Date.now() < buildDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const dto = (await (await fetch(`${base}/api/kb/builds/${build.id}`, { headers })).json()) as {
          status: string; error?: { code: string; message: string } | null;
          releaseId?: string | null; counts?: { docsWritten: number };
        };
        if (['failed', 'cancelled', 'interrupted'].includes(dto.status)) {
          buildDetail = `${dto.status}: ${dto.error?.code} ${dto.error?.message?.slice(0, 300)}`;
          // 保留诊断证据：事件日志尾部
          try {
            const eventsFile = path.join(outputRoot, '.builds', build.id, 'events.jsonl');
            if (fs.existsSync(eventsFile)) {
              const lines = fs.readFileSync(eventsFile, 'utf-8').trim().split('\n').slice(-25);
              console.info('[smoke] build events 尾部：\n' + lines.join('\n'));
            }
          } catch { /* 证据读取失败不逃逃主结论 */ }
          break;
        }
        if (dto.status === 'published') {
          const pointer = JSON.parse(fs.readFileSync(path.join(outputRoot, 'CURRENT.json'), 'utf-8')) as { releaseId: string };
          const manifest = JSON.parse(fs.readFileSync(path.join(outputRoot, 'releases', pointer.releaseId, 'manifest.json'), 'utf-8')) as {
            docs: Array<{ path: string; sources: string[] }>; sourceSnapshot: unknown[];
          };
          const rawUnchanged = fs.readFileSync(path.join(kbRoot, '战斗', '结算.md'), 'utf-8').includes('伤害公式');
          buildOk = pointer.releaseId === dto.releaseId && manifest.docs.length > 0 && manifest.sourceSnapshot.length === 2 && rawUnchanged;
          buildDetail = `release=${pointer.releaseId} docs=${manifest.docs.length} sources=${manifest.sourceSnapshot.length} rawUnchanged=${rawUnchanged}`;
          break;
        }
      }
      record('kb build publish (real model)', buildOk, buildDetail);
    }

    const failed = results.filter((result) => !result.ok);
    console.info('\n[smoke] 结果汇总：');
    for (const result of results) console.info(`  ${result.ok ? '✓' : '✗'} ${result.name} — ${result.detail}`);
    if (failed.length > 0) {
      console.info(`\n[smoke] 有失败项，保留现场供诊断：${dataRoot}（workspace=${workspace}）`);
      (globalThis as unknown as { __smokeKeep?: boolean }).__smokeKeep = true;
    }
    return failed.length > 0 ? 1 : 0;
  } finally {
    await server.close();
    if (!(globalThis as unknown as { __smokeKeep?: boolean }).__smokeKeep) {
      fs.rmSync(dataRoot, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
}

main().then((code) => {
  process.exit(code);
}).catch((error) => {
  console.error('[smoke] fatal:', error);
  process.exit(1);
});
