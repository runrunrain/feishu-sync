/**
 * FeishuPublishSettingsCard —— 设置页「飞书发布」卡（P1-S9，设计 P1 §4.6）。
 *
 *   - feishuPublish.enabled 开关（PUT /api/config；服务端合并保留 target，
 *     CLI 主体禁改由服务端强制）
 *   - 发布根设置：粘贴 Drive 文件夹 / wiki 节点 URL，纳入统一配置草稿。
 *     顶部保存时服务端联合校验发布根与同步根，无法校验或存在重叠时拒绝。
 *   - 清除发布根（两步确认）
 *
 * 依赖提示：反向发布还需「飞书写入」开启 + 写权限授权（本卡只提示，
 * 授权入口在「飞书写入」卡）。
 */

import { useEffect, useState } from 'react';
import { CloudUpload, FolderTree, RefreshCw, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { StatusBadge } from './common/StatusBadge';
import { Button } from './common/Button';
import { Toggle } from './common/Input';
import { useToast } from './common/Toast';
import { useConfig } from '../hooks/useConfig';
import { useSettingsDraft, useSettingsForm } from '../hooks/settingsDraft';
import { APIError } from '../api/client';
import { publishTargetKindLabel } from '../utils/kbPublish';

export function FeishuPublishSettingsCard() {
  const toast = useToast();
  const { config, updateConfig, refresh } = useConfig();
  const draft = useSettingsDraft();

  const [savingToggle, setSavingToggle] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [confirmingClear, setConfirmingClear] = useState(false);

  const publish = config?.feishuPublish;
  const enabled = publish?.enabled === true;
  const target = publish?.target ?? null;
  const feishuWriteEnabled = config?.feishuWrite?.enabled === true;
  useEffect(() => { setUrlInput(''); }, [target?.kind, target?.token]);
  useSettingsForm('auth-feishu-publish', () => {
    const url = urlInput.trim();
    if (!url) return null;
    const drive = /\/drive\/folder\/([A-Za-z0-9]{8,64})/.exec(url);
    const wiki = /\/wiki\/([A-Za-z0-9]{8,64})/.exec(url);
    if (!drive && !wiki) throw new Error('飞书发布：请输入有效的 Drive 文件夹或知识库节点链接');
    const nextTarget = { kind: drive ? 'drive_folder' as const : 'wiki_node' as const, token: (drive ?? wiki)![1], label: url.slice(0, 200) };
    return { feishuPublish: { enabled, target: nextTarget } };
  });

  const handleToggle = async (next: boolean) => {
    setSavingToggle(true);
    try {
      await updateConfig({ feishuPublish: { enabled: next } });
      if (!draft) toast.push({ type: 'success', message: next ? '已开启反向发布' : '已关闭反向发布' });
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '设置保存失败' });
    } finally {
      setSavingToggle(false);
    }
  };

  const clearTarget = async () => {
    try {
      await updateConfig({ feishuPublish: { enabled, target: null } });
      setConfirmingClear(false);
      if (!draft) toast.push({ type: 'info', message: '已清除发布根' });
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof Error ? err.message : '清除发布根失败' });
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
              <StatusBadge status={draft?.dirty ? 'warning' : 'success'} size="sm">{draft?.dirty ? '待保存与校验' : '已校验'}</StatusBadge>
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
                    <Button size="sm" variant="secondary" onClick={() => setConfirmingClear(false)}>取消</Button>
                    <Button size="sm" onClick={() => void clearTarget()}>
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
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
