/**
 * KnowledgeSettingsCard - 知识库设置卡片（T7，04 §4.3 / §7.2）
 *
 * 字段（与 server Config 对齐）：
 *   - knowledgeBaseRoot（本地根目录，B4 配合点）
 *   - watchedRootUrls（飞书根 URL 列表，支持增删）
 *   - pollIntervalMinutes（轮询间隔，5-1440）
 *   - larkCliPath（可选）
 *
 * B4 修正：watchedRootUrls 列表化，移除硬编码 rootUrl。
 * 使用 useConfig 受控保存。
 */

import { useEffect, useState } from 'react';
import { Plus, Trash2, FolderOpen, Database } from 'lucide-react';
import { Card, CardHeader, CardBody } from './common/Card';
import { Button } from './common/Button';
import { Input, Range } from './common/Input';
import { useConfig } from '../hooks/useConfig';
import { useToast } from './common/Toast';
import type { Config } from '../types';

const DEFAULT_URL = 'https://xxx.feishu.cn/wiki/<token>';

export function KnowledgeSettingsCard() {
  const { config, saving, updateConfig } = useConfig();
  const toast = useToast();
  const [local, setLocal] = useState<Partial<Config>>({});

  useEffect(() => {
    if (config) setLocal(config);
  }, [config]);

  if (!config) return null;
  const cur: Config = { ...config, ...local } as Config;

  const set = <K extends keyof Config>(k: K, v: Config[K]) => {
    setLocal((p) => ({ ...p, [k]: v }));
  };

  const handleSave = async (which: string) => {
    try {
      await updateConfig({
        knowledgeBaseRoot: cur.knowledgeBaseRoot,
        watchedRootUrls: cur.watchedRootUrls,
        pollIntervalMinutes: cur.pollIntervalMinutes,
        larkCliPath: cur.larkCliPath,
      });
      toast.push({ type: 'success', message: `${which}已保存` });
    } catch (err) {
      toast.push({ type: 'error', message: '保存失败', hint: err instanceof Error ? err.message : '' });
    }
  };

  const handleOpenDir = async () => {
    if (typeof window !== 'undefined' && window.desktop) {
      try {
        await window.desktop.openDataDirectory();
      } catch (err) {
        toast.push({ type: 'error', message: '打开目录失败', hint: err instanceof Error ? err.message : '' });
      }
    }
  };

  return (
    <Card variant="elevated">
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <Database className="w-4 h-4 text-seal" />
          <h2 className="text-base font-kai font-medium text-ink">知识库设置</h2>
        </div>
      </CardHeader>
      <CardBody className="space-y-4">
        {/* Local root directory */}
        <div>
          <label className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">本地根目录</label>
          <div className="flex gap-2">
            <Input
              fullWidth
              type="text"
              value={cur.knowledgeBaseRoot}
              onChange={(e) => set('knowledgeBaseRoot', e.target.value)}
              placeholder="D:\WorkPace\公司知识库"
            />
            <Button variant="secondary" size="md" onClick={handleOpenDir}>
              <FolderOpen className="w-4 h-4" />
              打开
            </Button>
          </div>
        </div>

        {/* Watched root URLs */}
        <div>
          <label className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">
            飞书根 URL（支持多个）
          </label>
          <div className="space-y-2">
            {cur.watchedRootUrls.map((url, idx) => (
              <div key={idx} className="flex gap-2">
                <Input
                  fullWidth
                  type="url"
                  value={url}
                  onChange={(e) => {
                    const next = [...cur.watchedRootUrls];
                    next[idx] = e.target.value;
                    set('watchedRootUrls', next);
                  }}
                  placeholder={DEFAULT_URL}
                />
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => {
                    const next = cur.watchedRootUrls.filter((_, i) => i !== idx);
                    set('watchedRootUrls', next);
                  }}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => set('watchedRootUrls', [...cur.watchedRootUrls, ''])}
            >
              <Plus className="w-3.5 h-3.5" />
              添加 URL
            </Button>
          </div>
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

        <div className="flex justify-end pt-2 border-t border-line">
          <Button onClick={() => handleSave('知识库设置')} loading={saving}>
            保存
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
