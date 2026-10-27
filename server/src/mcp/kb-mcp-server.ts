/**
 * kb-mcp-server — 对外只读 MCP（设计 §10）
 *
 * stdio MCP server，单文件打包（esbuild → server/dist/mcp/kb-mcp.cjs，
 * 无原生依赖、不打开 SQLite、不访问网络、不写任何文件）。只读取已发布
 * manifest 与 Markdown。搜索与 kb_search 工具共用同一纯函数模块
 * （kb-search），保证 UI、Agent、MCP 结果一致。
 *
 * 启动：`kb-mcp.cjs --kb-root <outputRoot>`；缺省读取
 * FEISHU_SYNC_HOME/config.json 的 standardKb.outputRoot（只读）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { StandardKbStore } from '../kb/standard-kb-store.js';
import { searchDocs } from '../kb/kb-search.js';

function resolveKbRootFromArgs(argv: string[]): string | null {
  const index = argv.indexOf('--kb-root');
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  // FEISHU_SYNC_HOME 下 config.json 的 standardKb.outputRoot（只读）
  const dataRoot = process.env.FEISHU_SYNC_HOME?.trim()
    || path.join(os.homedir(), '.feishu-sync');
  const configPath = path.join(dataRoot, 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      standardKb?: { outputRoot?: string };
    };
    return config.standardKb?.outputRoot ?? null;
  } catch {
    return null;
  }
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(code: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: `${code}: ${message}` }],
    isError: true,
  };
}

async function main(): Promise<void> {
  const kbRoot = resolveKbRootFromArgs(process.argv.slice(2));
  const store = kbRoot ? new StandardKbStore(kbRoot) : null;

  const server = new Server(
    { name: 'feishu-kb', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search_knowledge',
        description: '在已发布标准知识库中搜索文档（大小写不敏感子串，标题/章节加权）',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
          },
          required: ['query'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'get_knowledge',
        description: '按 docId 或路径读取标准知识库文档正文（Markdown）与来源元数据',
        inputSchema: {
          type: 'object',
          properties: {
            docId: { type: 'string' },
            path: { type: 'string' },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'list_knowledge',
        description: '列出标准知识库文档清单（docId、path、title、summary），可按路径前缀过滤',
        inputSchema: {
          type: 'object',
          properties: {
            prefix: { type: 'string', description: '路径前缀过滤' },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'get_release_info',
        description: '当前发布信息（releaseId、发布时间、文档数、模型）',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (!store) {
      return errorResult('kb_not_configured', '未配置 --kb-root，且 config.json 无 standardKb.outputRoot');
    }
    // 每次调用重新读取 CURRENT.json（mtime 缓存在 store 内），保证发布后
    // 即时可见、发布中不读到半成品。
    const manifest = store.readManifest();
    switch (name) {
      case 'search_knowledge': {
        if (!manifest) return errorResult('kb_not_published', '标准知识库尚未发布');
        const query = typeof args.query === 'string' ? args.query : '';
        if (!query.trim()) return errorResult('invalid_request', 'query 不能为空');
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(20, Math.floor(args.limit))) : 20;
        const hits = store.search(manifest, query, limit);
        return textResult(JSON.stringify({ releaseId: manifest.releaseId, results: hits }, null, 2));
      }
      case 'get_knowledge': {
        if (!manifest) return errorResult('kb_not_published', '标准知识库尚未发布');
        const doc = store.findDoc(manifest, {
          docId: typeof args.docId === 'string' ? args.docId : undefined,
          path: typeof args.path === 'string' ? args.path : undefined,
        });
        if (!doc) return errorResult('kb_doc_not_found', `文档不存在: ${String(args.docId ?? args.path ?? '')}`);
        const loaded = store.readReleaseDoc(manifest.releaseId, doc);
        return textResult(JSON.stringify({
          docId: doc.docId,
          path: doc.path,
          title: doc.title,
          summary: doc.summary,
          tags: doc.tags,
          sources: doc.sources.map((objToken) => {
            const snapshotEntry = manifest.sourceSnapshot.find((candidate) => candidate.objToken === objToken);
            return {
              objToken,
              title: snapshotEntry?.title ?? objToken,
              relPath: snapshotEntry?.relPath ?? '',
            };
          }),
          markdown: loaded.markdown,
        }, null, 2));
      }
      case 'list_knowledge': {
        if (!manifest) return errorResult('kb_not_published', '标准知识库尚未发布');
        const prefix = typeof args.prefix === 'string' ? args.prefix : '';
        const docs = manifest.docs
          .filter((doc) => !prefix || doc.path.startsWith(prefix))
          .map((doc) => ({ docId: doc.docId, path: doc.path, title: doc.title, summary: doc.summary }));
        return textResult(JSON.stringify({ releaseId: manifest.releaseId, docs }, null, 2));
      }
      case 'get_release_info': {
        const current = store.readCurrent();
        if (!current || !manifest) return errorResult('kb_not_published', '标准知识库尚未发布');
        return textResult(JSON.stringify({
          releaseId: manifest.releaseId,
          publishedAt: manifest.publishedAt,
          docCount: manifest.docs.length,
          sourceCount: manifest.sourceSnapshot.length,
          model: manifest.model,
          buildId: manifest.buildId,
        }, null, 2));
      }
      default:
        return errorResult('unknown_tool', `未知工具: ${name}`);
    }
  });

  void searchDocs; // 搜索经 store.search → kb-search 纯函数（同一实现）
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr 日志（stdout 保留给 MCP 协议）
  console.error(`[kb-mcp] listening on stdio (kbRoot=${kbRoot ?? '未配置'})`);
}

main().catch((error) => {
  console.error('[kb-mcp] fatal:', error);
  process.exit(1);
});
