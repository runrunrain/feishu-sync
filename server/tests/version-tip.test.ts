import { describe, expect, it } from 'vitest';
import {
  cleanVersion,
  compareSemver,
  detectUpgradeKind,
  formatVersionTag,
  generateVersionTip,
  getUpgradeKindLabel,
  parseSemver,
} from '../../src/utils/versionTip';

describe('versionTip helper functions', () => {
  it('formatVersionTag normalizes prefixes and empty strings', () => {
    expect(formatVersionTag('0.3.7')).toBe('v0.3.7');
    expect(formatVersionTag('v0.3.7')).toBe('v0.3.7');
    expect(formatVersionTag('V1.2.0')).toBe('V1.2.0');
    expect(formatVersionTag('')).toBe('');
    expect(formatVersionTag(null)).toBe('');
    expect(formatVersionTag(undefined)).toBe('');
  });

  it('cleanVersion extracts clean SemVer strings', () => {
    expect(cleanVersion('v0.3.7')).toBe('0.3.7');
    expect(cleanVersion('0.3.7')).toBe('0.3.7');
    expect(cleanVersion('v1.2.3-alpha.1+build')).toBe('1.2.3');
    expect(cleanVersion(null)).toBe('0.0.0');
    expect(cleanVersion('')).toBe('0.0.0');
  });

  it('parseSemver returns [major, minor, patch]', () => {
    expect(parseSemver('v0.3.7')).toEqual([0, 3, 7]);
    expect(parseSemver('1.2')).toEqual([1, 2, 0]);
    expect(parseSemver('2')).toEqual([2, 0, 0]);
    expect(parseSemver('')).toEqual([0, 0, 0]);
  });

  it('compareSemver compares versions accurately', () => {
    expect(compareSemver('0.3.7', '0.3.8')).toBeLessThan(0);
    expect(compareSemver('0.4.0', '0.3.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('v0.3.7', '0.3.7')).toBe(0);
    expect(compareSemver('0.3.7', 'v0.3.7')).toBe(0);
  });

  it('detectUpgradeKind detects major, minor, patch and same', () => {
    expect(detectUpgradeKind('0.3.7', '1.0.0')).toBe('major');
    expect(detectUpgradeKind('0.3.7', '0.4.0')).toBe('minor');
    expect(detectUpgradeKind('0.3.7', '0.3.8')).toBe('patch');
    expect(detectUpgradeKind('0.3.7', '0.3.7')).toBe('same');
    expect(detectUpgradeKind('0.3.7', '0.3.6')).toBe('downgrade');
  });

  it('getUpgradeKindLabel translates to readable Chinese labels', () => {
    expect(getUpgradeKindLabel('major')).toBe('重大更新');
    expect(getUpgradeKindLabel('minor')).toBe('功能更新');
    expect(getUpgradeKindLabel('patch')).toBe('修复补丁');
    expect(getUpgradeKindLabel('same')).toBe('');
  });
});

describe('generateVersionTip logic', () => {
  it('generates accurate tips for available update (patch update)', () => {
    const tip = generateVersionTip({
      currentVersion: '0.3.7',
      latestVersion: '0.3.8',
      phase: 'available',
    });

    expect(tip.hasUpdate).toBe(true);
    expect(tip.displayCurrentVersion).toBe('v0.3.7');
    expect(tip.displayLatestVersion).toBe('v0.3.8');
    expect(tip.upgradeKind).toBe('patch');
    expect(tip.upgradeKindLabel).toBe('修复补丁');
    expect(tip.shortLabel).toBe('可更新至 v0.3.8');
    expect(tip.bannerTitle).toBe('发现新版本 v0.3.8（当前 v0.3.7）');
    expect(tip.bannerDescription).toContain('修复补丁');
    expect(tip.badgeType).toBe('warning');
  });

  it('generates accurate tips for available update (minor feature update)', () => {
    const tip = generateVersionTip({
      currentVersion: 'v0.3.7',
      latestVersion: 'v0.4.0',
      phase: 'available',
    });

    expect(tip.hasUpdate).toBe(true);
    expect(tip.upgradeKind).toBe('minor');
    expect(tip.upgradeKindLabel).toBe('功能更新');
    expect(tip.shortLabel).toBe('可更新至 v0.4.0');
    expect(tip.bannerTitle).toBe('发现新版本 v0.4.0（当前 v0.3.7）');
    expect(tip.bannerDescription).toContain('功能更新');
  });

  it('generates accurate tips for downloading phase', () => {
    const tip = generateVersionTip({
      currentVersion: '0.3.7',
      latestVersion: '0.3.8',
      phase: 'downloading',
      progress: { percent: 45.6, transferred: 1000, total: 2000, bytesPerSecond: 500 },
    });

    expect(tip.hasUpdate).toBe(true);
    expect(tip.shortLabel).toBe('下载中 45%');
    expect(tip.bannerTitle).toBe('正在下载新版本 v0.3.8 (45%)');
    expect(tip.badgeType).toBe('warning');
  });

  it('generates accurate tips for downloaded phase', () => {
    const tip = generateVersionTip({
      currentVersion: '0.3.7',
      latestVersion: '0.3.8',
      phase: 'downloaded',
    });

    expect(tip.hasUpdate).toBe(true);
    expect(tip.shortLabel).toBe('v0.3.8 已就绪');
    expect(tip.bannerTitle).toBe('新版本 v0.3.8 已下载就绪，点击安装并重启');
    expect(tip.badgeType).toBe('success');
  });

  it('generates accurate tips for checking phase', () => {
    const tip = generateVersionTip({
      currentVersion: '0.3.7',
      phase: 'checking',
      isChecking: true,
    });

    expect(tip.hasUpdate).toBe(false);
    expect(tip.shortLabel).toBe('检查中…');
    expect(tip.badgeType).toBe('info');
  });

  it('generates accurate tips for up-to-date phase', () => {
    const tip = generateVersionTip({
      currentVersion: '0.3.7',
      latestVersion: '0.3.7',
      phase: 'up-to-date',
    });

    expect(tip.hasUpdate).toBe(false);
    expect(tip.shortLabel).toBe('v0.3.7 · 已是最新');
    expect(tip.bannerTitle).toBe('当前已是最新版本 (v0.3.7)');
    expect(tip.badgeType).toBe('neutral');
  });

  it('generates accurate tips for error phase', () => {
    const tip = generateVersionTip({
      currentVersion: '0.3.7',
      phase: 'error',
      error: '网络连接超时',
    });

    expect(tip.hasUpdate).toBe(false);
    expect(tip.shortLabel).toBe('v0.3.7 · 检查失败');
    expect(tip.bannerDescription).toBe('网络连接超时');
    expect(tip.badgeType).toBe('error');
  });

  it('generates accurate fallback tips for idle/unsupported', () => {
    const idleTip = generateVersionTip({ currentVersion: '0.3.7', phase: 'idle' });
    expect(idleTip.shortLabel).toBe('v0.3.7');
    expect(idleTip.hasUpdate).toBe(false);

    const unsupTip = generateVersionTip({ currentVersion: '0.3.7', phase: 'unsupported' });
    expect(unsupTip.shortLabel).toBe('v0.3.7');
    expect(unsupTip.hasUpdate).toBe(false);
  });
});
