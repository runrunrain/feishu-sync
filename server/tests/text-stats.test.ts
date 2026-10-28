/**
 * text-stats 单测（P2 §2.1 契约口径逐条锚定）
 *
 * 覆盖：头部注释剥离（feishu_sync / feishu_sync_kb）、链接/图片只计文字、
 * 标题/列表/引用标记剥离、表格（分隔行丢弃 / 数据行管道去除）、代码块
 * （围栏丢弃、内容保留）、words 口径（CJK 逐字 / 假名 / 谚文 / 非 CJK
 * 连续词元 / 两类不互相吞并）、chars 口径（非空白码点、代理对按 1 计）。
 * §2.6 算例属 packBatches（P2-S2 切片），本文件只锚 §2.1 的口径规则；
 * §2.2 effectiveWords 的「unavailable 计 0」是消费侧逻辑，不在纯函数内。
 */

import { describe, expect, it } from 'vitest';
import { countText } from '../src/kb/text-stats.js';

const SYNC_HEADER = `<!--
feishu_sync:
  obj_token: tok123
  obj_type: docx
-->
`;

const KB_HEADER = `<!--
feishu_sync_kb:
  doc_id: kd_abc
  sources:
    - raw/a.md
  build_id: kb_1
-->
`;

describe('countText · 预处理（§2.1 第 1–4 条）', () => {
  it('文件首部 feishu_sync / feishu_sync_kb 头部注释不计入', () => {
    expect(countText(SYNC_HEADER + '正文')).toEqual({ words: 2, chars: 2 });
    expect(countText(KB_HEADER + '正文')).toEqual({ words: 2, chars: 2 });
  });

  it('链接只计文字、图片只计 alt', () => {
    expect(countText('见 [文档](../a/b.md) 与 ![截图](img/x.png)')).toEqual({ words: 6, chars: 6 });
    // words = 见1 + 文档2 + 与1 + 截图2；chars 同（语法标记全剥）
  });

  it('行首标题/列表/引用标记剥离（含嵌套与缩进列表）', () => {
    expect(countText('## 设计标题\n- 项目一\n  - 子项\n> 引用内容\n1. 步骤')).toEqual({
      words: 4 + 3 + 2 + 4 + 2,
      chars: 4 + 3 + 2 + 4 + 2,
    });
  });

  it('表格：分隔行整行丢弃、数据行管道去除、内容保留', () => {
    const table = '| 列一 | 列二 |\n| --- | --- |\n| 数据甲 | 数据乙 |';
    expect(countText(table)).toEqual({ words: 2 + 2 + 3 + 3, chars: 2 + 2 + 3 + 3 });
  });

  it('代码块：围栏行不计、内容原样保留（# | - 不当标记剥）', () => {
    const code = '前文\n```js\nconst a = 1; // # 不是标题\n```\n后文';
    // words: 前文2 + code块内: const1 a1 1(数字)1 不是标题4 = 7 → 前文2+7+后文2
    expect(countText(code)).toEqual({ words: 2 + 7 + 2, chars: 2 + 16 + 2 });
    // code 块 chars: "const a = 1; // # 不是标题" 非空白 = const(5)+a(1)+=(1)+1;(2)+//(2)+#(1)+不是标题(4) = 16
  });

  it('主题分割线丢弃', () => {
    expect(countText('上文\n---\n下文')).toEqual({ words: 4, chars: 4 });
  });

  it('空文档与纯头部文档 → 0/0', () => {
    expect(countText('')).toEqual({ words: 0, chars: 0 });
    expect(countText(KB_HEADER)).toEqual({ words: 0, chars: 0 });
  });
});

describe('countText · words 口径（§2.1）', () => {
  it('中文逐字计词；中文标点不计词但计字符', () => {
    expect(countText('你好，世界！')).toEqual({ words: 4, chars: 6 });
  });

  it('英文按连续词元切词：连字符/撇号/下划线连写算一个词', () => {
    expect(countText("Hello world, foo_bar well-known don't")).toEqual({ words: 5, chars: 33 });
    // chars = Hello(5)+world,(6)+foo_bar(7)+well-known(10)+don't(5) = 33
  });

  it('中英混排两类不互相吞并：abc中def = 3 词', () => {
    expect(countText('abc中def')).toEqual({ words: 3, chars: 7 });
  });

  it('假名（平/片假名）与谚文音节逐字计词', () => {
    expect(countText('こんにちは')).toEqual({ words: 5, chars: 5 });
    expect(countText('カタカナ')).toEqual({ words: 4, chars: 4 });
    expect(countText('안녕하세요')).toEqual({ words: 5, chars: 5 });
  });

  it('其他字母文字走通用词元正则', () => {
    expect(countText('привет мир')).toEqual({ words: 2, chars: 9 });
  });

  it('纯符号无词：emoji 计 chars 不计 words，代理对按 1 码点', () => {
    expect(countText('🙂🙂')).toEqual({ words: 0, chars: 2 });
  });
});

describe('countText · chars 口径（P1 §4.5 回读校验用）', () => {
  it('chars = 预处理后非空白 Unicode 码点数（空白不计）', () => {
    expect(countText('a b\tc\nd　e')).toEqual({ words: 5, chars: 5 }); // 含全角空格
  });

  it('渲染后正文（无头部）同样可统计', () => {
    expect(countText('# 标题\n\n段落。')).toEqual({ words: 4, chars: 5 }); // 句号计 chars
  });
});
