/**
 * PathResolver unit tests — two layout profiles, safety, conflicts, moves.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveProfileRelativePath,
  joinRelative,
  planDocumentPaths,
  resolveLocalTarget,
  sanitizePathSegment,
  toPortableRelative,
} from '../src/modules/path-resolver.js';
import type { WatchedRootConfig } from '../src/types/index.js';

function makeRoot(
  overrides: Partial<WatchedRootConfig> & Pick<WatchedRootConfig, 'localDir' | 'layoutProfile'>,
): WatchedRootConfig {
  return {
    id: overrides.id ?? 'root-token',
    url: overrides.url ?? 'https://tenant.example.feishu.cn/wiki/root-token',
    localDir: overrides.localDir,
    layoutProfile: overrides.layoutProfile,
    enabled: overrides.enabled ?? true,
  };
}

describe('sanitizePathSegment', () => {
  it('normalizes NFC and strips illegal characters', () => {
    expect(sanitizePathSegment('a/b:c*d')).toBe('a_b_c_d');
    expect(sanitizePathSegment('  hello.  ')).toBe('hello');
  });

  it('rejects reserved and empty names', () => {
    expect(sanitizePathSegment('CON')).toBe('');
    expect(sanitizePathSegment('..')).toBe('');
    expect(sanitizePathSegment('')).toBe('');
  });
});

describe('deriveProfileRelativePath — directory-readme', () => {
  const localDir = '技术 - Dev';

  it('maps watched root body to localDir/README.md', () => {
    const result = deriveProfileRelativePath({
      localDir,
      layoutProfile: 'directory-readme',
      title: '技术 - Dev',
      hasChild: true,
      isWatchedRootNode: true,
    });
    expect(result.relativePath).toBe('技术 - Dev/README.md');
  });

  it('maps nested nodes to title/README.md under parent chain', () => {
    const result = deriveProfileRelativePath({
      localDir,
      layoutProfile: 'directory-readme',
      title: '1.1.面向数据',
      hasChild: false,
      parentChainTitles: ['1.核心层：数据&插件&质量'],
    });
    expect(result.relativePath).toBe(
      '技术 - Dev/1.核心层：数据&插件&质量/1.1.面向数据/README.md',
    );
  });

  it('never places non-root bodies as root-level .md', () => {
    const result = deriveProfileRelativePath({
      localDir,
      layoutProfile: 'directory-readme',
      title: '服务器架构',
      hasChild: false,
      parentChainTitles: [],
      isWatchedRootNode: false,
    });
    // Empty parent chain + not root → still title/README under localDir
    expect(result.relativePath).toBe('技术 - Dev/服务器架构/README.md');
    expect(result.relativePath?.endsWith('.md')).toBe(true);
    expect(result.relativePath).not.toBe('技术 - Dev/服务器架构.md');
  });
});

describe('deriveProfileRelativePath — mirror-title-file', () => {
  const localDir = '策划 - Designer';

  it('maps watched root body to localDir/README.md', () => {
    const result = deriveProfileRelativePath({
      localDir,
      layoutProfile: 'mirror-title-file',
      title: '策划 - Designer',
      hasChild: true,
      isWatchedRootNode: true,
    });
    expect(result.relativePath).toBe('策划 - Designer/README.md');
  });

  it('maps branch nodes to title/title.md', () => {
    const result = deriveProfileRelativePath({
      localDir,
      layoutProfile: 'mirror-title-file',
      title: '200-系统框架&数据结构',
      hasChild: true,
      parentChainTitles: [],
      isWatchedRootNode: false,
    });
    expect(result.relativePath).toBe(
      '策划 - Designer/200-系统框架&数据结构/200-系统框架&数据结构.md',
    );
  });

  it('maps leaf nodes to parent/title.md', () => {
    const result = deriveProfileRelativePath({
      localDir,
      layoutProfile: 'mirror-title-file',
      title: '400-战斗场景实现',
      hasChild: false,
      parentChainTitles: ['400-玩法与表现'],
    });
    expect(result.relativePath).toBe(
      '策划 - Designer/400-玩法与表现/400-战斗场景实现.md',
    );
  });
});

describe('resolveLocalTarget', () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('prefers a verified existing relative mapping', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'path-resolver-'));
    const watched = makeRoot({
      localDir: '技术 - Dev',
      layoutProfile: 'directory-readme',
    });
    const existing = '技术 - Dev/legacy-place/README.md';
    const dir = path.join(tmpRoot, '技术 - Dev', 'legacy-place');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), '# x\n');

    const result = resolveLocalTarget({
      knowledgeBaseRoot: tmpRoot,
      watchedRoot: watched,
      title: '服务器架构',
      hasChild: false,
      parentChainTitles: [],
      isWatchedRootNode: false,
      existingLocalRelPath: existing,
    });

    expect(result.ok).toBe(true);
    expect(result.target?.source).toBe('existing-mapping');
    expect(result.target?.relativeMarkdownPath).toBe(existing);
  });

  it('derives profile path and companion dirs for sheet', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'path-resolver-'));
    const watched = makeRoot({
      localDir: '策划 - Designer',
      layoutProfile: 'mirror-title-file',
    });

    const result = resolveLocalTarget({
      knowledgeBaseRoot: tmpRoot,
      watchedRoot: watched,
      title: '表格配置',
      hasChild: false,
      parentChainTitles: [],
      isWatchedRootNode: false,
      objType: 'sheet',
      rejectExistingFiles: false,
    });

    expect(result.ok).toBe(true);
    expect(result.target?.relativeMarkdownPath).toBe(
      '策划 - Designer/表格配置.md',
    );
    expect(result.target?.relativeCsvDataDir).toBe(
      '策划 - Designer/表格配置.csv-data',
    );
    expect(result.target?.relativeAssetDir).toBe('策划 - Designer/images');
    expect(result.target?.source).toBe('layout-profile');
  });

  it('blocks overwrite when profile path already has a different file', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'path-resolver-'));
    const watched = makeRoot({
      localDir: '策划 - Designer',
      layoutProfile: 'mirror-title-file',
    });
    const targetRel = '策划 - Designer/表格配置.md';
    const abs = path.join(tmpRoot, ...targetRel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '# existing foreign body\n');

    const result = resolveLocalTarget({
      knowledgeBaseRoot: tmpRoot,
      watchedRoot: watched,
      title: '表格配置',
      hasChild: false,
      isWatchedRootNode: false,
      objType: 'sheet',
    });

    expect(result.ok).toBe(false);
    expect(result.conflicts.some((c) => c.kind === 'existing-file')).toBe(true);
  });

  it('reports case-only collisions against occupied paths', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'path-resolver-'));
    const watched = makeRoot({
      localDir: 'Dev',
      layoutProfile: 'directory-readme',
    });

    const result = resolveLocalTarget({
      knowledgeBaseRoot: tmpRoot,
      watchedRoot: watched,
      title: 'Server',
      hasChild: false,
      isWatchedRootNode: false,
      rejectExistingFiles: false,
      occupiedRelPaths: ['Dev/server/README.md'],
    });

    expect(result.ok).toBe(false);
    expect(result.conflicts.some((c) => c.kind === 'case-collision')).toBe(true);
  });

  it('plans a move when preferProfilePath and existing differs', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'path-resolver-'));
    const watched = makeRoot({
      localDir: '技术 - Dev',
      layoutProfile: 'directory-readme',
    });

    const result = resolveLocalTarget({
      knowledgeBaseRoot: tmpRoot,
      watchedRoot: watched,
      title: '服务器架构',
      hasChild: false,
      isWatchedRootNode: false,
      existingLocalRelPath: '技术 - Dev/old-server.md',
      preferProfilePath: true,
      rejectExistingFiles: false,
    });

    expect(result.ok).toBe(true);
    expect(result.target?.relativeMarkdownPath).toBe(
      '技术 - Dev/服务器架构/README.md',
    );
    expect(result.target?.plannedMoveFrom).toBe('技术 - Dev/old-server.md');
    expect(result.target?.source).toBe('layout-profile');
  });

  it('rejects escape via .. segments in existing path', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'path-resolver-'));
    const watched = makeRoot({
      localDir: '技术 - Dev',
      layoutProfile: 'directory-readme',
    });

    const result = resolveLocalTarget({
      knowledgeBaseRoot: tmpRoot,
      watchedRoot: watched,
      title: 'x',
      hasChild: false,
      existingLocalRelPath: '../outside.md',
      rejectExistingFiles: false,
    });

    // Falls back to profile after rejecting escape; profile for non-root empty chain
    // with isWatchedRootNode undefined and empty parent → treated as root body.
    // Provide explicit non-root:
    const result2 = resolveLocalTarget({
      knowledgeBaseRoot: tmpRoot,
      watchedRoot: watched,
      title: '安全节点',
      hasChild: false,
      isWatchedRootNode: false,
      existingLocalRelPath: '../outside.md',
      rejectExistingFiles: false,
    });
    expect(result2.ok).toBe(true);
    expect(result2.target?.relativeMarkdownPath).toBe(
      '技术 - Dev/安全节点/README.md',
    );
    expect(result.ok || result2.ok).toBe(true);
  });
});

describe('planDocumentPaths', () => {
  it('blocks the second document when both resolve to the same path', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'path-resolver-batch-'));
    try {
      const watched = makeRoot({
        localDir: '策划 - Designer',
        layoutProfile: 'mirror-title-file',
      });
      const results = planDocumentPaths([
        {
          knowledgeBaseRoot: tmpRoot,
          watchedRoot: watched,
          title: '同名',
          hasChild: false,
          isWatchedRootNode: false,
          rejectExistingFiles: false,
        },
        {
          knowledgeBaseRoot: tmpRoot,
          watchedRoot: watched,
          title: '同名',
          hasChild: false,
          isWatchedRootNode: false,
          rejectExistingFiles: false,
        },
      ]);
      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(false);
      expect(results[1].conflicts.some((c) => c.kind === 'duplicate-target')).toBe(
        true,
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('toPortableRelative / joinRelative', () => {
  it('converts absolute paths under root to POSIX relative', () => {
    const root = path.join(os.tmpdir(), 'kb-root-sample');
    const abs = path.join(root, '技术 - Dev', 'README.md');
    expect(toPortableRelative(root, abs)).toBe('技术 - Dev/README.md');
  });

  it('joins segments without duplicate slashes', () => {
    expect(joinRelative('a', 'b/', '/c')).toBe('a/b/c');
  });
});
