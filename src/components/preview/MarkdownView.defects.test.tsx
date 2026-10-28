/**
 * T0a 渲染端缺陷修复回归测试（T2a-r）。
 *
 * 逐项锚定 agent-outputs/workflow/2026-10-27-kb-agent-upgrade/
 * T0a-markdown-preview-defects.md §③ 清单中修复落点在渲染端的缺陷。
 * 证据形态：renderToStaticMarkup 输出的 DOM 片段（SSR 级 DOM 锚定，
 * 真机浏览器验证由 Leader 集成阶段统一执行）。
 */
import { describe, expect, it } from 'vitest'
import { isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownView, parseBlocks, preprocess, renderInline } from './MarkdownView'
import type { HtmlTableBlock } from '../../utils/html-table'

const render = (content: string) => renderToStaticMarkup(<MarkdownView content={content} />)
/** 本地图片在 SSR 下的鉴权加载占位文案（useEffect 不执行，初始为加载态）。 */
const IMG_PLACEHOLDER = '图片加载中'

// ---------------------------------------------------------------------------
// D2｜preprocess 剥离不区分代码围栏（高优先：内容丢失）
// ---------------------------------------------------------------------------

describe('D2 preprocess 围栏保护', () => {
  it('代码围栏内的 HTML 注释保留原文', () => {
    const out = preprocess('```\n<!-- 示例注释 -->\n```')
    expect(out).toContain('<!-- 示例注释 -->')
  })

  it('代码围栏内的 <table> 不被注入空行', () => {
    const out = preprocess('```html\n前文 <table> 内文 </table> 后文\n```')
    expect(out).not.toContain('\n\n')
  })

  it('代码围栏内的 <sheet> 不触发兜底替换', () => {
    const out = preprocess('```\n<sheet sheet-id="x" token="y"></sheet>\n```')
    expect(out).toContain('<sheet sheet-id="x"')
    expect(out).not.toContain('【内嵌子表】')
  })

  it('围栏内未闭合 <!-- 不吞围栏外正文', () => {
    const content = '```html\n<!-- 未闭合示例\n```\n\n正文段落一\n\n尾行 --> 后记'
    const html = render(content)
    expect(html).toContain('正文段落一')
    expect(html).toContain('后记')
    // 围栏内原文保留（代码块内容不被 preprocess 破坏）
    expect(html).toContain('未闭合示例')
  })

  it('普通文本中的闭合注释仍被剥离（feishu_sync 头回归）', () => {
    const html = render('<!--\nfeishu_sync:\n  obj_token: abc\n-->\n\n# 标题')
    expect(html).not.toContain('feishu_sync')
    expect(html).toContain('标题')
  })

  it('普通文本中未闭合 <!-- 仅去标记、不吞正文', () => {
    const html = render('前言 <!-- 未闭合痕迹\n\n后续正文')
    expect(html).toContain('前言')
    expect(html).toContain('后续正文')
    expect(html).not.toContain('<!--')
    expect(html).not.toContain('&lt;!--')
  })
})

// ---------------------------------------------------------------------------
// D19｜包裹式媒体标签转换后残留闭合标签（高优先）
// ---------------------------------------------------------------------------

describe('D19 包裹式媒体标签闭合残留', () => {
  it('whiteboard 包裹式转换为图片且无残留闭合标签', () => {
    const html = render('<whiteboard token="images/a.png">板书</whiteboard>')
    expect(html).toContain(IMG_PLACEHOLDER)
    expect(html).not.toContain('whiteboard')
  })

  it('image 空内容包裹式无残留', () => {
    const html = render('<image token="images/b.png"></image>')
    expect(html).toContain(IMG_PLACEHOLDER)
    // SSR 下字面泄漏会以转义形态出现，需一并断言
    expect(html).not.toContain('</image>')
    expect(html).not.toContain('&lt;/image&gt;')
  })

  it('自闭合形态不受影响（回归）', () => {
    const html = render('<img src="images/c.jpg"/>')
    expect(html).toContain(IMG_PLACEHOLDER)
  })
})

// ---------------------------------------------------------------------------
// D1（渲染侧）｜<details> 元数据块按字面显示（高优先）
// ---------------------------------------------------------------------------

describe('D1 details 元数据块受控渲染', () => {
  it('sheet A 型 details 块渲染为折叠区块而非字面文本', () => {
    const content =
      '<details>\n<summary>元数据</summary>\n\n* 更新日志：2026-06-15\n* 作者：小星\n</details>'
    const html = render(content)
    expect(html).toContain('<details')
    expect(html).toContain('<summary')
    expect(html).toContain('元数据')
    expect(html).toContain('更新日志')
    expect(html).not.toContain('&lt;details&gt;')
    expect(html).not.toContain('&lt;summary')
  })

  it('details 内容中的列表正常渲染', () => {
    const html = render(
      '<details>\n<summary>元数据</summary>\n\n* 更新日志：2026-06-15\n</details>',
    )
    expect(html).toContain('<ul')
    expect(html).toContain('2026-06-15')
  })
})

// ---------------------------------------------------------------------------
// D17（渲染侧兜底）/ D18｜裸 <sheet> 不兜底
// ---------------------------------------------------------------------------

describe('D18 裸 <sheet> 兜底', () => {
  it('无属性裸标签触发兜底提示', () => {
    const html = render('<sheet></sheet>')
    expect(html).toContain('【内嵌子表】')
    expect(html).not.toContain('<sheet')
  })

  it('带属性形态保持既有兜底（回归）', () => {
    const html = render('<sheet sheet-id="abc" token="tok123"></sheet>')
    expect(html).toContain('sheet-id: abc')
    expect(html).toContain('token: tok123')
  })
})

// ---------------------------------------------------------------------------
// D17｜嵌套 HTML 表格截断
// ---------------------------------------------------------------------------

describe('D17 嵌套 HTML 表格', () => {
  it('单行嵌套表格不截断、无残片泄漏（内层行降级并入外层）', () => {
    const line =
      '<table><tr><td>外A<table><tr><td>内1</td></tr></table></td></tr><tr><td>外B</td></tr></table>'
    const blocks = parseBlocks(line)
    expect(blocks.length).toBe(1)
    expect(blocks[0].type).toBe('html_table')
    const tb = blocks[0] as HtmlTableBlock
    // 旧实现在首个 </table> 截断：外B 行丢失且残片泄漏为文本段
    expect(tb.bodyRows[0].cells[0].content).toContain('外A')
    expect(tb.bodyRows.some((r) => r.cells.some((c) => c.content.includes('内1')))).toBe(true)
    expect(tb.bodyRows[tb.bodyRows.length - 1].cells[0].content).toContain('外B')
  })

  it('多行嵌套表格按深度匹配（内层 </table> 不提前闭块）', () => {
    const content = '<table>\n<tr><td>A<table><tr><td>B</td></tr></table></td></tr>\n</table>'
    const blocks = parseBlocks(content)
    expect(blocks.length).toBe(1)
    expect(blocks[0].type).toBe('html_table')
  })
})

// ---------------------------------------------------------------------------
// D3（渲染侧兜底）｜自定义归档附件标签不可点击
// ---------------------------------------------------------------------------

describe('D3 附件标签渲染端兜底', () => {
  it('本地附件路径转为可点击链接', () => {
    const html = render('<file token="attachments/01-需求包.pdf"/>')
    expect(html).toContain('href="attachments/01-需求包.pdf"')
    expect(html).toContain('01-需求包.pdf')
    expect(html).not.toContain('<file')
  })

  it('source 包裹式附件同样转链接', () => {
    const html = render('<source token="attachments/数据表.xlsx">原始数据</source>')
    expect(html).toContain('href="attachments/数据表.xlsx"')
  })

  it('飞书 token 形态保持原文（未改写不误转）', () => {
    const html = render('<file token="V0OLQ3xTq9Abc"/>')
    expect(html).toContain('V0OLQ3xTq9Abc')
    expect(html).not.toContain('href=')
  })
})

// ---------------------------------------------------------------------------
// D5｜任务列表字面显示
// ---------------------------------------------------------------------------

describe('D5 任务列表', () => {
  it('未完成/已完成 checkbox 渲染为勾选框而非字面括号', () => {
    const html = render('- [ ] 待办事项\n- [x] 已完成事项')
    expect(html).toContain('☐')
    expect(html).toContain('☑')
    expect(html).not.toContain('[ ]')
    expect(html).not.toContain('[x]')
  })
})

// ---------------------------------------------------------------------------
// D10｜非白名单行内标签泄漏（u/mark/sub/sup/font）
// ---------------------------------------------------------------------------

describe('D10 行内标签白名单扩充', () => {
  it('u/mark/sub/sup 受控渲染', () => {
    const html = render(
      '下划线<u>重点</u>，高亮<mark>关键词</mark>，H<sub>2</sub>O 与 x<sup>2</sup>',
    )
    expect(html).toContain('<u')
    expect(html).toContain('<mark')
    expect(html).toContain('<sub')
    expect(html).toContain('<sup')
    expect(html).not.toContain('&lt;u&gt;')
    expect(html).not.toContain('&lt;mark&gt;')
  })

  it('font color 白名单渲染、非法值降级保留内容', () => {
    const html = render('<font color="red">红色</font> 与 <font color="expression(x)">非法</font>')
    expect(html).toContain('style="color:red"')
    expect(html).toContain('红色')
    expect(html).toContain('非法')
    expect(html).not.toContain('expression')
  })
})

// ---------------------------------------------------------------------------
// D8｜列表项续行脱离
// ---------------------------------------------------------------------------

describe('D8 列表续行归并', () => {
  it('缩进图片行归并进前一个列表项（不脱离为独立段落）', () => {
    const html = render('- **单元格 A1 浮动图片**\n  ![浮动图](images/a1.png)\n- 第二项')
    expect((html.match(/<li/g) ?? []).length).toBe(2)
    // 占位必须与首项同处一个 <li>（两者之间无 </li> 闭合）
    const idxText = html.indexOf('浮动图片')
    const idxImg = html.indexOf(IMG_PLACEHOLDER)
    expect(idxText).toBeGreaterThanOrEqual(0)
    expect(idxImg).toBeGreaterThan(idxText)
    expect(html.slice(idxText, idxImg)).not.toContain('</li>')
    expect(html).toContain('第二项')
  })

  it('块起点续行（围栏/标题）仍结束列表', () => {
    const blocks = parseBlocks('- 项目\n\n# 后续标题')
    expect(blocks.length).toBe(2)
    expect(blocks[0].type).toBe('list')
    expect(blocks[1].type).toBe('heading')
  })
})

// ---------------------------------------------------------------------------
// D7｜混合列表标记类型丢失
// ---------------------------------------------------------------------------

describe('D7 混合列表嵌套', () => {
  it('无序父项嵌套有序子项渲染为嵌套 ol', () => {
    const html = render('- 父项甲\n  1. 子项一\n  2. 子项二\n- 父项乙')
    expect(html).toContain('父项甲<ol')
    expect(html).toContain('子项一')
    expect(html).toContain('子项二')
    expect(html).toContain('父项乙')
  })

  it('纯同构列表行为不变（回归）', () => {
    const html = render('- 甲\n- 乙\n  - 丙')
    expect(html).toContain('丙')
  })
})

// ---------------------------------------------------------------------------
// D9｜callout emoji/底色丢失
// ---------------------------------------------------------------------------

describe('D9 callout 提示块', () => {
  it('emoji 与底色保留，内容按块渲染', () => {
    const content =
      '<callout emoji-id="warning" background-color="yellow">\n注意：此处有重要变更\n</callout>'
    const html = render(content)
    expect(html).toContain('data-md-block="callout"')
    expect(html).toContain('⚠️')
    expect(html).toContain('bg-amber-50')
    expect(html).toContain('重要变更')
    expect(html).not.toContain('<callout')
  })

  it('未知 emoji/底色降级默认样式', () => {
    const html = render('<callout>普通提示</callout>')
    expect(html).toContain('💬')
    expect(html).toContain('普通提示')
  })
})

// ---------------------------------------------------------------------------
// D13｜中文硬换行插空格
// ---------------------------------------------------------------------------

describe('D13 中文硬换行拼接', () => {
  it('CJK 相邻行无空格拼接', () => {
    const html = render('第一行中文\n第二行中文')
    expect(html).toContain('第一行中文第二行中文')
  })

  it('西文相邻行保留单空格', () => {
    const html = render('Hello world\nnext line')
    expect(html).toContain('Hello world next line')
  })

  it('中西混排按边界字符判定（两侧均 CJK 才去空格）', () => {
    const html = render('Hello 世界\n下一行')
    expect(html).toContain('Hello 世界下一行')
  })
})

// ---------------------------------------------------------------------------
// D14｜围栏 info string 含空格不识别
// ---------------------------------------------------------------------------

describe('D14 围栏 info string', () => {
  it('含空格 info string 识别为代码块且内容不泄漏', () => {
    const blocks = parseBlocks('```ts title="x"\nconst a = 1;\n```')
    expect(blocks.length).toBe(1)
    expect(blocks[0].type).toBe('code')
    const code = blocks[0] as { type: string; lang: string; lines: string[] }
    expect(code.lang).toContain('ts')
    expect(code.lines).toContain('const a = 1;')
  })

  it('SSR 渲染语言标记与代码内容', () => {
    const html = render('```ts title="x"\nconst a = 1;\n```')
    expect(html).toContain('data-md-block="code"')
    expect(html).toContain('const a = 1;')
  })
})

// ---------------------------------------------------------------------------
// D6｜有序列表起始编号丢失
// ---------------------------------------------------------------------------

describe('D6 有序列表起始编号', () => {
  it('起始编号 3 透传 <ol start>', () => {
    const html = render('3. 第三项\n4. 第四项')
    expect(html).toContain('start="3"')
    expect(html).toContain('第三项')
  })

  it('起始 1 不输出 start（回归）', () => {
    const html = render('1. 第一项')
    expect(html).not.toContain('start=')
  })
})

// ---------------------------------------------------------------------------
// D12｜span 样式剥离
// ---------------------------------------------------------------------------

describe('D12 span 样式', () => {
  it('白名单样式保留（color/font-weight）', () => {
    const html = render('<span style="color:red;font-weight:bold">红色加粗</span>')
    expect(html).toContain('color:red')
    expect(html).toContain('font-weight:bold')
  })

  it('危险样式值被白名单剥离', () => {
    const html = render('<span style="background:url(javascript:1)">内容</span>')
    expect(html).toContain('内容')
    expect(html).not.toContain('url(')
  })
})

// ---------------------------------------------------------------------------
// D11｜<a> 非引号 href 字符类笔误
// ---------------------------------------------------------------------------

describe('D11 非引号 href', () => {
  it('非引号 https href 不被截断', () => {
    const nodes = renderInline('<a href=https://example.com/page>文本</a>', 't', { baseDir: '' })
    const anchor = nodes.find((n) => isValidElement(n) && n.type === 'a') as {
      props: { href: string }
    }
    expect(anchor).toBeTruthy()
    expect(anchor.props.href).toBe('https://example.com/page')
  })
})

// ---------------------------------------------------------------------------
// D15｜图片 title 污染 src
// ---------------------------------------------------------------------------

describe('D15 图片/链接 title 剥离', () => {
  it('图片尾随 title 不污染 src', () => {
    const nodes = renderInline('![a](images/a.png "标题")', 't', { baseDir: '' })
    const img = nodes[0] as { props: { src: string } }
    expect(isValidElement(img)).toBe(true)
    expect(img.props.src).toBe('images/a.png')
  })

  it('链接尾随 title 不污染 href', () => {
    const nodes = renderInline('[CSV](docs/a.csv "说明")', 't', { baseDir: '' })
    const anchor = nodes.find((n) => isValidElement(n) && n.type === 'a') as {
      props: { href: string }
    }
    expect(anchor.props.href).toBe('docs/a.csv')
  })

  it('单引号 title 同样剥离', () => {
    const nodes = renderInline("![a](images/b.png '标题')", 't', { baseDir: '' })
    const img = nodes[0] as { props: { src: string } }
    expect(img.props.src).toBe('images/b.png')
  })
})

// ---------------------------------------------------------------------------
// D16｜斜体误匹配乘号
// ---------------------------------------------------------------------------

describe('D16 斜体侧边界', () => {
  it('2*3*4 不误判斜体', () => {
    const html = render('计算 2*3*4 的结果')
    expect(html).not.toContain('<em')
    expect(html).toContain('2*3*4')
  })

  it('中文强调斜体不受影响', () => {
    const html = render('这段*重点*结论')
    expect(html).toContain('<em')
    expect(html).toContain('重点')
  })

  it('西文词间斜体不受影响（空格侧边界）', () => {
    const html = render('a *italic* b')
    expect(html).toContain('<em')
  })
})

// ---------------------------------------------------------------------------
// 综合冒烟：真实 sheet 产物形态组合（A 型 details + 图片 + 列表 + 围栏 + callout）
// ---------------------------------------------------------------------------

describe('综合冒烟（多结构组合不崩溃、关键内容齐活）', () => {
  it('A 型元数据 + 浮动图片附录 + 代码围栏 + callout 组合渲染', () => {
    const content = [
      '## 子表: 主表',
      '',
      '<details>',
      '<summary>元数据</summary>',
      '',
      '* 更新日志：2026-06-15',
      '* 作者：小星',
      '</details>',
      '',
      '### 子表图片资源',
      '',
      '- **单元格 A1 浮动图片**',
      '  ![主表_A7](images/主表_A7.png)',
      '',
      '```html',
      '<!-- 代码内注释保留 -->',
      '```',
      '',
      '<callout emoji-id="warning" background-color="yellow">',
      '注意：数值已调整',
      '</callout>',
      '',
      '[CSV 原始数据](300-数据表.csv)',
    ].join('\n')
    const html = render(content)
    expect(html).toContain('<summary')
    expect(html).toContain('更新日志')
    expect(html).toContain(IMG_PLACEHOLDER)
    // 代码块内容在静态标记中以实体转义形态呈现（文本节点内容完整保留）
    expect(html).toContain('&lt;!-- 代码内注释保留 --&gt;')
    expect(html).toContain('⚠️')
    expect(html).toContain('注意：数值已调整')
    expect(html).toContain('href="300-数据表.csv"')
  })
})
