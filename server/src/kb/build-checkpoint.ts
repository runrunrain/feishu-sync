/** 原子构建检查点：每份完整草稿和进度一起提交，上一代检查点始终可用。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, resolveInside } from '../agent/path-guard.js';
import type { BuildRunState } from '../agent/agent-tool-service.js';
import type { ImageDescription } from '../agent/vision/vision-describer.js';
import type { KbBuildProgressDto, RawSourceSnapshotEntry } from '../types/agent-knowledge.js';
import type { BuildOrchestrationSnapshot } from './build-orchestration.js';
import type { BuildUnit } from './build-units.js';
import type { PathClaimPreload } from './path-claims.js';

type DocMeta = { title: string; summary: string; tags: string[]; sources: string[] };
export interface BuildCheckpoint {
  schemaVersion: 1;
  buildId: string;
  knowledgeBaseRoot: string;
  baseReleaseId: string | null;
  requestedMode: 'full' | 'incremental';
  mode: 'full' | 'incremental';
  backend: 'pi' | 'claude-code';
  rebuildSelected: boolean;
  snapshot: RawSourceSnapshotEntry[];
  workset: Array<[string, 'added' | 'changed' | 'rebuild']>;
  docMeta: Array<[string, DocMeta]>;
  writtenPaths: string[];
  preservedDocs: Array<[string, string[]]>;
  requiredRewrites: string[];
  baseDocPaths: string[];
  finishInfo: BuildRunState['finishInfo'];
  imageDescriptions: Array<[string, Array<[string, ImageDescription]>]>;
  units: BuildUnit[];
  unitDone: Array<[string, { summary: string; skipped: Array<{ objToken: string; reason: string }> }]>;
  claims: PathClaimPreload[];
  singleBatches: string[][];
  singleCompleted: number;
  unitProgress: Array<[string, number]>;
  workerCount: number;
  wordBudget: number;
  progress: KbBuildProgressDto;
  updatedAt: string;
  files?: Record<string, string>;
  /** T2a（B 案 §8）：多模型编排骨架快照（BuildSpec + 任务集合）。
   * additive 可选：旧检查点无此字段按旧规则恢复，不升级成新式任务。 */
  orchestration?: BuildOrchestrationSnapshot;
}

export interface CheckpointSummary {
  checkpointAt: string;
  draftCount: number;
  sourceCount: number;
  completedBatches: number;
  totalBatches: number;
  progress: KbBuildProgressDto;
  baseReleaseId: string | null;
  knowledgeBaseRoot: string;
}

const validId = (id: string) => /^[A-Za-z0-9_-]{1,120}$/.test(id);
const validGeneration = (id: string) => /^cp_[a-f0-9]{20}$/.test(id);
const digest = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 检查点允许的库外声明产物相对路径（diting F01：save/restore 同集）。 */
const KNOWLEDGE_ARTIFACTS = ['knowledge-draft.json', 'organization-plan.json', 'read-receipts.jsonl', 'candidate.json', 'governance-freeze.json'] as const;

function validCheckpointRelativePath(relative: string): boolean {
  if (relative === '.docid-map.json' || (KNOWLEDGE_ARTIFACTS as readonly string[]).includes(relative)) return true;
  if (relative.startsWith('docs/') && relative.endsWith('.md')) return true;
  // reviews/ 当前报告与归档（archive）均为 .json
  return /^reviews\/[A-Za-z0-9_.-]+\.json$/.test(relative) || /^reviews\/archive\/[A-Za-z0-9_.-]+\.json$/.test(relative);
}

function documentFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name); const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('检查点不允许符号链接');
      if (stat.isDirectory()) walk(full, `${prefix}${name}/`);
      else if (stat.isFile() && stat.nlink === 1 && name.endsWith('.md')) files.push(prefix + name);
      else throw new Error('检查点只允许普通 Markdown 文件');
      if (files.length > 10000) throw new Error('构建草稿数量超过检查点上限');
    }
  };
  walk(root, ''); return files.sort();
}

/** diting F01：staging 根的知识组织/审查产物清单（库外声明真相）。
 * reviews/ 递归收集 .json（含 archive）；符号链接拒绝；总量守门。 */
function knowledgeArtifactFiles(stagingRoot: string): string[] {
  const files: string[] = [];
  for (const name of KNOWLEDGE_ARTIFACTS) {
    const full = path.join(stagingRoot, name);
    if (!fs.existsSync(full)) continue;
    const stat = fs.lstatSync(full);
    if (!stat.isFile()) throw new Error(`知识产物必须是普通文件: ${name}`);
    files.push(name);
  }
  const reviewsDir = path.join(stagingRoot, 'reviews');
  const walk = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name); const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('检查点不允许符号链接');
      if (stat.isDirectory()) walk(full, `${prefix}${name}/`);
      else if (stat.isFile() && stat.nlink === 1 && name.endsWith('.json')) files.push(`${prefix}${name}`);
      else throw new Error('检查点 reviews/ 只允许普通 JSON 文件');
      if (files.length > 20000) throw new Error('知识产物数量超过检查点上限');
    }
  };
  walk(reviewsDir, 'reviews/');
  return files.sort();
}

export class BuildCheckpointStore {
  constructor(private readonly root: string) {}

  private checkpointDir(buildId: string, intent: 'read' | 'mkdir'): string {
    if (!validId(buildId)) throw new Error('无效构建标识');
    return resolveInside(this.root, `.builds/${buildId}/checkpoints`, intent);
  }

  private pointer(buildId: string): { generation: string; summary: CheckpointSummary } | null {
    try {
      const dir = this.checkpointDir(buildId, 'read');
      const file = resolveInside(dir, 'CURRENT.json', 'read');
      if (fs.statSync(file).size > 64 * 1024) return null;
      const pointer = JSON.parse(fs.readFileSync(file, 'utf8'));
      return validGeneration(pointer.generation) && pointer.summary?.progress ? pointer : null;
    } catch { return null; }
  }

  summary(buildId: string): CheckpointSummary | null { return this.pointer(buildId)?.summary ?? null; }

  save(checkpoint: BuildCheckpoint, stagingRoot: string): void {
    const previous = this.pointer(checkpoint.buildId);
    const dir = this.checkpointDir(checkpoint.buildId, 'mkdir');
    const generation = `cp_${crypto.randomBytes(10).toString('hex')}`;
    const target = resolveInside(dir, generation, 'mkdir');
    const files: Record<string, string> = {};
    for (const relative of documentFiles(path.join(stagingRoot, 'docs'))) {
      const source = resolveInside(path.join(stagingRoot, 'docs'), relative, 'read');
      resolveInside(target, `docs/${path.posix.dirname(relative)}`, 'mkdir');
      const destination = resolveInside(target, `docs/${relative}`, 'write');
      fs.copyFileSync(source, destination); files[`docs/${relative}`] = digest(destination);
    }
    const map = path.join(stagingRoot, '.docid-map.json');
    if (fs.existsSync(map)) {
      const source = resolveInside(stagingRoot, '.docid-map.json', 'read');
      const destination = resolveInside(target, '.docid-map.json', 'write');
      fs.copyFileSync(source, destination); files['.docid-map.json'] = digest(destination);
    }
    // diting F01：知识组织与审查产物（声明真相、读取回执、审查报告、
    // 待确认候选）与草稿同一代原子入点，纳入哈希清单——恢复后不得重建
    // 为空或静默降 v1。
    for (const relative of knowledgeArtifactFiles(stagingRoot)) {
      const source = resolveInside(stagingRoot, relative, 'read');
      const parent = path.posix.dirname(relative);
      if (parent !== '.') resolveInside(target, parent, 'mkdir');
      const destination = resolveInside(target, relative, 'write');
      fs.copyFileSync(source, destination); files[relative] = digest(destination);
    }
    atomicWriteFile(path.join(target, 'state.json'), JSON.stringify({ ...checkpoint, files }));
    const summary: CheckpointSummary = {
      checkpointAt: checkpoint.updatedAt, draftCount: Object.keys(files).filter((file) => file.startsWith('docs/')).length,
      sourceCount: checkpoint.snapshot.length, completedBatches: checkpoint.singleBatches.length ? checkpoint.singleCompleted : checkpoint.unitProgress.reduce((n, [, count]) => n + count, 0),
      totalBatches: checkpoint.singleBatches.length || checkpoint.units.reduce((n, unit) => n + unit.batches.length, 0),
      progress: checkpoint.progress, baseReleaseId: checkpoint.baseReleaseId, knowledgeBaseRoot: checkpoint.knowledgeBaseRoot,
    };
    atomicWriteFile(path.join(dir, 'CURRENT.json'), JSON.stringify({ generation, summary }));
    // 只清理由本模块生成、且真实路径位于检查点目录中的旧代。
    for (const old of fs.readdirSync(dir).filter((name) => validGeneration(name) && name !== generation && name !== previous?.generation)) {
      try { fs.rmSync(resolveInside(dir, old, 'read'), { recursive: true, force: true }); } catch { /* 保留当前与上一代即可恢复。 */ }
    }
  }

  read(buildId: string): BuildCheckpoint | null {
    const pointer = this.pointer(buildId); if (!pointer) return null;
    const dir = resolveInside(this.checkpointDir(buildId, 'read'), pointer.generation, 'read');
    const file = resolveInside(dir, 'state.json', 'read');
    if (fs.statSync(file).size > 128 * 1024 * 1024) throw new Error('构建检查点过大');
    const checkpoint = JSON.parse(fs.readFileSync(file, 'utf8')) as BuildCheckpoint;
    if (checkpoint.schemaVersion !== 1 || checkpoint.buildId !== buildId || !Array.isArray(checkpoint.snapshot) || !Array.isArray(checkpoint.docMeta)
      || !Array.isArray(checkpoint.singleBatches) || !Array.isArray(checkpoint.units) || !checkpoint.files) throw new Error('构建检查点无效');
    for (const [relative, hash] of Object.entries(checkpoint.files)) {
      if (!validCheckpointRelativePath(relative)) throw new Error('检查点文件路径无效');
      if (digest(resolveInside(dir, relative, 'read')) !== hash) throw new Error('构建检查点草稿校验失败');
    }
    return checkpoint;
  }

  restore(buildId: string, stagingRoot: string): void {
    const pointer = this.pointer(buildId); const checkpoint = this.read(buildId);
    if (!pointer || !checkpoint) throw new Error('没有可恢复的构建检查点');
    const dir = resolveInside(this.checkpointDir(buildId, 'read'), pointer.generation, 'read');
    const expected = resolveInside(this.root, `.staging/${buildId}`, 'mkdir');
    const actual = fs.realpathSync.native(stagingRoot);
    if ((process.platform === 'win32' ? actual.toLowerCase() : actual) !== (process.platform === 'win32' ? expected.toLowerCase() : expected)) throw new Error('恢复目录不匹配');
    // 旧工作目录另存诊断副本，恢复只使用已原子提交的检查点。
    if (fs.readdirSync(expected).length) {
      const backup = resolveInside(this.root, `.staging/${buildId}-before-resume-${crypto.randomBytes(5).toString('hex')}`, 'write');
      fs.renameSync(expected, backup); fs.mkdirSync(expected);
    }
    resolveInside(expected, 'docs', 'mkdir');
    for (const relative of Object.keys(checkpoint.files!)) {
      resolveInside(expected, path.posix.dirname(relative), 'mkdir');
      fs.copyFileSync(resolveInside(dir, relative, 'read'), resolveInside(expected, relative, 'write'));
    }
  }
}
