/**
 * Unit tests for BitableExporter — 飞书多维表格确定性导出器。
 *
 * 策略（对齐 sync-engine.test.ts / sheet-media.test.ts 的 in-memory mock
 * 模式）：mock LarkCliClient 的 base 面（listBaseTables / listBaseFields /
 * listBaseViews / listBaseRecords / downloadBaseAttachment /
 * listBaseDashboards / listBaseWorkflows / listBaseForms），不依赖真实
 * 认证 / 网络 / better-sqlite3。
 *
 * 覆盖：
 *   - 多表导出 + record-list 翻页（2 页，offset 递增）
 *   - 字段类型渲染矩阵（text/number/single/multi select/date 秒毫秒/
 *     checkbox/user/attachment 成功+失败降级/link 两遍解析/lookup/formula/
 *     location/未知类型 compact JSON）
 *   - md 表格转义（`|` 与换行）
 *   - 字段 schema 小节（select 选项清单 / date 格式 / link 目标表）
 *   - CSV 落盘（原始值；附件列 file_token 列表）
 *   - 响应形状容错（camelCase key / 双层 data 包装 / has_more 缺失）
 *   - base 元数据存档（dashboard/workflow/form 落盘 + 单类失败软降级）
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  BitableExporter,
  type BitableClient,
} from '../src/modules/bitable-exporter.js';

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

// （PageResponse 形状由各用例内联提供，不再需要独立类型。）

interface MockBaseState {
  tables: any[];
  /** tableId → 全量记录（mock 按服务端语义切片：满页返回 + has_more）。 */
  recordsByTable: Map<string, any[]>;
  fieldsByTable?: Map<string, any>;
  viewsByTable?: Map<string, any>;
  attachmentBehavior?: (fileToken: string, outputDir: string) => void;
  /** 下载产物文件名（缺省 '下载产物.bin'；用例可改无扩展名测 ext 派生分支） */
  attachmentSavedName?: string;
  dashboards?: any;
  workflowError?: Error;
  formsByTable?: Map<string, any>;
  recordCalls: Array<{ tableId: string; offset: number; limit: number }>;
  tableCalls: Array<{ offset: number; limit: number }>;
}

function makeClient(state: MockBaseState): BitableClient {
  return {
    async listBaseTables(appToken: string, offset: number, limit: number) {
      void appToken;
      state.tableCalls.push({ offset, limit });
      const page = state.tables.slice(offset, offset + limit);
      return {
        ok: true,
        data: { items: page, has_more: offset + limit < state.tables.length },
      };
    },
    async listBaseFields({ tableId }) {
      const raw = state.fieldsByTable?.get(tableId);
      if (raw) return raw; // 容错形状由用例直接提供
      return { data: { items: [], has_more: false } };
    },
    async listBaseViews({ tableId }) {
      const raw = state.viewsByTable?.get(tableId);
      if (raw) return raw;
      return { data: { views: [], has_more: false } };
    },
    async listBaseRecords({ tableId, offset, limit }) {
      state.recordCalls.push({ tableId, offset, limit });
      const all = state.recordsByTable.get(tableId) ?? [];
      const page = all.slice(offset, offset + limit);
      return {
        ok: true,
        data: { items: page, has_more: offset + limit < all.length },
      };
    },
    async downloadBaseAttachment({ fileToken, outputDir }) {
      const behavior = state.attachmentBehavior;
      if (behavior) {
        behavior(fileToken, outputDir);
        const savedName = state.attachmentSavedName ?? '下载产物.bin';
        return { ok: true, data: { saved_path: path.join(outputDir, savedName) } };
      }
      throw new Error('attachment download unavailable');
    },
    async listBaseDashboards() {
      if (state.dashboards !== undefined) return state.dashboards;
      return { data: { items: [] } };
    },
    async listBaseWorkflows() {
      if (state.workflowError) throw state.workflowError;
      return { data: { items: [] } };
    },
    async listBaseForms({ tableId }) {
      const raw = state.formsByTable?.get(tableId);
      if (raw !== undefined) return raw;
      return { data: { items: [] } };
    },
  };
}

function tmpStaging(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bitable-exporter-test-'));
}

function text(name: string, extra: Record<string, unknown> = {}): any {
  return { field_id: `fld_${name}`, field_name: name, type: 1, ...extra };
}

// ---------------------------------------------------------------------------
// 渲染矩阵 + 翻页 + 附件 + CSV + schema
// ---------------------------------------------------------------------------

describe('BitableExporter.exportBitable — full pipeline', () => {
  function setupMatrixState(): MockBaseState {
    return {
      tableCalls: [],
      recordCalls: [],
      tables: [
        { table_id: 'tblA', name: '主表' },
        { table_id: 'tblB', name: 'B表' },
      ],
      fieldsByTable: new Map<string, any>([
        [
          'tblA',
          {
            data: {
              items: [
                text('标题', { type: 'text', is_primary: true }),
                text('数值', { type: 2 }),
                text('单选', {
                  type: 3,
                  ui_type: 'SingleSelect',
                  property: { options: [{ name: '选项A' }, { name: '选项B' }] },
                }),
                text('多选', {
                  type: 4,
                  ui_type: 'MultiSelect',
                  property: { options: [{ name: 'X' }, { name: 'Y' }, { name: 'Z' }] },
                }),
                text('日期', { type: 5, ui_type: 'DateTime', property: { date_formatter: 'yyyy/MM/dd' } }),
                text('复选', { type: 6, ui_type: 'Checkbox' }),
                text('成员', { type: 7, ui_type: 'User' }),
                text('附件', { type: 10, ui_type: 'Attachment' }),
                text('关联', { type: 13, ui_type: 'OneWayLink', property: { table_id: 'tblB' } }),
                text('引用', { type: 18, ui_type: 'Lookup' }),
                text('公式', { type: 15, ui_type: 'Formula' }),
                text('位置', { type: 1001, ui_type: 'Location' }),
                text('新类型', { type: 'weird_future_type' }),
              ],
              has_more: false,
            },
          },
        ],
        [
          'tblB',
          {
            // 容错形状：camelCase key + 无 has_more（< limit 即终止）
            data: {
              items: [text('名称', { type: 'text', isPrimary: true })],
            },
          },
        ],
      ]),
      viewsByTable: new Map<string, any>([
        [
          'tblA',
          // 容错形状：fields/views 双 key 之一 + camelCase hasMore
          { data: { views: [{ view_id: 'viw1', view_name: '全部', view_type: 'grid' }], hasMore: false } },
        ],
      ]),
      recordsByTable: new Map<string, any[]>([
        [
          'tblA',
          [
            {
              record_id: 'recA1',
              fields: {
                标题: [{ type: 'text', text: '甲 | 乙' }],
                数值: 3.14,
                单选: { text: '选项A' },
                多选: [{ text: 'X' }, { text: 'Y' }],
                日期: 1720422600, // 秒级容错
                复选: true,
                成员: [{ name: '张三' }, { id: 'ou987' }],
                附件: [
                  { file_token: 'ftok1', name: '图.png' },
                  { file_token: 'ftok2', name: '炸.zip' },
                ],
                关联: ['recB1'],
                引用: ['x', 5, { text: 'seg' }],
                公式: [{ type: 'text', text: 'F1' }],
                位置: { location: { province: '江苏省', city: '南京市', district: '玄武区', address: '中山东路' } },
                新类型: { a: 1 },
              },
            },
            {
              record_id: 'recA2',
              fields: {
                标题: '多行\n文本',
                日期: 1720422600000, // 毫秒
                复选: false,
              },
            },
          ],
        ],
        [
          'tblB',
          [{ record_id: 'recB1', fields: { 名称: '标题B1' } }],
        ],
      ]),
      attachmentBehavior: (fileToken: string, outputDir: string) => {
        if (fileToken === 'ftok2') throw new Error('mock download failure');
        const target = path.join(outputDir, '图.png');
        fs.writeFileSync(target, 'fake-image-bytes', 'utf-8');
      },
      dashboards: { data: { items: [{ id: 'd1' }, { id: 'd2' }] } },
      workflowError: new Error('workflow 接口 404'),
      formsByTable: new Map<string, any>([
        ['tblA', { data: { items: [{ form_id: 'f1' }] } }],
        ['tblB', { data: { items: [] } }],
      ]),
    };
  }

  it('renders the full field-type matrix with correct md escaping', async () => {
    const staging = tmpStaging();
    try {
      const exporter = new BitableExporter(makeClient(setupMatrixState()));
      const result = await exporter.exportBitable({
        baseToken: 'bas3TestToken',
        title: '测试多维表',
        stagingDocDir: staging,
        docname: '测试多维表',
      });

      const md = result.markdown;
      // 结构：H1 + 概览 + 两张表章节 + base 元数据（--- 分隔）
      expect(md).toContain('# 测试多维表');
      expect(md).toContain('## 数据表: 主表');
      expect(md).toContain('## 数据表: B表');
      expect(md).toContain('## Base 元数据存档');
      expect(md.split('\n---\n').length).toBeGreaterThanOrEqual(4);

      // 表头 meta
      expect(md).toContain('- 表 ID: `tblA`');
      expect(md).toContain('- 记录数: 2');
      expect(md).toContain('**全部**（`viw1`，类型 `grid`）');

      // 渲染矩阵
      expect(md).toContain('甲 \\| 乙'); // md 表格 | 转义
      expect(md).toContain('多行<br>文本'); // 换行折叠
      expect(md).toContain('3.14');
      expect(md).toContain('选项A');
      expect(md).toContain('X / Y');
      expect(md).toContain('2024-07-08T07:10:00.000Z'); // 秒级 → 毫秒 ISO
      expect(md).toContain('张三 / ou987');
      expect(md).toContain('江苏省 南京市 玄武区 中山东路');
      expect(md).toContain('{"a":1}'); // 未知类型 compact JSON
      expect(md).toContain('✅');
      // link 两遍解析：recB1 → 「B表: 标题B1」
      expect(md).toContain('B表: 标题B1');
      // checkbox false → 空单元格（表格行仍完整）
      expect(md).toMatch(/\| recA2 \|[^|]*\|/);

      // 附件：成功 → attachments 链接；失败 → 标注 + 保留 token
      expect(md).toContain('[图.png](attachments/01-图.png)');
      expect(md).toContain('[炸.zip](下载失败 token:ftok2)');

      // 字段 schema 小节
      expect(md).toContain('### 字段');
      expect(md).toContain('选项: 选项A / 选项B');
      expect(md).toContain('格式: yyyy/MM/dd');
      expect(md).toContain('关联表: B表');
      expect(md).toContain('`fld_标题`');

      // CSV 链接
      expect(md).toContain('[CSV 原始数据](测试多维表.csv-data/主表.csv)');

      // 概览行
      expect(md).toContain('共 2 张数据表');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('paginates record-list with offset increments across 2 pages (250 records, page size 200)', async () => {
    const staging = tmpStaging();
    try {
      // 服务端语义：满页 200 返回 + has_more=true；第二页 50 条 +
      // has_more=false。翻页器应恰好发两次调用（offset 0 / 200）。
      const bigRecords = Array.from({ length: 250 }, (_, i) => ({
        record_id: `recP${i}`,
        fields: { 名称: `条目${i}` },
      }));
      const state: MockBaseState = {
        tableCalls: [],
        recordCalls: [],
        tables: [{ table_id: 'tblP', name: '大表' }],
        fieldsByTable: new Map([
          ['tblP', { data: { items: [text('名称', { type: 'text', is_primary: true })], has_more: false } }],
        ]),
        recordsByTable: new Map([['tblP', bigRecords]]),
      };
      const exporter = new BitableExporter(makeClient(state));
      const result = await exporter.exportBitable({
        baseToken: 'bas3TestToken',
        title: '翻页测试',
        stagingDocDir: staging,
        docname: '翻页测试',
      });

      expect(state.recordCalls.length).toBe(2);
      expect(state.recordCalls[0]).toEqual({ tableId: 'tblP', offset: 0, limit: 200 });
      expect(state.recordCalls[1]).toEqual({ tableId: 'tblP', offset: 200, limit: 200 });
      expect(result.sections[0].recordCount).toBe(250);
      expect(result.markdown).toContain('| recP249 | 条目249 |');

      // 小表（1 条 < limit）单次调用即止
      const matrix = setupMatrixState();
      await new BitableExporter(makeClient(matrix)).exportBitable({
        baseToken: 'bas3TestToken',
        title: '测试多维表',
        stagingDocDir: staging,
        docname: '测试多维表2',
      });
      const tblBCalls = matrix.recordCalls.filter((call) => call.tableId === 'tblB');
      expect(tblBCalls.length).toBe(1);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('writes per-table CSVs with raw values (attachment column = file_token list)', async () => {
    const staging = tmpStaging();
    try {
      const exporter = new BitableExporter(makeClient(setupMatrixState()));
      const result = await exporter.exportBitable({
        baseToken: 'bas3TestToken',
        title: '测试多维表',
        stagingDocDir: staging,
        docname: '测试多维表',
      });

      const csvPath = path.join(staging, '测试多维表.csv-data', '主表.csv');
      expect(fs.existsSync(csvPath)).toBe(true);
      const csv = fs.readFileSync(csvPath, 'utf-8');
      const lines = csv.trimEnd().split('\n');
      expect(lines[0]).toContain('record_id,标题,数值,单选,多选,日期');
      expect(lines[1]).toContain('recA1');
      expect(lines[1]).toContain('甲 | 乙'); // 原始值不转义
      expect(lines[1]).toContain('ftok1;ftok2'); // 附件 token 列表
      expect(lines[2]).toContain('recA2');
      // 原始换行保留：RFC4180 引号包裹的单元格内嵌换行
      expect(csv).toContain('"多行\n文本"');

      const csvB = path.join(staging, '测试多维表.csv-data', 'B表.csv');
      expect(fs.existsSync(csvB)).toBe(true);
      expect(fs.readFileSync(csvB, 'utf-8')).toContain('recB1,标题B1');

      expect(result.commitFiles.map((f) => f.relativePath)).toContain(
        '测试多维表.csv-data/主表.csv',
      );
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('lands attachments in staging attachments/ and reports failures softly', async () => {
    const staging = tmpStaging();
    try {
      const exporter = new BitableExporter(makeClient(setupMatrixState()));
      const result = await exporter.exportBitable({
        baseToken: 'bas3TestToken',
        title: '测试多维表',
        stagingDocDir: staging,
        docname: '测试多维表',
      });

      expect(result.attachments.length).toBe(1);
      expect(result.attachments[0].token).toBe('ftok1');
      expect(result.attachments[0].relativePath).toBe('attachments/01-图.png');
      const abs = path.join(staging, 'attachments', '01-图.png');
      expect(fs.existsSync(abs)).toBe(true);
      expect(fs.readFileSync(abs, 'utf-8')).toBe('fake-image-bytes');
      // 下载失败软降级：warnings 记录 + 不阻断
      expect(result.warnings.some((w) => w.includes('ftok2') || w.includes('炸.zip'))).toBe(true);
      // 临时下载目录已清理
      const attachmentsDirEntries = fs.readdirSync(path.join(staging, 'attachments'));
      expect(attachmentsDirEntries.every((name) => !name.startsWith('.dl-'))).toBe(true);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('sanitizes attachment name/token path segments (defense-in-depth, diting Minor-3)', async () => {
    const staging = tmpStaging();
    try {
      const state: MockBaseState = {
        tables: [{ table_id: 'tblEvil', name: '恶意命名表' }],
        recordsByTable: new Map([
          ['tblEvil', [{ record_id: 'recEvil', fields: {
            文件: [{ file_token: '../evil/../../tok1', name: 'a.b/../../x' }],
          } }]],
        ]),
        fieldsByTable: new Map([
          ['tblEvil', { data: { items: [
            { field_id: 'fld文件', field_name: '文件', type: 10 },
          ], has_more: false } }],
        ]),
        attachmentBehavior: (_fileToken: string, outputDir: string) => {
          // 下载产物无扩展名 → ext 走 plan.name 派生路径（含路径段）
          fs.writeFileSync(path.join(outputDir, '下载产物'), 'evil-ish bytes');
        },
        attachmentSavedName: '下载产物',
        recordCalls: [],
        tableCalls: [],
      };
      const exporter = new BitableExporter(makeClient(state));
      const result = await exporter.exportBitable({
        baseToken: 'bas3TestToken',
        title: '测试',
        stagingDocDir: staging,
        docname: '测试',
      });

      // 落盘文件全部在 attachments/ 内且以 .bin 结尾（白名单退化），
      // 无路径分隔符、无穿越
      const attDir = path.join(staging, 'attachments');
      const names = fs.readdirSync(attDir).filter((n) => !n.startsWith('.dl-'));
      expect(names.length).toBe(1);
      expect(names[0]).toMatch(/^[0-9]+-a\.b.*\.bin$/);
      expect(names[0]).not.toContain('/');
      expect(result.attachments[0].relativePath).toMatch(/^attachments\/[0-9]+-.*\.bin$/);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('archives dashboard/workflow/form metadata JSON with soft failure annotations', async () => {
    const staging = tmpStaging();
    try {
      const exporter = new BitableExporter(makeClient(setupMatrixState()));
      const result = await exporter.exportBitable({
        baseToken: 'bas3TestToken',
        title: '测试多维表',
        stagingDocDir: staging,
        docname: '测试多维表',
      });

      const dashboards = path.join(staging, '测试多维表.base-meta', 'dashboards.json');
      expect(fs.existsSync(dashboards)).toBe(true);
      const dashboardsPayload = JSON.parse(fs.readFileSync(dashboards, 'utf-8'));
      expect(dashboardsPayload.response.data.items.length).toBe(2);

      // workflow 失败：md 标注，不落盘，不阻断
      expect(fs.existsSync(path.join(staging, '测试多维表.base-meta', 'workflows.json'))).toBe(false);
      expect(result.markdown).toContain('自动化流程：获取失败');

      const forms = path.join(staging, '测试多维表.base-meta', 'forms.json');
      expect(fs.existsSync(forms)).toBe(true);
      const formsPayload = JSON.parse(fs.readFileSync(forms, 'utf-8'));
      expect(formsPayload.tables.length).toBe(2);
      expect(formsPayload.tables[0].itemCount).toBe(1);
      expect(result.markdown).toContain('[仪表盘](测试多维表.base-meta/dashboards.json)（2 条）');
      expect(result.markdown).toContain('2 张表 / 1 条');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('exposes section summaries for the sync engine logging', async () => {
    const staging = tmpStaging();
    try {
      const exporter = new BitableExporter(makeClient(setupMatrixState()));
      const result = await exporter.exportBitable({
        baseToken: 'bas3TestToken',
        title: '测试多维表',
        stagingDocDir: staging,
        docname: '测试多维表',
      });

      expect(result.sections.length).toBe(2);
      expect(result.sections[0]).toMatchObject({
        tableId: 'tblA',
        tableName: '主表',
        recordCount: 2,
        truncated: false,
      });
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 容错与边界
// ---------------------------------------------------------------------------

describe('BitableExporter — response-shape tolerance & boundaries', () => {
  it('unwraps double-layer data wrappers and missing has_more (page < limit stops)', async () => {
    const staging = tmpStaging();
    try {
      const state: MockBaseState = {
        tables: [{ table_id: 'tblS', name: 'S表' }],
        recordsByTable: new Map(),
        tableCalls: [],
        recordCalls: [],
      };
      const client: BitableClient = {
        ...makeClient(state),
        async listBaseTables() {
          // 双层 data 包装（历史 lark-cli 归一层差异）
          return { data: { data: { items: [{ table_id: 'tblS', table_name: 'S表' }] } } };
        },
        async listBaseFields() {
          return { data: { items: [text('字段1', { type: 'text' })] } }; // 无 has_more
        },
        async listBaseViews() {
          return { data: { views: [] } };
        },
        async listBaseRecords() {
          // camelCase recordId + 单条 < limit → 停止
          return { data: { items: [{ recordId: 'recS1', fields: { 字段1: '值' } }] } };
        },
        async downloadBaseAttachment() {
          throw new Error('no attachment');
        },
        async listBaseDashboards() {
          return { data: { items: [] } };
        },
        async listBaseWorkflows() {
          return { data: { items: [] } };
        },
        async listBaseForms() {
          return { data: { items: [] } };
        },
      };
      const exporter = new BitableExporter(client);
      const result = await exporter.exportBitable({
        baseToken: 'bas3T',
        title: 'S',
        stagingDocDir: staging,
        docname: 'S',
      });

      expect(result.sections.length).toBe(1);
      expect(result.markdown).toContain('## 数据表: S表');
      expect(result.markdown).toContain('| recS1 | 值 |');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('throws (hard failure) when table-list fails — never produces a partial export', async () => {
    const staging = tmpStaging();
    try {
      const client: BitableClient = {
        ...makeClient({ tables: [], recordsByTable: new Map(), tableCalls: [], recordCalls: [] }),
        async listBaseTables() {
          throw new Error('code 40403 无权限');
        },
      };
      const exporter = new BitableExporter(client);
      await expect(
        exporter.exportBitable({ baseToken: 'bas3T', title: 'X', stagingDocDir: staging, docname: 'X' }),
      ).rejects.toThrow('数据表清单读取失败');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('throws (hard failure) when record-list fails mid-table', async () => {
    const staging = tmpStaging();
    try {
      const client: BitableClient = {
        ...makeClient({
          tables: [{ table_id: 'tblR', name: 'R表' }],
          recordsByTable: new Map(),
          tableCalls: [],
          recordCalls: [],
        }),
        async listBaseFields() {
          return { data: { items: [text('F', { type: 'text' })], has_more: false } };
        },
        async listBaseRecords() {
          throw new Error('code 99991400 限流');
        },
      };
      const exporter = new BitableExporter(client);
      await expect(
        exporter.exportBitable({ baseToken: 'bas3T', title: 'X', stagingDocDir: staging, docname: 'X' }),
      ).rejects.toThrow('记录读取失败');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('renders an empty base (0 tables) without error', async () => {
    const staging = tmpStaging();
    try {
      const exporter = new BitableExporter(
        makeClient({ tables: [], recordsByTable: new Map(), tableCalls: [], recordCalls: [] }),
      );
      const result = await exporter.exportBitable({
        baseToken: 'bas3T',
        title: '空表',
        stagingDocDir: staging,
        docname: '空表',
      });
      expect(result.sections.length).toBe(0);
      expect(result.markdown).toContain('# 空表');
      expect(result.markdown).toContain('共 0 张数据表');
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('de-duplicates sanitized CSV file names for same-named tables', async () => {
    const staging = tmpStaging();
    try {
      const state: MockBaseState = {
        tables: [
          { table_id: 'tblD1', name: '同名/表' },
          { table_id: 'tblD2', name: '同名\\表' },
        ],
        fieldsByTable: new Map<string, any>([
          ['tblD1', { data: { items: [text('F', { type: 'text' })] } }],
          ['tblD2', { data: { items: [text('F', { type: 'text' })] } }],
        ]),
        recordsByTable: new Map([
          ['tblD1', [{ record_id: 'r1', fields: { F: 'a' } }]],
          ['tblD2', [{ record_id: 'r2', fields: { F: 'b' } }]],
        ]),
        tableCalls: [],
        recordCalls: [],
      };
      const exporter = new BitableExporter(makeClient(state));
      const result = await exporter.exportBitable({
        baseToken: 'bas3T',
        title: 'D',
        stagingDocDir: staging,
        docname: 'D',
      });
      const csvNames = fs.readdirSync(path.join(staging, 'D.csv-data')).sort();
      expect(csvNames).toEqual(['同名_表.csv', '同名_表_2.csv']);
      expect(result.sections.length).toBe(2);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });
});
