import { describe, expect, it } from 'vitest';
import {
  SlidesXmlAdapter,
  adaptSlidesXmlToMarkdown,
} from '../src/modules/slides-xml-adapter.js';

describe('SlidesXmlAdapter', () => {
  it('renders readable slide text, lists, escaped entities, and media references deterministically', () => {
    const result = adaptSlidesXmlToMarkdown(`<?xml version="1.0" encoding="UTF-8"?>
      <presentation revision="7">
        <slides>
          <slide id="s-1">
            <content>
              <p>欢迎 &amp; &lt;飞书&gt;<span>同步</span><br/>第二行</p>
              <list>
                <li><p>第一项 &quot;A&quot;</p></li>
                <li><span>第二项&#xFF1A;中文</span></li>
              </list>
              <style><text>样式文字不应导出</text></style>
            </content>
            <img src="img_token_1"/>
            <whiteboard token="whiteboard_token_1"/>
          </slide>
          <slide id="s-2">
            <content>
              <p><span>第二页</span></p>
              <p>尾注&#10;下一行</p>
            </content>
            <img src="img_token_1"/>
            <img src="https://example.test/file/image_token_2?download=1"/>
          </slide>
        </slides>
      </presentation>`, '产品发布');

    expect(result.markdown).toBe([
      '# 产品发布',
      '',
      '## 幻灯片 1',
      '',
      '欢迎 & <飞书>同步  ',
      '第二行',
      '',
      '- 第一项 "A"',
      '- 第二项：中文',
      '',
      '## 幻灯片 2',
      '',
      '第二页',
      '',
      '尾注  ',
      '下一行',
      '',
    ].join('\n'));
    expect(result.slideCount).toBe(2);
    expect(result.imageTokens).toEqual([
      'img_token_1',
      'https://example.test/file/image_token_2?download=1',
    ]);
    expect(result.whiteboardTokens).toEqual(['whiteboard_token_1']);
    expect(result.mediaReferences).toEqual([
      { kind: 'image', token: 'img_token_1', slideNumber: 1 },
      { kind: 'whiteboard', token: 'whiteboard_token_1', slideNumber: 1 },
      { kind: 'image', token: 'img_token_1', slideNumber: 2 },
      {
        kind: 'image',
        token: 'https://example.test/file/image_token_2?download=1',
        slideNumber: 2,
      },
    ]);
  });

  it('uses a plain content fallback when a slide has no paragraph tags', () => {
    const adapter = new SlidesXmlAdapter();
    const result = adapter.adapt(
      '<presentation><slides><slide><content><span>仅有 span 的文本</span></content></slide></slides></presentation>',
      '无段落页面',
    );

    expect(result.markdown).toBe('# 无段落页面\n\n## 幻灯片 1\n\n仅有 span 的文本\n');
  });

  it.each([
    ['', /Slides XML 为空/],
    ['<presentation><slide></presentation>', /标签未正确嵌套|标签未闭合/],
    ['<document><slide/></document>', /根节点必须为 presentation/],
    ['<presentation><slides/></presentation>', /不包含任何 slide/],
  ])('rejects missing or invalid XML: %s', (xml, message) => {
    expect(() => adaptSlidesXmlToMarkdown(xml, '测试')).toThrow(message);
  });
});
