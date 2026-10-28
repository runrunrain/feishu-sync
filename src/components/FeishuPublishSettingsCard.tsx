/**
 * FeishuPublishSettingsCard —— 设置页「飞书发布」卡（P1-S9，设计 P1 §4.6）。
 *
 *   - feishuPublish.enabled 开关（PUT /api/config；服务端合并保留 target，
 *     CLI 主体禁改由服务端强制）
 *   - 发布根设置：粘贴 Drive 文件夹 / wiki 节点 URL → PUT /api/kb/publish/target
 *     （专用端点，仅 desktop token；服务端即时双向校验——发布根在监听树内、
 *     监听树在发布根内、无法校验均拒绝并给出可读文案）
 *   - 清除发布根（两步确认）
 *
 * 依赖提示：反向发布还需「飞书写入」开启 + 写权限授权（本卡只提示，
 * 授权入口在「飞书写入」卡）。
 */

import { useState } from 'react';
import { CloudUpload, FolderTree, RefreshCw, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { StatusBadge } from './common/StatusBadge';
import { Button } from './common/Button';
import { Toggle } from './common/Input';
import { useToast } from './common/Toast';
import { useConfig } from '../hooks/useConfig';
import { APIError, setKbPublishTarget } from '../api/client';
import { publishTargetKindLabel } from '../utils/kbPublish';

/** 服务端错误码 → 附加提示（message 本身已可读，这里补操作指引）。 */
const TARGET_ERROR_HINTS: Record<string, string> = {
  publish_target_inside_watched_root: '发布根不能位于任何监听（同步）目录子树内：已发布内容会被同步回流，形成自我喂养回路。',
  watched_root_inside_publish_target: '监听目录不能位于发布根内：请先更换发布根或调整监听根。',
  publish_target_unverifiable: '无法解析该节点的祖先链（网络或权限原因）：不能证明与监听目录不重叠即拒绝配置，可改用 Drive 文件夹发布根。',
  invalid_request: '请粘贴 Drive 文件夹链接（…/drive/folder/<token>）或知识库节点链接（…/wiki/<token>）。',
};

export function FeishuPublishSettingsCard() {
  const toast = useToast();
  const { config, updateConfig, refresh } = useConfig();

  const [savingToggle, setSavingToggle] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [savingTarget, setSavingTarget] = useState(false);
  const [targetError, setTargetError] = useState<{ message: string; hint?: string } | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const publish = config?.feishuPublish;
  const enabled = publish?.enabled === true;
  const target = publish?.target ?? null;
  const feishuWriteEnabled = config?.feishuWrite?.enabled === true;

  const handleToggle = async (next: boolean) => {
    setSavingToggle(true);
    try {
      await updateConfig({ feishuPublish: { enabled: next } });
      toast.push({ type: 'success', message: next ? '已开启反向发布' : '已关闭反向发布' });
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '设置保存失败' });
    } finally {
      setSavingToggle(false);
    }
  };

  const parseTargetError = (err: unknown): { message: string; hint?: string } => {
    if (err instanceof APIError) {
      const code = (err.response as { error?: string } | undefined)?.error;
      return { message: err.message, hint: code ? TARGET_ERROR_HINTS[code] : undefined };
    }
    return { message: '发布根保存失败' };
  };

  const saveTarget = async () => {
    const url = urlInput.trim();
    if (!url) return;
    setSavingTarget(true);
    setTargetError(null);
    try {
      const result = await setKbPublishTarget({ url });
      setUrlInput('');
      await refresh();
      toast.push({
        type: 'success',
        message: result.target
          ? `发布根已校验并保存：${publishTargetKindLabel(result.target.kind)} · ${result.target.label}`
          : '发布根已保存',
      });
    } catch (err) {
      setTargetError(parseTargetError(err));
    } finally {
      setSavingTarget(false);
    }
  };

  const clearTarget = async () => {
    setClearing(true);
    setTargetError(null);
    try {
      await setKbPublishTarget({ target: null });
      await refresh();
      setConfirmingClear(false);
      toast.push({ type: 'info', message: '已清除发布根' });
    } catch (err) {
      setTargetError(parseTargetError(err));
    } finally {
      setClearing(false);
    }
  };

  return (
    <Card variant="elevated">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <CloudUpload className="w-4 h-4 text-seal" />
          <h2 className="text-base font-kai font-medium text-ink">飞书发布</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()}>
          <RefreshCw className="w-3.5 h-3.5" />
          重新加载
        </Button>
      </CardHeader>

      <CardBody className="space-y-4">
        <p className="text-xs text-ink-soft leading-relaxed">
          把标准库文档反向发布为飞书云文档（在发布根下逐篇平铺创建，可继续以「更新」同步）。
          发布内容不会回流：发布根必须位于所有监听（同步）目录之外，保存时即时双向校验。
        </p>

        <Toggle
          label="允许发布到飞书"
          checked={enabled}
          disabled={savingToggle}
          onChange={(value) => void handleToggle(value)}
          helperText="关闭后已发布的云端文档保留在飞书，重新开启后可继续更新而不必重建"
        />

        {!feishuWriteEnabled ? (
          <p className="text-xs text-[#8a6508] leading-relaxed">
            反向发布依赖「飞书写入」开关与写权限（docx:document:write_only）：请先在本组「飞书写入」卡开启并授权。
          </p>
        ) : null}

        <div className="space-y-2 border-t border-line pt-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-sm text-ink">
              <FolderTree className="w-3.5 h-3.5 text-jade" />
              发布根
            </h3>
            {target ? (
              <StatusBadge status="success" size="sm">已校验</StatusBadge>
            ) : (
              <StatusBadge status="warning" size="sm">未配置</StatusBadge>
            )}
          </div>

          {target ? (
            <div className="rounded-md border border-line bg-paper/40 p-3 space-y-1.5" data-testid="publish-target-current">
              <p className="text-sm text-ink">{target.label}</p>
              <p className="text-xs text-ink-soft">{publishTargetKindLabel(target.kind)}</p>
              <p className="font-mono text-[10px] break-all text-ink-faint">{target.token}</p>
              <div className="flex items-center gap-2 pt-1">
                {confirmingClear ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setConfirmingClear(false)} disabled={clearing}>取消</Button>
                    <Button size="sm" onClick={() => void clearTarget()} loading={clearing}>
                      <Trash2 className="w-3.5 h-3.5" />确认清除
                    </Button>
                    <span className="text-xs text-ink-faint">清除后发布功能暂停，已发布文档保留</span>
                  </>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setConfirmingClear(true)}>
                    <Trash2 className="w-3.5 h-3.5" />清除发布根
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <p className="text-xs text-ink-faint leading-relaxed">
              尚未配置发布根。发布前需要先在这里选择并校验目标位置。
            </p>
          )}

          <div className="space-y-1.5">
            <label htmlFor="publish-target-url" className="text-xs text-ink-soft">
              粘贴飞书链接设置发布根（Drive 文件夹或知识库节点）
            </label>
            <div className="flex gap-2">
              <input
                id="publish-target-url"
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                placeholder="https://xxx.feishu.cn/drive/folder/… 或 https://xxx.feishu.cn/wiki/…"
                className="flex-1 min-w-0 h-8 px-3 text-xs rounded border border-line bg-card-bg text-ink placeholder:text-ink-faint focus:outline-none focus:border-seal/50"
                spellCheck={false}
              />
              <Button size="sm" onClick={() => void saveTarget()} loading={savingTarget} disabled={!urlInput.trim()}>
                校验并保存
              </Button>
            </div>
            {targetError ? (
              <div role="alert" className="rounded border border-seal-2/40 bg-seal-2/5 p-2 space-y-1" data-testid="publish-target-error">
                <p className="text-xs text-seal-2 leading-relaxed">{targetError.message}</p>
                {targetError.hint ? <p className="text-xs text-seal-2/80 leading-relaxed">{targetError.hint}</p> : null}
              </div>
            ) : null}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
