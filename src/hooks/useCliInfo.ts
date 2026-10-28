/**
 * useCliInfo —— CLI 命令行访问状态（S9）
 *
 * GET /api/cli/info 的轻封装：挂载时加载一次，暴露 reload（操作后刷新）。
 * 失败置 null（组件渲染「状态不可用」+ 重试），不抛错。
 */

import { useCallback, useEffect, useState } from 'react';
import { getCliInfo } from '../api/client';
import type { CliInfoDto } from '../types/cli';

export function useCliInfo(): {
  info: CliInfoDto | null;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const [info, setInfo] = useState<CliInfoDto | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setInfo(await getCliInfo());
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { info, loading, reload };
}
