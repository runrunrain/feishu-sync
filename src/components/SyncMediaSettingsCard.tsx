/**
 * SyncMediaSettingsCard —— 设置页「同步媒体选项」卡（P2-S3）
 *
 * 消费 server 契约（均为 additive sync 段，PUT 子段级 merge）：
 *   - P1-S5 sync.slidesScreenshot { enabled }（缺省 false；实际采集还需
 *     当前授权含 slides:presentation:screenshot —— auth-status 的
 *     optionalScopes.missing 非空时显示「需在飞书认证时授权」引导文案，
 *     未授权期间同步侧合法跳过并记警告，不阻断文档同步）。
 *   - P0-S6 sync.whiteboardExport { enabled, svgTimeoutMs? }（缺省
 *     enabled=true；svg 旁路失败自动降级 raw，永不阻断同步）。
 *
 * 视觉与交互复用既有设置卡模式（FeishuWriteSettingsCard 同款）：
 * Toggle 即保存（PUT /api/config），权限状态行 + 徽标；操作链路由
 * server 侧测试与真机浏览器验证覆盖。
 */

import { useEffect, useState } from 'react';
import { ImageIcon, RefreshCw } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { StatusBadge } from './common/StatusBadge';
import { Button } from './common/Button';
import { Toggle } from './common/Input';
import { useToast } from './common/Toast';
import { useConfig } from '../hooks/useConfig';
import { useAuthStatus } from '../hooks/useAuthStatus';
import { APIError } from '../api/client';

/** P1-S5 注册表唯一可选读 scope（server OPTIONAL_READ_SCOPES 首项）。 */
export const SLIDES_SCREENSHOT_SCOPE = 'slides:presentation:screenshot';

/** server 侧 svg 导出超时缺省（P0-S6：缺省回落执行层预算 30s）。 */
export const WHITEBOARD_SVG_TIMEOUT_DEFAULT_MS = 30_000;

/** svgTimeoutMs 输入即时反馈（null = 合法可直接保存）。导出供单测锚定。 */
export function describeSvgTimeoutInput(
  raw: string,
  hasCurrentValue: boolean,
): { level: 'hint' | 'error'; text: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      level: 'hint',
      text: hasCurrentValue
        ? `留空保留现值；服务端默认 ${WHITEBOARD_SVG_TIMEOUT_DEFAULT_MS / 1000} 秒`
        : `留空使用默认 ${WHITEBOARD_SVG_TIMEOUT_DEFAULT_MS / 1000} 秒（${WHITEBOARD_SVG_TIMEOUT_DEFAULT_MS} 毫秒）`,
    };
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) {
    return { level: 'error', text: '请输入正整数（毫秒）' };
  }
  return { level: 'hint', text: '仅影响客户端等待上限；飞书侧服务超时更短时会提前返回并自动降级' };
}

export function SyncMediaSettingsCard() {
  const toast = useToast();
  const { config, updateConfig, saving } = useConfig();
  const { authStatus, loading: authLoading, refresh } = useAuthStatus(0);

  const [savingSlides, setSavingSlides] = useState(false);
  const [savingWb, setSavingWb] = useState(false);
  const [svgTimeoutInput, setSvgTimeoutInput] = useState('');
  const [savingSvgTimeout, setSavingSvgTimeout] = useState(false);

  useEffect(() => {
    const value = config?.sync?.whiteboardExport?.svgTimeoutMs;
    setSvgTimeoutInput(value === undefined || value === null ? '' : String(value));
  }, [config?.sync?.whiteboardExport?.svgTimeoutMs]);

  // 缺省语义：slidesScreenshot 缺省关闭；whiteboardExport 缺省开启（仅显式 false 关闭）。
  const slidesEnabled = config?.sync?.slidesScreenshot?.enabled === true;
  const wbEnabled = config?.sync?.whiteboardExport?.enabled !== false;
  const wbSvgTimeout = config?.sync?.whiteboardExport?.svgTimeoutMs;

  // P1-S5 契约：optionalScopes { granted, missing }；异常态 missing 全量，形态稳定。
  const optionalScopes = authStatus?.optionalScopes;
  const slidesScopeGranted = optionalScopes?.granted?.includes(SLIDES_SCREENSHOT_SCOPE) ?? false;
  const slidesScopeMissing = optionalScopes?.missing?.includes(SLIDES_SCREENSHOT_SCOPE) ?? false;

  const handleSlidesToggle = async (next: boolean) => {
    setSavingSlides(true);
    try {
      await updateConfig({ sync: { slidesScreenshot: { enabled: next } } });
      toast.push({ type: 'success', message: next ? '已开启幻灯片整页截图' : '已关闭幻灯片整页截图' });
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '设置保存失败' });
    } finally {
      setSavingSlides(false);
    }
  };

  const handleWbToggle = async (next: boolean) => {
    setSavingWb(true);
    try {
      await updateConfig({ sync: { whiteboardExport: { enabled: next } } });
      toast.push({ type: 'success', message: next ? '已开启白板矢量导出' : '已关闭白板矢量导出' });
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '设置保存失败' });
    } finally {
      setSavingWb(false);
    }
  };

  const svgTimeoutFeedback = describeSvgTimeoutInput(svgTimeoutInput, wbSvgTimeout !== undefined);
  const saveSvgTimeout = async () => {
    const trimmed = svgTimeoutInput.trim();
    if (!trimmed) {
      toast.push({ type: 'info', message: '留空即保留现值，无需保存' });
      return;
    }
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value <= 0) {
      toast.push({ type: 'warning', message: '请输入正整数（毫秒）' });
      return;
    }
    setSavingSvgTimeout(true);
    try {
      // server 对 whiteboardExport 子段是 spread merge；显式携带当前 enabled，
      // 避免依赖「省略键保留旧值」的合并细节。
      await updateConfig({ sync: { whiteboardExport: { enabled: wbEnabled, svgTimeoutMs: value } } });
      toast.push({ type: 'success', message: 'SVG 导出超时已保存' });
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '设置保存失败' });
    } finally {
      setSavingSvgTimeout(false);
    }
  };

  return (
    <Card variant="elevated">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <ImageIcon className="w-4 h-4 text-seal" />
          <h2 className="text-base font-kai font-medium text-ink">同步媒体选项</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} loading={authLoading}>
          <RefreshCw className="w-3.5 h-3.5" />
          重新检测
        </Button>
      </CardHeader>

      <CardBody className="space-y-4">
        <p className="text-xs text-ink-soft leading-relaxed">
          媒体采集是同步的旁路能力：采集失败只记录警告，不会阻断文档同步与基线推进。
          变更开关后对下一次同步生效。
        </p>

        {/* ---- 幻灯片整页截图（P1-S5） ---- */}
        <div className="space-y-2.5" data-testid="slides-screenshot-section">
          <Toggle
            label="幻灯片整页截图"
            checked={slidesEnabled}
            disabled={saving || savingSlides}
            onChange={(v) => void handleSlidesToggle(v)}
            ariaLabel="幻灯片整页截图开关"
            helperText="同步幻灯片时逐页采集 PNG 截图存入 images/ 并在正文插入引用；单次采集按页批处理，任一页失败则本文档全部跳过"
          />

          {optionalScopes && (
            <div className="flex items-center justify-between py-1.5 border-b border-line">
              <span className="text-sm text-ink-soft">截图权限（{SLIDES_SCREENSHOT_SCOPE}）</span>
              <div data-testid="slides-scope-badge">
                <StatusBadge
                  status={authLoading ? 'loading' : slidesScopeGranted ? 'success' : 'warning'}
                  size="sm"
                >
                  {authLoading ? '检测中…' : slidesScopeGranted ? '已授权' : '未授权'}
                </StatusBadge>
              </div>
            </div>
          )}

          {slidesEnabled && slidesScopeMissing && !authLoading && (
            <div
              className="p-3 rounded-md border border-seal-2/30 bg-seal-2/5 text-xs text-ink-soft leading-relaxed"
              role="alert"
              data-testid="slides-scope-hint"
            >
              截图采集已开启，但当前飞书授权尚未包含截图权限：请在「飞书认证」中重新认证并同意所请求的权限，之后才会实际采集；
              未授权期间同步会自动跳过截图（记警告），文档正文照常同步。
            </div>
          )}
        </div>

        {/* ---- 白板矢量导出（P0-S6） ---- */}
        <div className="space-y-2.5 pt-1 border-t border-line" data-testid="whiteboard-export-section">
          <Toggle
            label="白板矢量导出"
            checked={wbEnabled}
            disabled={saving || savingWb}
            onChange={(v) => void handleWbToggle(v)}
            ariaLabel="白板矢量导出开关"
            helperText="同步含白板的文档时旁路导出 .wb.svg 矢量文件（SVG 失败自动降级 raw JSON），供标准库构建读取白板文字；不影响正文引用"
          />

          {wbEnabled && (
            <div data-testid="whiteboard-svg-timeout">
              <div className="flex gap-2 items-start">
                <div className="flex-1 min-w-0">
                  <label className="block text-sm font-medium text-ink font-serif mb-1.5">
                    SVG 导出超时（毫秒）
                    <span className="ml-1.5 text-xs font-normal text-ink-faint">高级</span>
                  </label>
                  <input
                    type="number"
                    min={1000}
                    step={1000}
                    className="w-full h-9 px-3 rounded-md border border-line bg-card-bg text-sm text-ink font-mono focus:outline-none focus:border-seal/50"
                    value={svgTimeoutInput}
                    disabled={savingSvgTimeout}
                    onChange={(e) => setSvgTimeoutInput(e.target.value)}
                    placeholder={String(WHITEBOARD_SVG_TIMEOUT_DEFAULT_MS)}
                    aria-label="SVG 导出超时毫秒数"
                    data-testid="whiteboard-svg-timeout-input"
                  />
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={savingSvgTimeout}
                  disabled={svgTimeoutFeedback.level === 'error'}
                  onClick={saveSvgTimeout}
                  className="shrink-0 whitespace-nowrap mt-7"
                >
                  保存
                </Button>
              </div>
              <p
                className={`mt-1 text-xs font-serif ${svgTimeoutFeedback.level === 'error' ? 'text-seal-2' : 'text-ink-faint'}`}
                role={svgTimeoutFeedback.level === 'error' ? 'alert' : undefined}
                data-testid="whiteboard-svg-timeout-feedback"
              >
                {svgTimeoutFeedback.text}
              </p>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
