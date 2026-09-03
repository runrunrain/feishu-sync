/**
 * versionTip - 版本号比较与更新提示文案生成工具
 *
 * 遵循语义化版本规范 (SemVer)，支持从当前版本与目标版本
 * 推导更新级别（主版本/功能版本/补丁修复），并生成各种更新相位
 * （idle / checking / available / up-to-date / downloading / downloaded / error）
 * 下清晰、友好且以版本号为核心的提示信息。
 */

import type { DesktopDownloadProgress, DesktopUpdatePhase } from '../types';

/**
 * 规范化版本号字符串，确保统一前缀 'v'。
 * 如 '0.3.7' -> 'v0.3.7'，'v1.0.0' -> 'v1.0.0'。
 */
export function formatVersionTag(version?: string | null): string {
  if (!version || typeof version !== 'string') return '';
  const trimmed = version.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed : `v${trimmed}`;
}

/**
 * 提取纯数字版本号部分（去除 'v' 前缀与预发布元数据）。
 * 如 'v0.3.7-beta.1' -> '0.3.7'。
 */
export function cleanVersion(version?: string | null): string {
  if (!version || typeof version !== 'string') return '0.0.0';
  const trimmed = version.trim().replace(/^[vV]/, '');
  const mainPart = trimmed.split('-')[0].split('+')[0];
  return mainPart || '0.0.0';
}

/**
 * 解析 SemVer 为 [major, minor, patch] 三元组。
 */
export function parseSemver(version?: string | null): [number, number, number] {
  const cleaned = cleanVersion(version);
  const parts = cleaned.split('.').map((p) => {
    const num = Number.parseInt(p, 10);
    return Number.isFinite(num) ? Math.max(0, num) : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * 比较两个版本号：
 * 返回 > 0 表示 v1 > v2；< 0 表示 v1 < v2；0 表示两者相等。
 */
export function compareSemver(v1?: string | null, v2?: string | null): number {
  const [a1, b1, c1] = parseSemver(v1);
  const [a2, b2, c2] = parseSemver(v2);
  if (a1 !== a2) return a1 - a2;
  if (b1 !== b2) return b1 - b2;
  return c1 - c2;
}

export type UpgradeKind = 'major' | 'minor' | 'patch' | 'same' | 'downgrade';

/**
 * 推导版本升级类型：
 * - major: 主版本更新（如 0.3.7 -> 1.0.0）
 * - minor: 次版本功能更新（如 0.3.7 -> 0.4.0）
 * - patch: 补丁修复更新（如 0.3.7 -> 0.3.8）
 * - same: 版本一致
 * - downgrade: 目标版本低于当前版本
 */
export function detectUpgradeKind(current?: string | null, target?: string | null): UpgradeKind {
  const diff = compareSemver(target, current);
  if (diff === 0) return 'same';
  if (diff < 0) return 'downgrade';

  const [curMajor, curMinor] = parseSemver(current);
  const [tarMajor, tarMinor] = parseSemver(target);

  if (tarMajor > curMajor) return 'major';
  if (tarMinor > curMinor) return 'minor';
  return 'patch';
}

export function getUpgradeKindLabel(kind: UpgradeKind): string {
  switch (kind) {
    case 'major':
      return '重大更新';
    case 'minor':
      return '功能更新';
    case 'patch':
      return '修复补丁';
    case 'same':
    case 'downgrade':
    default:
      return '';
  }
}

export interface VersionTipOptions {
  currentVersion?: string | null;
  latestVersion?: string | null;
  phase?: DesktopUpdatePhase;
  progress?: DesktopDownloadProgress;
  error?: string;
  isChecking?: boolean;
}

export interface VersionTip {
  /** 当前规范化版本标签，如 'v0.3.7' */
  displayCurrentVersion: string;
  /** 目标最新规范化版本标签，如 'v0.3.8'（若无则空字符串） */
  displayLatestVersion: string;
  /** 升级类型 */
  upgradeKind: UpgradeKind;
  /** 升级类型中文标签，如 '功能更新' / '修复补丁' */
  upgradeKindLabel: string;
  /** 是否存在更高版本可用 */
  hasUpdate: boolean;
  /** 紧凑状态栏入口显示的短标签文本，如 'v0.3.7' / '可更新至 v0.3.8' / '检查中…' */
  shortLabel: string;
  /** 当前状态的核心说明，如 '发现新版本' / '已是最新版本' / '正在下载更新' */
  statusText: string;
  /** 悬停时的详细 Tooltip 文本（多行） */
  tooltip: string;
  /** 醒目横幅标题，如 '发现新版本 v0.3.8（当前 v0.3.7）' */
  bannerTitle: string;
  /** 醒目横幅描述文案 */
  bannerDescription: string;
  /** 视觉色彩徽标分类 */
  badgeType: 'neutral' | 'success' | 'warning' | 'info' | 'error';
}

/**
 * 根据当前版本号、目标版本号和更新相位状态，生成结构化的版本更新提示。
 */
export function generateVersionTip(options: VersionTipOptions): VersionTip {
  const {
    currentVersion,
    latestVersion,
    phase = 'idle',
    progress,
    error,
    isChecking = false,
  } = options;

  const curTag = formatVersionTag(currentVersion) || 'v0.0.0';
  const latTag = formatVersionTag(latestVersion);
  const upgradeKind = latestVersion ? detectUpgradeKind(currentVersion, latestVersion) : 'same';
  const upgradeKindLabel = getUpgradeKindLabel(upgradeKind);

  // 1. 正在检查中
  if (isChecking || phase === 'checking') {
    return {
      displayCurrentVersion: curTag,
      displayLatestVersion: latTag,
      upgradeKind: 'same',
      upgradeKindLabel: '',
      hasUpdate: false,
      shortLabel: '检查中…',
      statusText: '正在检查更新…',
      tooltip: `当前版本：${curTag}\n正在与云端比对最新版本…`,
      bannerTitle: `正在检查更新 (${curTag})`,
      bannerDescription: '正在向更新服务请求版本清单，请稍候…',
      badgeType: 'info',
    };
  }

  // 2. 下载中
  if (phase === 'downloading') {
    const percent = Math.floor(progress?.percent ?? 0);
    const progressText = percent > 0 ? `${percent}%` : '准备中';
    return {
      displayCurrentVersion: curTag,
      displayLatestVersion: latTag,
      upgradeKind,
      upgradeKindLabel,
      hasUpdate: true,
      shortLabel: `下载中 ${progressText}`,
      statusText: `新版本 ${latTag || '更新'} 下载中 (${progressText})`,
      tooltip: `当前版本：${curTag}\n正在下载最新版本：${latTag}\n已完成：${progressText}`,
      bannerTitle: `正在下载新版本 ${latTag} (${progressText})`,
      bannerDescription: `正在后台下载 ${latTag} 更新包，当前版本为 ${curTag}。下载完成后可一键安装重启。`,
      badgeType: 'warning',
    };
  }

  // 3. 已下载，可安装
  if (phase === 'downloaded') {
    return {
      displayCurrentVersion: curTag,
      displayLatestVersion: latTag,
      upgradeKind,
      upgradeKindLabel,
      hasUpdate: true,
      shortLabel: `${latTag || '新版本'} 已就绪`,
      statusText: `新版本 ${latTag || ''} 下载完成，可安装`,
      tooltip: `当前版本：${curTag}\n最新版本：${latTag}（${upgradeKindLabel || '可更新'}）\n安装包已下载就绪，点击安装并重启应用。`,
      bannerTitle: `新版本 ${latTag} 已下载就绪，点击安装并重启`,
      bannerDescription: `新版本安装包已准备完成。当前运行版本为 ${curTag}，请保存正在进行的工作后重启安装。`,
      badgeType: 'success',
    };
  }

  // 4. 发现新版本（可用）
  if (phase === 'available') {
    const kindSuffix = upgradeKindLabel ? ` · ${upgradeKindLabel}` : '';
    return {
      displayCurrentVersion: curTag,
      displayLatestVersion: latTag,
      upgradeKind,
      upgradeKindLabel,
      hasUpdate: true,
      shortLabel: `可更新至 ${latTag}`,
      statusText: `发现新版本 ${latTag}`,
      tooltip: `当前版本：${curTag}\n最新版本：${latTag}${kindSuffix}\n点击快捷前往查看更新详情与下载。`,
      bannerTitle: `发现新版本 ${latTag}（当前 ${curTag}）`,
      bannerDescription: `检测到云端有新版本 ${latTag}${upgradeKindLabel ? `（${upgradeKindLabel}）` : ''}，建议及时升级以获取最新功能与稳定性改进。`,
      badgeType: 'warning',
    };
  }

  // 5. 检查失败
  if (phase === 'error') {
    return {
      displayCurrentVersion: curTag,
      displayLatestVersion: latTag,
      upgradeKind: 'same',
      upgradeKindLabel: '',
      hasUpdate: false,
      shortLabel: `${curTag} · 检查失败`,
      statusText: '更新检查失败',
      tooltip: `当前版本：${curTag}\n更新检查遇到错误：${error || '未知错误'}\n点击重新检查更新。`,
      bannerTitle: `检查更新失败 (${curTag})`,
      bannerDescription: error || '无法连接到更新服务器，请检查网络或稍后再试。',
      badgeType: 'error',
    };
  }

  // 6. 已是最新
  if (phase === 'up-to-date') {
    return {
      displayCurrentVersion: curTag,
      displayLatestVersion: latTag,
      upgradeKind: 'same',
      upgradeKindLabel: '',
      hasUpdate: false,
      shortLabel: `${curTag} · 已是最新`,
      statusText: `已是最新版本 (${curTag})`,
      tooltip: `当前版本：${curTag}\n当前运行的已是最新版本，无需更新。点击可再次检查。`,
      bannerTitle: `当前已是最新版本 (${curTag})`,
      bannerDescription: `当前运行的 ${curTag} 已是最新稳定版本。`,
      badgeType: 'neutral',
    };
  }

  // 7. 不支持或环境受限
  if (phase === 'unsupported') {
    return {
      displayCurrentVersion: curTag,
      displayLatestVersion: latTag,
      upgradeKind: 'same',
      upgradeKindLabel: '',
      hasUpdate: false,
      shortLabel: curTag,
      statusText: `当前版本 ${curTag}`,
      tooltip: `当前版本：${curTag}\n应用内更新仅在桌面安装包中可用。`,
      bannerTitle: `当前版本 ${curTag}`,
      bannerDescription: '当前运行环境不支持应用内更新，可前往发布页手动下载。',
      badgeType: 'neutral',
    };
  }

  // 8. 默认空闲（idle）
  return {
    displayCurrentVersion: curTag,
    displayLatestVersion: latTag,
    upgradeKind: 'same',
    upgradeKindLabel: '',
    hasUpdate: false,
    shortLabel: curTag,
    statusText: `当前版本 ${curTag}`,
    tooltip: `当前版本：${curTag}\n点击检查更新或查看版本设置。`,
    bannerTitle: `当前版本 ${curTag}`,
    bannerDescription: '点击快捷检查是否有新版本发布。',
    badgeType: 'neutral',
  };
}
