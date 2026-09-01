/**
 * KnowledgeSettingsCard - 知识库设置卡片（T7，04 §4.3 / §7.2）
 *
 * 字段（与 server Config 对齐）：
 *   - knowledgeBaseRoot（本地根目录，B4 配合点）
 *   - pollIntervalMinutes（轮询间隔，5-1440）
 *   - larkCliPath（可选）
 *
 * 修复要点（2026-06-22 settings-entry-fix）：
 *  1. config=null 时显示骨架占位（不再 return null），避免 API 401/加载中
 *     时整张卡片不渲染，让用户始终看见"配置入口存在"。
 *  2. 本地根目录支持 Electron desktop.openDataDirectory 打开 userData 目录
 *     作为便捷跳转（不做文件夹选择 dialog——server/desktop API 未暴露该 IPC，
 *     避免误承诺，用户可粘贴绝对路径）。
 *  3. 保存仅传 knowledgeBaseRoot/pollIntervalMinutes/larkCliPath，绝不回传
 *     llm（避免把 server GET 时 mask 成 '***' 的 apiKey 写回）。同步根 URL、
 *     本地目录和布局统一由 WatchedRootsCard 管理。
 */

import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Database, Loader2, AlertCircle } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { Button } from './common/Button';
import { Input, Range } from './common/Input';
import { useConfig } from '../hooks/useConfig';
import { useToast } from './common/Toast';
import type { Config } from '../types';

export function KnowledgeSettingsCard() {
  const { config, loading, error, saving, updateConfig } = useConfig();
  const toast = useToast();
  const [local, setLocal] = useState<Partial<Config>>({});

  useEffect(() => {
    if (config) {
      setLocal(config);
    }
  }, [config]);

  const viewState: 'loading' | 'error' | 'ready' = loading
    ? 'loading'
    : config
      ? 'ready'
      : error
        ? 'error'
        : 'loading';

  const cur: Config | null = useMemo(() => {
    if (!config) return null;
    return { ...config, ...local } as Config;
  }, [config, local]);

  const set = <K extends keyof Config>(k: K, v: Config[K]) => {
    setLocal((p) => ({ ...p, [k]: v }));
  };

  const handleSave = async () => {
    if (!cur) return;

    try {
      // Only send the non-root knowledge-base fields. NEVER send llm — the
      // server GET masks apiKey to '***', and sending it back would
      // overwrite the user's real key.
      await updateConfig({
        knowledgeBaseRoot: (cur.knowledgeBaseRoot ?? '').trim(),
        pollIntervalMinutes: cur.pollIntervalMinutes,
        larkCliPath: cur.larkCliPath?.trim() || undefined,
      });
      toast.push({ type: 'success', message: '已保存知识库设置' });
    } catch (err) {
      toast.push({
        type: 'error',
        message: '保存失败',
        hint: err instanceof Error ? err.message : '',
      });
    }
  };

  const handleOpenDataDir = async () => {
    if (typeof window !== 'undefined' && window.desktop?.openDataDirectory) {
      try {
        const res = await window.desktop.openDataDirectory();
        // 2026-09：DesktopActionResult 对齐为 electron 真实形状 {ok, code?, error?}。
        // 旧代码读 res.success（旧前端类型的字段，主进程从未返回过），
        // 导致每次打开目录成功也会弹「打开目录失败」警告。
        if (!res.ok) {
          toast.push({
            type: 'warning',
            message: '打开目录失败',
            hint: res.ok === false ? res.error : '请检查路径是否已配置',
          });
        }
      } catch (err) {
        toast.push({
          type: 'error',
          message: '打开目录失败',
          hint: err instanceof Error ? err.message : '',
        });
      }
    } else {
      toast.push({
        type: 'info',
        message: '当前运行环境不支持打开目录',
        hint: '请直接复制粘贴本地根目录绝对路径',
      });
    }
  };

  // ===========================================================================
  // Render branches
  // ===========================================================================

  if (viewState === 'loading') {
    return (
      <Card variant="elevated">
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <Database className="w-4 h-4 text-seal" />
            <h2 className="text-base font-kai font-medium text-ink">知识库设置</h2>
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="flex items-center gap-2 text-sm text-ink-faint">
            <Loader2 className="w-4 h-4 animate-spin" />
            正在加载配置…
          </div>
          <div className="space-y-2">
            <div className="h-9 rounded-md bg-paper-2 animate-pulse" />
            <div className="h-9 rounded-md bg-paper-2 animate-pulse" />
            <div className="h-9 rounded-md bg-paper-2 animate-pulse w-2/3" />
          </div>
        </CardBody>
      </Card>
    );
  }

  if (viewState === 'error' || !cur) {
    return (
      <Card variant="elevated">
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <Database className="w-4 h-4 text-seal" />
            <h2 className="text-base font-kai font-medium text-ink">知识库设置</h2>
          </div>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="flex items-start gap-2 text-sm text-seal-2 bg-seal-2/5 border border-seal-2/30 rounded-md p-3">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">无法加载配置</p>
              <p className="text-xs text-ink-soft mt-1">{error || '配置服务暂不可用'}</p>
              <p className="text-xs text-ink-faint mt-1">
                若在浏览器开发模式下访问，请确保后端已启动并通过桌面 token 鉴权。
              </p>
            </div>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <Database className="w-4 h-4 text-seal" />
          <h2 className="text-base font-kai font-medium text-ink">知识库设置</h2>
        </div>
      </CardHeader>
      <CardBody className="space-y-5">
        {/* Local root directory */}
        <div>
          <label className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">
            本地根目录
          </label>
          <div className="flex gap-2">
            <Input
              fullWidth
              type="text"
              value={cur.knowledgeBaseRoot ?? ''}
              onChange={(e) => set('knowledgeBaseRoot', e.target.value)}
              placeholder="D:\WorkPace\公司知识库\飞书同步知识库"
            />
            <Button
              variant="secondary"
              size="md"
              onClick={handleOpenDataDir}
              title="打开当前配置的数据目录（userData）"
            >
              <FolderOpen className="w-4 h-4" />
              打开目录
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-ink-faint font-serif">
            本地知识库的根目录绝对路径。同步会将飞书文档写入此目录。
          </p>
        </div>

        <div className="rounded-md border border-line bg-card-bg p-3 text-xs text-ink-faint font-serif">
          飞书同步根目录（URL、本地目录和布局）请在下方“同步根目录与布局”卡片中统一管理。
        </div>

        {/* Poll interval */}
        <Range
          label="轮询间隔（分钟）"
          min="5"
          max="1440"
          step="5"
          value={String(cur.pollIntervalMinutes)}
          onChange={(e) => set('pollIntervalMinutes', parseInt(e.target.value, 10) || 30)}
          helperText="范围 5-1440 分钟；默认 30 分钟"
        />

        {/* lark-cli path */}
        <Input
          label="lark-cli 路径（可选）"
          type="text"
          value={cur.larkCliPath ?? ''}
          onChange={(e) => set('larkCliPath', e.target.value || undefined)}
          placeholder="留空则使用系统 PATH"
        />

        <div className="flex justify-end pt-3 border-t border-line">
          <Button onClick={handleSave} loading={saving}>
            保存设置
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
