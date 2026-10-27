import { describe, expect, it } from 'vitest';
import { needsRemoteImageConsent } from './MarkdownView';

describe('remote image consent across document/component reuse', () => {
  const first = 'https://images.example/first.svg';
  const second = 'https://other.example/second.svg';

  it('requires an explicit grant for the first remote image', () => {
    expect(needsRemoteImageConsent(first, 'confirm', null)).toBe(true);
    expect(needsRemoteImageConsent(first, 'confirm', first)).toBe(false);
  });

  it('does not reuse the old document grant for a different URL', () => {
    expect(needsRemoteImageConsent(second, 'confirm', first)).toBe(true);
    expect(needsRemoteImageConsent(second, 'confirm', second)).toBe(false);
  });

  it('requires new consent when query content changes on the same host', () => {
    expect(needsRemoteImageConsent(`${first}?new=data`, 'confirm', first)).toBe(true);
  });

  it('keeps local media and the explicitly selected legacy auto policy unchanged', () => {
    expect(needsRemoteImageConsent('images/local.png', 'confirm', null)).toBe(false);
    expect(needsRemoteImageConsent(first, 'auto', null)).toBe(false);
  });
});
