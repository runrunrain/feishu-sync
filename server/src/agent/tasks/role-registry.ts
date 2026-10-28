/**
 * RoleRegistry — 编排子任务角色卡注册表（S6，设计 kb-agent-upgrade §5.1）
 *
 * - 角色卡 = `server/src/agent/roles/*.md`（build-agent-assets 复制到
 *   `dist/agent/roles/`）；文件名即查找键；v1 只内置三张，不支持用户自定义。
 * - frontmatter 字段：name/label/description/tools/requiresMode；
 *   正文 = 子任务系统提示（TaskService 在其后追加公共子任务契约）。
 * - 符号链接拒绝；非法 frontmatter（缺字段/类型错/name 与文件名不符）
 *   跳过该卡并告警——单张卡损坏不拖垮编排。
 */

import fs from 'node:fs';
import path from 'node:path';
import { serverDistRoot } from '../agent-assets.js';

export interface RoleCard {
  name: string;
  label: string;
  description: string;
  /** 角色请求的工具（授予 = 请求 ∩ 父模式工具集 ∩ 已知工具，TaskService 计算） */
  tools: string[];
  requiresMode: 'any' | 'work';
  /** 子任务系统提示正文（不含 frontmatter） */
  body: string;
}

export interface RoleSummary {
  name: string;
  label: string;
  description: string;
  tools: string[];
  requiresMode: 'any' | 'work';
}

/** 简单 YAML 子集解析：单行 key: value、inline 列表 [a, b]、块列表 - item。 */
function parseFrontmatter(raw: string): Record<string, string | string[]> | null {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end <= 1) return null;
  const fields: Record<string, string | string[]> = {};
  let currentList: string[] | null = null;
  for (let i = 1; i < end; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('- ') && currentList) {
      currentList.push(trimmed.slice(2).trim());
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!kv) return null;
    const value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      const items = value.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean);
      fields[kv[1]] = items;
      currentList = null;
    } else if (value === '') {
      currentList = [];
      fields[kv[1]] = currentList;
    } else {
      fields[kv[1]] = value;
      currentList = null;
    }
  }
  return fields;
}

/** 校验并装配角色卡；非法返回 null（调用方跳过并告警）。 */
function buildCard(file: string, raw: string): RoleCard | null {
  const name = path.basename(file, '.md');
  const end = raw.indexOf('\n---', 3);
  const frontmatter = parseFrontmatter(end > 0 ? raw.slice(0, end + 4) : raw);
  if (!frontmatter) return null;
  const body = end > 0 ? raw.slice(raw.indexOf('\n', end + 4) + 1).trim() : '';
  const { label, description, tools, requiresMode } = frontmatter;
  if (
    frontmatter.name !== name
    || typeof label !== 'string' || !label.trim() || label.length > 80
    || typeof description !== 'string' || description.length > 300
    || !Array.isArray(tools) || tools.length < 1
    || !tools.every((tool) => typeof tool === 'string' && /^[a-z0-9_]+$/.test(tool))
    || (requiresMode !== 'any' && requiresMode !== 'work')
    || !body
  ) {
    return null;
  }
  return { name, label: label.trim(), description, tools: [...new Set(tools as string[])], requiresMode, body };
}

export class RoleRegistry {
  private readonly cards = new Map<string, RoleCard>();
  readonly loadedFrom: string;

  constructor(explicitDir?: string) {
    const candidates = explicitDir
      ? [explicitDir]
      : [path.join(serverDistRoot(), 'agent', 'roles'), path.join(serverDistRoot(), '..', 'src', 'agent', 'roles')];
    let dir: string | null = null;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        dir = candidate;
        break;
      }
    }
    this.loadedFrom = dir ?? candidates[candidates.length - 1];
    if (!dir) {
      console.warn('[RoleRegistry] 角色卡目录缺失，任务编排不可用:', this.loadedFrom);
      return;
    }
    for (const entry of fs.readdirSync(dir).sort()) {
      if (!entry.endsWith('.md')) continue;
      const file = path.join(dir, entry);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        console.warn(`[RoleRegistry] 拒绝符号链接角色卡: ${entry}`);
        continue;
      }
      if (!stat.isFile()) continue;
      const card = buildCard(entry, fs.readFileSync(file, 'utf-8'));
      if (!card) {
        console.warn(`[RoleRegistry] 角色卡 frontmatter 非法，跳过: ${entry}`);
        continue;
      }
      this.cards.set(card.name, card);
    }
  }

  get(name: string): RoleCard | null {
    return this.cards.get(name) ?? null;
  }

  list(): RoleSummary[] {
    return [...this.cards.values()].map(({ name, label, description, tools, requiresMode }) => ({
      name, label, description, tools, requiresMode,
    }));
  }

  size(): number {
    return this.cards.size;
  }
}
