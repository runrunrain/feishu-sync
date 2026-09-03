/**
 * Feishu cite tag parsing and navigation utilities.
 *
 * 用于解析飞书 Markdown 中嵌入的形如：
 * <cite doc-id="DUZzwzedWiXmeSk9gGscuWCuneh" file-type="wiki" title="战斗实体感知吸引力-300 by 小星" type="doc"></cite>
 * 的行内标签，并生成飞书 wiki 超链接与点击跳转动作。
 */

import { decodeHtmlEntities } from './html-table';

export interface ParsedCite {
  docId: string | null;
  title: string | null;
  fileType: string | null;
  type: string | null;
  userName: string | null;
  userId: string | null;
  innerText: string;
  /** 构造出的有效 URL（仅当 docId 存在时） */
  url: string | null;
  /** 最终展示文本：优先 title，缺 title 取 docId，缺 docId 则取 userName 或 innerText */
  displayText: string;
}

/**
 * 解析单个 <cite ...> 标签字符串。
 * 若无有效 doc-id 且无其他展示信息，降级为普通文本或空，避免报错。
 */
export function parseCiteTag(tagStr: string, tenantHost?: string): ParsedCite {
  const getAttr = (name: string): string | null => {
    // 匹配 name="val" 或 name='val' 或 name=val
    const re = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const m = tagStr.match(re);
    if (!m) return null;
    const raw = m[1] ?? m[2] ?? m[3] ?? null;
    return raw !== null ? decodeHtmlEntities(raw).trim() : null;
  };

  const docId = getAttr('doc-id');
  const title = getAttr('title');
  const fileType = getAttr('file-type');
  const type = getAttr('type');
  const userName = getAttr('user-name');
  const userId = getAttr('user-id');

  const innerMatch = tagStr.match(/<cite\b[^>]*>([\s\S]*?)<\/cite>/i);
  const innerText = innerMatch ? decodeHtmlEntities(innerMatch[1]).trim() : '';

  const host = (tenantHost ?? '').trim() || 'feishu.cn';
  const url = docId ? `https://${host}/wiki/${docId}` : null;

  let displayText = '';
  if (title) {
    displayText = title;
  } else if (docId) {
    displayText = docId;
  } else if (userName) {
    displayText = `@${userName}`;
  } else if (innerText) {
    displayText = innerText;
  }

  return {
    docId,
    title,
    fileType,
    type,
    userName,
    userId,
    innerText,
    url,
    displayText,
  };
}

/**
 * 在系统默认浏览器或新标签页中打开飞书 URL。
 * 优先调用 Electron preload 的 openExternal IPC（白名单），在纯浏览器 dev 环境降级为 window.open。
 */
export function openExternalUrl(url: string): void {
  if (!url || typeof window === 'undefined') return;

  if (window.desktop && typeof window.desktop.openExternal === 'function') {
    window.desktop.openExternal(url).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
