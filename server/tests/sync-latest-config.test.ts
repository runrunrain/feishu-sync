import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALL_ROOTS,
  REQUIRED_SCOPES,
  parseArgs,
  prepareSyncLatestConfig,
  selectWritablePlans,
} from '../scripts/sync-latest.js';
import type { PlannedSyncDocument } from '../src/types/index.js';

const temporaryDirectories: string[] = [];

function makeTempDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function setupPaths(): {
  directory: string;
  knowledgeBase: string;
  configPath: string;
  operationsDir: string;
} {
  const directory = makeTempDirectory('feishu-sync-latest-config-');
  const knowledgeBase = path.join(directory, 'formal-kb');
  fs.mkdirSync(knowledgeBase);
  return {
    directory,
    knowledgeBase,
    configPath: path.join(directory, 'state', 'config.json'),
    operationsDir: path.join(directory, 'state', 'operations'),
  };
}

function prepare(paths: ReturnType<typeof setupPaths>, persistConfig = false) {
  return prepareSyncLatestConfig({
    configPath: paths.configPath,
    operationsDir: paths.operationsDir,
    formalKb: paths.knowledgeBase,
    persistConfig,
  });
}

function plan(
  action: PlannedSyncDocument['action'],
  objToken: string,
): PlannedSyncDocument {
  return {
    objToken,
    title: `${action}-${objToken}`,
    objType: 'docx',
    changeType: 'modified',
    action,
    localMdPath: `/tmp/${objToken}.md`,
    localRelPath: `${objToken}.md`,
    previousSha256: null,
    ...(action === 'move'
      ? {
          plannedMoveFrom: `old/${objToken}.md`,
          reason: '路径移动需单独确认',
        }
      : {}),
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('sync-latest configuration ownership', () => {
  it('creates a missing config with private permissions and all formal defaults', () => {
    const paths = setupPaths();

    const prepared = prepare(paths);
    const persisted = JSON.parse(fs.readFileSync(paths.configPath, 'utf-8'));

    expect(prepared.created).toBe(true);
    expect(prepared.persisted).toBe(true);
    expect(prepared.config.knowledgeBaseRoot).toBe(paths.knowledgeBase);
    expect(persisted.knowledgeBaseRoot).toBe(paths.knowledgeBase);
    expect(persisted.watchedRoots).toEqual(ALL_ROOTS);
    expect(persisted.requiredScopes).toEqual([...REQUIRED_SCOPES]);
    expect(persisted.llm.apiKey).toBe('');
    expect(fs.existsSync(paths.operationsDir)).toBe(true);
    expect(fs.statSync(paths.configPath).mode & 0o777).toBe(0o600);
  });

  it('keeps an existing config byte-for-byte unchanged while using a formal runtime merge', () => {
    const paths = setupPaths();
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    const existing = {
      _warning: 'user managed warning',
      llm: {
        openAiCompatBaseUrl: 'https://gateway.example/v1',
        claudeCompatBaseUrl: 'https://gateway.example/anthropic',
        apiKey: 'user-secret-must-survive',
        model: 'user-model',
        temperature: 0.7,
        primaryChannel: 'direct',
        fallbackOnFailure: false,
        claudeCli: {
          extraArgs: ['--verbose'],
          userNestedSetting: 'retained',
        },
        providerExtension: { keep: true },
      },
      knowledgeBaseRoot: '/user-selected-kb',
      watchedRoots: [{
        id: 'custom-root',
        url: 'https://example.invalid/wiki/custom-root',
        localDir: 'custom',
        layoutProfile: 'directory-readme',
        enabled: true,
      }],
      requiredScopes: ['custom:scope', 'wiki:node:retrieve', 'custom:scope'],
      customUserField: { enabled: true, labels: ['do-not-drop'] },
      enableAutoStart: false,
      enableNotifications: false,
    };
    const bytes = `${JSON.stringify(existing, null, 2)}\n`;
    fs.writeFileSync(paths.configPath, bytes, 'utf-8');

    const prepared = prepare(paths);

    expect(prepared.created).toBe(false);
    expect(prepared.persisted).toBe(false);
    expect(fs.readFileSync(paths.configPath, 'utf-8')).toBe(bytes);
    expect(prepared.config.knowledgeBaseRoot).toBe(paths.knowledgeBase);
    expect(prepared.config.watchedRoots).toEqual(ALL_ROOTS);
    expect(prepared.config.requiredScopes).toEqual(['custom:scope', ...REQUIRED_SCOPES]);
    expect(prepared.config.llm.apiKey).toBe('user-secret-must-survive');
    expect((prepared.config.llm as any).providerExtension).toEqual({ keep: true });
    expect((prepared.config.llm.claudeCli as any).userNestedSetting).toBe('retained');
    expect((prepared.config as any).customUserField).toEqual(existing.customUserField);
    expect((prepared.rawConfig as any).knowledgeBaseRoot).toBe('/user-selected-kb');
  });

  it('persists the formal migration only when explicitly requested and preserves user-owned fields', () => {
    const paths = setupPaths();
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    const formalRootWithUserField = {
      ...ALL_ROOTS[0],
      localDir: 'incorrect-user-path',
      userRootMetadata: { keep: 'me' },
    };
    const unrelatedRoot = {
      id: 'unrelated-root',
      url: 'https://example.invalid/wiki/unrelated-root',
      localDir: 'unrelated',
      layoutProfile: 'directory-readme',
      enabled: false,
      userRootMetadata: { also: 'keep' },
    };
    const existing = {
      llm: {
        apiKey: 'preserve-this-secret',
        customLlmProviderField: 'unchanged',
      },
      knowledgeBaseRoot: '/another-kb',
      watchedRoots: [formalRootWithUserField, unrelatedRoot],
      requiredScopes: ['custom:scope'],
      customTopLevel: { retained: true },
    };
    fs.writeFileSync(paths.configPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');

    const prepared = prepare(paths, true);
    const persisted = JSON.parse(fs.readFileSync(paths.configPath, 'utf-8'));
    const persistedFormal = persisted.watchedRoots.find(
      (root: { id?: string }) => root.id === ALL_ROOTS[0].id,
    );
    const persistedUnrelated = persisted.watchedRoots.find(
      (root: { id?: string }) => root.id === unrelatedRoot.id,
    );

    expect(prepared.created).toBe(false);
    expect(prepared.persisted).toBe(true);
    expect(persisted.knowledgeBaseRoot).toBe(paths.knowledgeBase);
    expect(persisted.requiredScopes).toEqual(['custom:scope', ...REQUIRED_SCOPES]);
    expect(persisted.llm).toEqual(existing.llm);
    expect(persisted.customTopLevel).toEqual(existing.customTopLevel);
    expect(persistedFormal).toMatchObject({
      ...ALL_ROOTS[0],
      userRootMetadata: { keep: 'me' },
    });
    expect(persistedUnrelated).toEqual(unrelatedRoot);
    expect(persisted.watchedRoots).toHaveLength(ALL_ROOTS.length + 1);
    expect(fs.readdirSync(path.dirname(paths.configPath)).some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(fs.statSync(paths.configPath).mode & 0o777).toBe(0o600);
  });

  it('rejects malformed existing JSON instead of overwriting it', () => {
    const paths = setupPaths();
    fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
    const malformed = '{ this is not valid JSON';
    fs.writeFileSync(paths.configPath, malformed, 'utf-8');

    expect(() => prepare(paths)).toThrow(/无法读取现有配置/);
    expect(fs.readFileSync(paths.configPath, 'utf-8')).toBe(malformed);
  });
});

describe('sync-latest apply candidate safety', () => {
  it('exposes only create and replace plans to apply candidates; moves remain report-only', () => {
    const selection = selectWritablePlans([
      plan('create', 'create-token'),
      plan('replace', 'replace-token'),
      plan('move', 'move-token'),
      plan('blocked', 'blocked-token'),
    ]);

    expect(selection.writable.map((item) => item.objToken)).toEqual([
      'create-token',
      'replace-token',
    ]);
    expect(selection.moves.map((item) => item.objToken)).toEqual(['move-token']);
    expect(selection.blocked.map((item) => item.objToken)).toEqual(['blocked-token']);
    expect(new Set(selection.writable.map((item) => item.objToken))).not.toContain('move-token');
  });

  it('requires an explicit flag before a config migration can be persisted', () => {
    expect(parseArgs([])).toMatchObject({ persistConfig: false, apply: false });
    expect(parseArgs(['--persist-config', '--root', 'designer'])).toMatchObject({
      persistConfig: true,
      rootFilter: 'designer',
    });
  });
});
