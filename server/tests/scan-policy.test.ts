import { describe, expect, it } from 'vitest';
import { ScanPolicy } from '../src/modules/scan-policy.js';

describe('ScanPolicy', () => {
  it('excludes only the reserved operational directories', () => {
    for (const name of [
      '_reports',
      '.trash-bin',
      '.staging',
      '_staging',
      '.recovery',
      '_recovery',
      '.restore',
      '_restore',
    ]) {
      expect(ScanPolicy.shouldSkipDirectory(name)).toBe(true);
    }

    // Do not make ordinary knowledge-base folders disappear by matching
    // generic names too broadly.
    expect(ScanPolicy.shouldSkipDirectory('staging')).toBe(false);
    expect(ScanPolicy.shouldSkipDirectory('recovery')).toBe(false);
    expect(ScanPolicy.shouldSkipDirectory('meeting-notes')).toBe(false);
  });

  it('excludes migration and write-backup artifacts by suffix', () => {
    expect(ScanPolicy.shouldSkipFile('README.md.pre-migrate')).toBe(true);
    expect(ScanPolicy.shouldSkipFile('document.md.bak')).toBe(true);
    expect(ScanPolicy.shouldSkipFile('document.bak.md')).toBe(false);
    expect(ScanPolicy.shouldSkipFile('document.md')).toBe(false);
  });
});
