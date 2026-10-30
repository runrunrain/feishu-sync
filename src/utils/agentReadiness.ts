/**
 * Agent 就绪码 → 用户可读文案（设计 §3.2）
 *
 * 三处消费：对话页未就绪禁用态、标准库页空状态、设置页 Agent 段状态行。
 * 文案方向按设计表；带 runtime 细节（版本/路径/stderr 摘要）时拼接展示，
 * 不掩盖失败原因，也不假装就绪。
 */

import type { AgentStatusDto, ReadinessCode } from '../types/agent';

export interface ReadinessCopy {
  /** 一句话原因（用于禁用态主文案）。 */
  reason: string;
  /** 建议动作说明（如何恢复）。 */
  action: string;
  /** 是否值得展示「前往设置」跳转（模型/路径配置类问题）。 */
  jumpSettings: boolean;
  /** 是否值得展示「重新检测」（环境可能已变化）。 */
  recheck: boolean;
}

export function describeReadinessCode(code: ReadinessCode, status?: AgentStatusDto): ReadinessCopy {
  const rt = status?.runtime;
  const model = status?.model;
  switch (code) {
    case 'ready':
      return { reason: 'Agent 运行时与模型已就绪', action: '', jumpSettings: false, recheck: false };
    case 'node_missing':
      return {
        reason: '未找到 Node.js',
        action: '安装 Node 22.19 或更高版本，或在设置中填写 node 可执行文件路径',
        jumpSettings: true,
        recheck: true,
      };
    case 'node_too_old':
      return {
        reason: `Node 版本过低${rt?.nodeVersion ? `（当前 ${rt.nodeVersion}）` : ''}`,
        action: '需要 22.19 或更高版本；或改用其他已安装的 Node 路径',
        jumpSettings: true,
        recheck: true,
      };
    case 'pi_missing':
      return {
        reason: '未找到 pi 包',
        action: '运行 npm i -g @earendil-works/pi-coding-agent 安装，或在设置中指定 pi 路径',
        jumpSettings: true,
        recheck: true,
      };
    case 'pi_version_unsupported':
      return {
        reason: `pi 版本不在支持范围${rt?.piVersion ? `（当前 ${rt.piVersion}）` : ''}`,
        action: `支持范围 ${rt?.supportedRange ?? '>=1.4.0 <2.0.0'}；请升级或降级 pi`,
        jumpSettings: true,
        recheck: true,
      };
    case 'pi_spawn_failed':
      return {
        reason: 'pi 进程启动失败',
        action: status?.message ? status.message.slice(0, 300) : '查看设置页诊断信息或重新检测',
        jumpSettings: true,
        recheck: true,
      };
    case 'claude_missing':
      return { reason: '未找到 Claude Code', action: '安装 Claude Code，或在设置中指定其可执行文件路径', jumpSettings: true, recheck: true };
    case 'claude_spawn_failed':
      return { reason: 'Claude Code 不可用', action: status?.message ?? '检查路径和版本后重新检测', jumpSettings: true, recheck: true };
    case 'claude_protocol_unsupported':
      return { reason: '提供商协议不兼容', action: '选择 Anthropic Messages 兼容的应用内服务提供商和模型预设', jumpSettings: true, recheck: true };
    case 'model_unconfigured':
      return {
        reason: model?.source === 'pi-agent-dir' ? '未指定 pi 模型' : '应用内未配置模型',
        action:
          model?.source === 'pi-agent-dir'
            ? '在设置中选择 provider/model 格式的 pi 模型'
            : '前往「服务提供商与模型」配置提供商，或在 Agent 设置中选择模型来源',
        jumpSettings: true,
        recheck: true,
      };
    case 'model_auth_missing':
      return {
        reason: '模型凭据不可用',
        action:
          model?.source === 'pi-agent-dir'
            ? '本机 pi 凭据缺失或未登录对应模型；请在本机 pi 中配置'
            : '提供商 API Key 缺失或无效；前往「服务提供商与模型」补全',
        jumpSettings: true,
        recheck: true,
      };
    default:
      return {
        reason: 'Agent 未就绪',
        action: '前往设置查看诊断信息',
        jumpSettings: true,
        recheck: true,
      };
  }
}

/** 构建状态 → 中文（构建抽屉状态条 + 历史列表共用）。 */
export const KB_BUILD_STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  preflight: '预检',
  running: '生成中',
  validating: '校验中',
  publishing: '发布中',
  published: '已发布',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

/** 构建阶段序（进度条 stepper 用；终态不参与连线）。 */
export const KB_BUILD_ACTIVE_STEPS = [
  'queued',
  'preflight',
  'running',
  'validating',
  'publishing',
] as const;

/** S4 §4.6 细粒度阶段 → 中文（progress.stage；DB status 之外的运行时细分）。 */
export const KB_BUILD_STAGE_LABEL: Record<string, string> = {
  snapshot: '源快照',
  describing_images: '图片理解',
  units: '单元生成',
  finishing: '收尾合并',
  validating: '校验',
  publishing: '发布',
};

/** S4 §4.6 worker 状态 → 中文（progress.workers[].state）。 */
export const KB_BUILD_WORKER_STATE_LABEL: Record<string, string> = {
  waiting_slot: '等待进程',
  running: '生成中',
  finishing: '收尾中',
  exited: '已退出',
};

/** S3/S5 构建警告 code → 中文主题（徽标标题用；详情用 DTO 自带 message）。 */
export const KB_BUILD_WARNING_LABEL: Record<string, string> = {
  images_unavailable: '图片未理解',
  images_refresh_incomplete: '图片重新生成未完成',
};

/** 会话状态 → 中文。 */
export const AGENT_SESSION_STATE_LABEL: Record<string, string> = {
  idle: '空闲',
  starting: '启动中',
  streaming: '生成中',
  error: '错误',
};

/** 来源状态徽标文案（§9.2 sources.state）。 */
export const KB_SOURCE_STATE_LABEL: Record<string, string> = {
  current: '当前',
  changed: '已变更',
  missing: '已缺失',
  excluded: '已排除',
};

/** 相对时间（会话列表/构建历史）；只做展示级近似。 */
export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const date = new Date(t);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/** 本地日期时间（发布时间等）。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}
