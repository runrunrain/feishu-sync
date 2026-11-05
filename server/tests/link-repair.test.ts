import { describe, expect, it } from 'vitest';
import { repairRelativeMdLinks } from '../src/kb/link-repair.js';

describe('repairRelativeMdLinks', () => {
  it('repairs a unique missing basename, retaining anchor', () => {
    expect(repairRelativeMdLinks('[规则](规则.md#ko_x)', 'a/topic.md', ['rules/规则.md']))
      .toEqual({ markdown: '[规则](../rules/规则.md#ko_x)', repairs: [{ from: '规则.md#ko_x', to: '../rules/规则.md#ko_x' }] });
  });
  it('does not guess when targets are ambiguous or already resolve', () => {
    const input = '[a](a.md) [b](missing.md)';
    expect(repairRelativeMdLinks(input, 'dir/x.md', ['dir/a.md', 'a/missing.md', 'b/missing.md']).markdown).toBe(input);
  });
  it('does not rewrite links in an indented code block', () => {
    const input = '    [a](a.md)\n\t[b](b.md)';
    expect(repairRelativeMdLinks(input, 'dir/x.md', ['other/a.md', 'other/b.md'])).toEqual({ markdown: input, repairs: [] });
  });
  it('does not rewrite links in a multiline code span', () => {
    const input = '`line one\n[a](a.md)\nend`';
    expect(repairRelativeMdLinks(input, 'dir/x.md', ['other/a.md'])).toEqual({ markdown: input, repairs: [] });
  });
  it('does not touch fenced code, inline code, images, non-markdown or absolute links', () => {
    const input = '````md\n[a](a.md)\n```\n[a](a.md)\n````\n`[a](a.md)` ![a](a.md) [x](a.png) [e](https://x/a.md) [root](/a.md)';
    expect(repairRelativeMdLinks(input, 'dir/x.md', ['other/a.md']).markdown).toBe(input);
  });
});
