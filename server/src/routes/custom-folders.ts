/**
 * Custom-folder archive routes (quick-add cloud docs into user folders).
 *
 *   GET    /api/custom-folders
 *   POST   /api/custom-folders            { name }
 *   PATCH  /api/custom-folders/:id        { name }
 *   DELETE /api/custom-folders/:id
 *   POST   /api/custom-folders/:id/docs   { links: string[] }
 *
 * A custom folder is a user-created bucket that archives scattered Feishu
 * cloud documents outside the synced watched-root structure tree. Documents
 * added here keep watched_root_url/watched_root_id NULL and link back via
 * custom_folder_id; their local files live under _custom/<folder-name>/.
 *
 * Security: folder names are sanitized, every local path is asserted to stay
 * inside the knowledge-base root, file writes go through the staging->atomic-
 * rename coordinator, and a single document failure never aborts the batch.
 */

import { Hono } from 'hono';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  resolveAbsolute,
  isPathInsideRoot,
  sanitizePathSegment,
} from '../modules/path-resolver.js';
import { resolveOperationDirectory } from '../modules/operation-manifest.js';
import { LarkCliError } from '../modules/lark-cli-client.js';
import {
  syncDocxToCustomFolder,
  syncSheetToCustomFolder,
} from '../modules/custom-doc-sync.js';
import {
  rollbackAtomicPlan,
  type AtomicCommitPlan,
} from '../modules/atomic-commit.js';

const customFolderRoutes = new Hono();

/**
 * Module-level serialization of the quick-add archive flow.
 *
 * The archive transaction spans "查重 → 异步写盘 → 写 DB": without
 * serialization two concurrent requests for the same obj_token / target path
 * can both pass the dup-check, then interleave their writes and produce two DB
 * rows on one file (or clobber each other). This promise chain guarantees that
 * at most one processOneLink critical section runs at a time — batch-internal
 * links are already sequential via the for-await loop, and concurrent batches
 * queue behind it. Modeled on LarkCliClient.commandQueue.
 */
let archiveQueue: Promise<void> = Promise.resolve();

function serializeArchive<T>(fn: () => Promise<T>): Promise<T> {
  // Run `fn` whether the previous task resolved or rejected, so one failure
  // can never stall the whole queue. Callers still observe fn's own result.
  const pending = archiveQueue.then(fn, fn);
  // Keep the chain alive as a never-rejecting Promise<void>.
  archiveQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

const MAX_FOLDER_NAME_LENGTH = 100;
const MAX_LINKS_PER_REQUEST = 20;
/** Quick-add archivable obj types: docx (docs+fetch) and sheet (workbook-info + csv-get + LayoutReconstructor, via custom-doc-sync). Slides is still rejected. */
const SUPPORTED_DOC_TYPES = new Set<'docx' | 'sheet'>(['docx', 'sheet']);
const STRUCTURE_TREE_LABEL = '已在同步结构树';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve config + knowledge-base root from injected dependencies. */
async function resolveConfig(c: any): Promise<{
  config: any;
  knowledgeBaseRoot: string;
  localMapStore: any;
  larkCliClient: any;
}> {
  const configManager = (c as any).configManager;
  const localMapStore = (c as any).localMapStore;
  const larkCliClient = (c as any).larkCliClient;
  if (!configManager || !localMapStore || !larkCliClient) {
    throw new Error('dependencies_not_injected');
  }
  const config = configManager.getConfig?.() ?? (await configManager.load?.());
  const knowledgeBaseRoot = config?.knowledgeBaseRoot;
  if (!knowledgeBaseRoot || typeof knowledgeBaseRoot !== 'string') {
    throw new Error('knowledge_base_root_not_configured');
  }
  return { config, knowledgeBaseRoot, localMapStore, larkCliClient };
}

/**
 * Sanitize a folder display name per the API contract: remove forbidden
 * filesystem characters and control characters. An all-forbidden / empty
 * result is invalid and must be rejected by the caller.
 */
function sanitizeFolderName(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[\/\\:*?"<>|\u0000-\u001F]/g, '')
    .trim()
    .replace(/[.\s]+$/g, '');
}

/** Validate a folder name; returns the cleaned name or null when invalid. */
function validateFolderName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FOLDER_NAME_LENGTH) return null;
  const cleaned = sanitizeFolderName(trimmed);
  if (cleaned.length === 0) return null;
  return cleaned;
}

/**
 * Generate a unique localRelPath under _custom/ for a folder name.
 * Conflicts (same sanitized path already used by another folder) append
 * -2, -3, ... until a free path is found.
 */
function generateFolderLocalRelPath(
  localMapStore: any,
  name: string,
): string {
  const base = `_custom/${sanitizeFolderName(name)}`;
  if (!localMapStore.getCustomFolderByLocalRelPath(base)) return base;
  let suffix = 2;
  while (true) {
    const candidate = `${base}-${suffix}`;
    if (!localMapStore.getCustomFolderByLocalRelPath(candidate)) return candidate;
    suffix += 1;
  }
}

/**
 * Resolve a local relPath for a doc that is guaranteed unique under the folder:
 * if the title-derived path is already owned by another obj_token (in the DB
 * or as a file on disk), append -2, -3, ... until a free path is found.
 *
 * Same-title docs would otherwise silently overwrite one file while multiple
 * DB rows point at it. The caller has already rejected duplicates of the SAME
 * obj_token, so any occupant here is necessarily a different document.
 */
function resolveUniqueDocRelPath(
  localMapStore: any,
  knowledgeBaseRoot: string,
  folderLocalRelPath: string,
  title: string,
  objToken: string,
): string {
  const baseStem = sanitizePathSegment(title) || `untitled-${objToken.slice(0, 8)}`;
  const relFor = (stem: string) => `${folderLocalRelPath}/${stem}.md`;

  const isOccupied = (relPath: string): boolean => {
    const owner =
      typeof localMapStore.getDocumentByLocalRelPath === 'function'
        ? localMapStore.getDocumentByLocalRelPath(relPath)
        : null;
    if (owner && owner.obj_token !== objToken) return true;
    return fs.existsSync(resolveAbsolute(knowledgeBaseRoot, relPath));
  };

  const base = relFor(baseStem);
  if (!isOccupied(base)) return base;
  let suffix = 2;
  while (isOccupied(relFor(`${baseStem}-${suffix}`))) suffix += 1;
  return relFor(`${baseStem}-${suffix}`);
}

/**
 * Classify a thrown error from the lark-cli getNode / fetch path into the
 * API error-code set. Returns the stable code plus a human message.
 *
 * parse_failed is reserved for genuine parse failures (a LarkCliError whose
 * code is 'parse', or an explicit caller-side extraction miss). Generic
 * exceptions — filesystem write errors, atomic-commit failures, anything not
 * carrying a structured lark-cli classification — map to fetch_failed so a
 * write/transport problem is never misreported as a malformed link.
 */
function classifyLinkError(error: unknown): {
  code: 'parse_failed' | 'fetch_failed' | 'permission_denied';
  message: string;
} {
  if (error instanceof LarkCliError) {
    if (error.code === 'permission') {
      return { code: 'permission_denied', message: error.message };
    }
    if (error.code === 'parse') {
      return { code: 'parse_failed', message: error.message };
    }
    return { code: 'fetch_failed', message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'fetch_failed', message };
}

/**
 * Feishu/Lark host whitelist for the pure cloud-doc fallback. The fallback
 * resolves a cloud identity directly from the URL after getNode rejects with
 * 131005 (not-in-wiki); it must never do so for an arbitrary host, otherwise
 * a permission error or a crafted link could bypass getNode and reach fetch.
 */
const ALLOWED_FEISHU_HOSTS = ['feishu.cn', 'larksuite.com', 'larkoffice.com'];

/** True when the URL's host is feishu.cn / larksuite.com / larkoffice.com or a subdomain. */
function isAllowedFeishuHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  return ALLOWED_FEISHU_HOSTS.some(
    (base) => host === base || host.endsWith(`.${base}`),
  );
}

/**
 * Parse a standalone cloud-document URL that is NOT part of any wiki space
 * (the typical form: feishu.cn/docx/<objToken>). Returns the extracted
 * identity, or null when the URL is not a recognizable cloud-doc link (wiki
 * links, bare tokens, unrelated URLs).
 *
 * sheets/slides are surfaced so the caller can emit a clearer
 * unsupported_type message; docx and sheet have export fallbacks (docx via
 * docs+fetch, sheet via workbook-info + csv-get), slides does not.
 */
function parseCloudDocUrl(url: string): {
  objToken: string;
  objType: 'docx' | 'sheet' | 'slides';
} | null {
  const pathPart = url.split(/[?#]/)[0];
  const match = pathPart.match(/\/(docx|sheets|slides)\/([A-Za-z0-9_-]+)/);
  if (!match) return null;
  const kind = match[1];
  const token = match[2];
  if (!token) return null;
  const objType = kind === 'docx' ? 'docx' : kind === 'sheets' ? 'sheet' : 'slides';
  return { objToken: token, objType };
}

/**
 * True when the URL carries a cloud-doc path prefix (/docx/, /sheets/,
 * /slides/) even though parseCloudDocUrl could not extract a token — i.e. it
 * looks like an attempt to link a cloud doc whose identity is unreadable.
 * Distinguishes a genuine "extraction failed" from a wiki link / bare token
 * whose node-get failure must be surfaced verbatim.
 */
function looksLikeCloudDocUrl(url: string): boolean {
  const pathPart = url.split(/[?#]/)[0];
  return /\/(?:docx|sheets|slides)\//.test(pathPart);
}

/** Extract a human title from a docs+fetch result, if one is present. */
function extractFetchTitle(fetched: any): string | null {
  const direct = fetched?.data?.title;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const docTitle = fetched?.data?.document?.title;
  if (typeof docTitle === 'string' && docTitle.trim()) return docTitle.trim();
  return null;
}

/**
 * Fallback title for a pure cloud doc whose fetch returned no title: a short,
 * stable tail of its obj_token. Pure cloud-doc links carry no wiki node info,
 * so there is no better source for a display name before the body is written.
 */
function tokenTail(objToken: string): string {
  return objToken.length > 12 ? objToken.slice(-12) : objToken;
}

// ---------------------------------------------------------------------------
// GET /api/custom-folders
// ---------------------------------------------------------------------------

customFolderRoutes.get('/api/custom-folders', async (c) => {
  try {
    const { localMapStore } = await resolveConfig(c);
    const folders = localMapStore.listCustomFolders();
    const result = folders.map((folder: any) => ({
      id: folder.id,
      name: folder.name,
      localRelPath: folder.localRelPath,
      createdAt: folder.createdAt,
      docs: localMapStore.listCustomFolderDocs(folder.id).map((doc: any) => ({
        objToken: doc.objToken,
        title: doc.title,
        objType: doc.objType,
        originalLink: doc.originalLink,
        localRelPath: doc.localRelPath,
      })),
    }));
    return c.json({ folders: result });
  } catch (error) {
    return errorResponse(c, 'custom_folders_list_failed', error);
  }
});

// ---------------------------------------------------------------------------
// POST /api/custom-folders
// ---------------------------------------------------------------------------

customFolderRoutes.post('/api/custom-folders', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const name = validateFolderName(body?.name);
  if (!name) {
    return c.json(
      { error: 'invalid_name', message: '文件夹名称为空、过长或仅含非法字符' },
      400,
    );
  }

  try {
    const { localMapStore } = await resolveConfig(c);

    if (localMapStore.getCustomFolderByName(name)) {
      return c.json({ error: 'duplicate_name', message: '同名文件夹已存在' }, 409);
    }

    const localRelPath = generateFolderLocalRelPath(localMapStore, name);
    const id = crypto.randomUUID();
    const folder = localMapStore.createCustomFolder({ id, name, localRelPath });
    return c.json({ folder: { ...folder, docs: [] } }, 201);
  } catch (error) {
    return errorResponse(c, 'custom_folder_create_failed', error);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/custom-folders/:id
// ---------------------------------------------------------------------------

customFolderRoutes.patch('/api/custom-folders/:id', async (c) => {
  const folderId = c.req.param('id');
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const name = validateFolderName(body?.name);
  if (!name) {
    return c.json(
      { error: 'invalid_name', message: '文件夹名称为空、过长或仅含非法字符' },
      400,
    );
  }

  try {
    const { localMapStore } = await resolveConfig(c);
    const existing = localMapStore.getCustomFolder(folderId);
    if (!existing) {
      return c.json({ error: 'not_found', message: '文件夹不存在' }, 404);
    }
    const clash = localMapStore.getCustomFolderByName(name);
    if (clash && clash.id !== folderId) {
      return c.json({ error: 'duplicate_name', message: '同名文件夹已存在' }, 409);
    }
    localMapStore.renameCustomFolder(folderId, name);
    return c.json({ folder: { ...localMapStore.getCustomFolder(folderId), docs: [] } });
  } catch (error) {
    return errorResponse(c, 'custom_folder_rename_failed', error);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/custom-folders/:id
// ---------------------------------------------------------------------------

customFolderRoutes.delete('/api/custom-folders/:id', async (c) => {
  const folderId = c.req.param('id');
  try {
    const { localMapStore } = await resolveConfig(c);
    const existing = localMapStore.getCustomFolder(folderId);
    if (!existing) {
      return c.json({ error: 'not_found', message: '文件夹不存在' }, 404);
    }
    // Unlink documents but keep their local files on disk.
    localMapStore.clearDocumentsCustomFolder(folderId);
    localMapStore.deleteCustomFolder(folderId);
    return c.json({ ok: true });
  } catch (error) {
    return errorResponse(c, 'custom_folder_delete_failed', error);
  }
});

// ---------------------------------------------------------------------------
// POST /api/custom-folders/:id/docs
// ---------------------------------------------------------------------------

customFolderRoutes.post('/api/custom-folders/:id/docs', async (c) => {
  const folderId = c.req.param('id');
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const links: unknown = body?.links;
  if (!Array.isArray(links) || links.length === 0) {
    return c.json(
      { error: 'invalid_body', message: 'links (非空 string[]) 为必填' },
      400,
    );
  }
  if (links.length > MAX_LINKS_PER_REQUEST) {
    return c.json(
      {
        error: 'too_many_links',
        message: `单次最多 ${MAX_LINKS_PER_REQUEST} 条链接`,
      },
      400,
    );
  }

  try {
    const { knowledgeBaseRoot, localMapStore, larkCliClient, config } = await resolveConfig(c);
    const folder = localMapStore.getCustomFolder(folderId);
    if (!folder) {
      return c.json({ error: 'not_found', message: '文件夹不存在' }, 404);
    }

    const operationDirectory = resolveOperationDirectory(
      knowledgeBaseRoot,
      config?.operationManifestDir,
    );

    const results = [];
    for (const rawLink of links) {
      // A single link must never abort the remaining links in the batch.
      // processOneLink already converts known failures into error results; this
      // guard captures any unexpected throw so the whole request still resolves.
      try {
        results.push(
          await serializeArchive(() => processOneLink({
            link: rawLink,
            folder,
            knowledgeBaseRoot,
            operationDirectory,
            localMapStore,
            larkCliClient,
          })),
        );
      } catch (error) {
        results.push({
          link: typeof rawLink === 'string' ? rawLink : String(rawLink ?? ''),
          ok: false,
          error: {
            code: 'fetch_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
    return c.json({ results });
  } catch (error) {
    return errorResponse(c, 'custom_folder_add_docs_failed', error);
  }
});

interface LinkContext {
  link: unknown;
  folder: { id: string; name: string; localRelPath: string };
  knowledgeBaseRoot: string;
  operationDirectory: string;
  localMapStore: any;
  larkCliClient: any;
}

interface LinkResult {
  link: string;
  ok: boolean;
  objToken?: string;
  title?: string;
  objType?: string;
  error?: { code: string; message: string; existingLocation?: string };
}

/**
 * Process a single link end-to-end. A failure here produces an error entry
 * and never propagates to abort the remaining links in the batch.
 */
async function processOneLink(ctx: LinkContext): Promise<LinkResult> {
  const linkStr =
    typeof ctx.link === 'string' ? ctx.link.trim() : '';
  if (!linkStr) {
    return {
      link: String(ctx.link ?? ''),
      ok: false,
      error: { code: 'parse_failed', message: '链接为空' },
    };
  }

  // 1. Resolve the cloud node identity.
  let node: any;
  let prefetchedDocument:
    | { content: string; url: string | null }
    | undefined;
  try {
    node = await ctx.larkCliClient.getNode(linkStr);
  } catch (error) {
    // Fallback for pure cloud-document links that are not part of any wiki
    // space: lark-cli `wiki +node-get` rejects them with 131005
    // "document is not in wiki". Only that specific signal is allowed to
    // bypass getNode — permission errors (131006/40403) and any other failure
    // must surface verbatim so they cannot smuggle a direct fetch.
    const isNotInWiki =
      error instanceof LarkCliError && error.upstreamCode === '131005';
    if (!isNotInWiki) {
      const classified = classifyLinkError(error);
      return { link: linkStr, ok: false, error: classified };
    }
    // Even on 131005, only resolve the identity from a Feishu/Lark host so a
    // crafted or mistaken link cannot direct fetch at an arbitrary origin.
    if (!isAllowedFeishuHost(linkStr)) {
      return {
        link: linkStr,
        ok: false,
        error: {
          code: 'parse_failed',
          message: '链接 host 不在飞书白名单内，已拒绝回退提取',
        },
      };
    }
    const parsed = parseCloudDocUrl(linkStr);
    if (parsed) {
      if (parsed.objType === 'docx') {
      try {
        const fetched = await ctx.larkCliClient.fetchDocumentMarkdown(parsed.objToken);
        const document = fetched?.data?.document ?? {};
        const content = typeof document.content === 'string' ? document.content : '';
        const fetchedUrl =
          typeof document.url === 'string' && document.url.trim()
            ? document.url.trim()
            : null;
        prefetchedDocument = { content, url: fetchedUrl };
        const resolvedTitle =
          extractFetchTitle(fetched) ?? tokenTail(parsed.objToken);
        node = {
          obj_token: parsed.objToken,
          obj_type: 'docx',
          title: resolvedTitle,
          node_token: null,
          space_id: null,
          obj_edit_time: null,
          has_child: false,
        };
      } catch (fetchError) {
        const classified = classifyLinkError(fetchError);
        return {
          link: linkStr,
          ok: false,
          objToken: parsed.objToken,
          error: classified,
        };
      }
      } else if (parsed.objType === 'sheet') {
        // Pure spreadsheet URL (not in any wiki space). workbook-info has no
        // workbook-title field (only revision + sheets[]), so fall back to
        // the token tail like the docx path does when fetch omits a title;
        // readability is restored later by the shared rename/rename flows.
        node = {
          obj_token: parsed.objToken,
          obj_type: 'sheet',
          title: tokenTail(parsed.objToken),
          node_token: null,
          space_id: null,
          obj_edit_time: null,
          has_child: false,
        };
      } else {
        return {
          link: linkStr,
          ok: false,
          objToken: parsed.objToken,
          objType: parsed.objType,
          error: {
            code: 'unsupported_type',
            message: `暂不支持归档纯云文档类型 ${parsed.objType}，当前仅支持 docx / sheet`,
          },
        };
      }
    } else if (looksLikeCloudDocUrl(linkStr)) {
      // Cloud-doc URL whose token could not be read (e.g. feishu.cn/docx/).
      return {
        link: linkStr,
        ok: false,
        error: {
          code: 'parse_failed',
          message: '无法从云文档链接提取有效身份',
        },
      };
    } else {
      // 131005 on a wiki link / bare token whose cloud-doc identity cannot be
      // extracted from the URL: surface the original node-get failure so its
      // permission/auth semantics are preserved.
      const classified = classifyLinkError(error);
      return { link: linkStr, ok: false, error: classified };
    }
  }

  const objToken = node?.obj_token;
  if (!objToken || typeof objToken !== 'string') {
    return {
      link: linkStr,
      ok: false,
      error: { code: 'parse_failed', message: '无法从链接解析出云端文档身份' },
    };
  }

  const objType = node.obj_type;
  const title = typeof node.title === 'string' && node.title.trim()
    ? node.title.trim()
    : '未命名文档';

  // 2. Reject documents already present in the mapping table.
  const existing = ctx.localMapStore.getDocumentByObjToken(objToken);
  if (existing) {
    let existingLocation = STRUCTURE_TREE_LABEL;
    if (existing.customFolderId) {
      const owner = ctx.localMapStore.getCustomFolder(existing.customFolderId);
      if (owner?.name) existingLocation = owner.name;
    }
    return {
      link: linkStr,
      ok: false,
      objToken,
      title: existing.title || title,
      objType: existing.objType || objType,
      error: {
        code: 'already_exists',
        message: '该文档已存在于本地映射',
        existingLocation,
      },
    };
  }

  // 3. Type gate: docx and sheet are supported by the quick-add pipeline.
  if (!SUPPORTED_DOC_TYPES.has(objType)) {
    return {
      link: linkStr,
      ok: false,
      objToken,
      title,
      objType,
      error: {
        code: 'unsupported_type',
        message: `暂不支持归档类型 ${objType}，当前仅支持 docx / sheet`,
      },
    };
  }

  // 4. Fetch + atomic commit, then record the mapping row.
  // Resolve a collision-free relPath: same-title docs must not share one
  // file. The same-obj_token duplicate case is already rejected above, so any
  // occupant of a candidate path is a different document.
  const relPath = resolveUniqueDocRelPath(
    ctx.localMapStore,
    ctx.knowledgeBaseRoot,
    ctx.folder.localRelPath,
    title,
    objToken,
  );
  const localMdPath = resolveAbsolute(ctx.knowledgeBaseRoot, relPath);
  if (!isPathInsideRoot(ctx.knowledgeBaseRoot, localMdPath)) {
    return {
      link: linkStr,
      ok: false,
      objToken,
      title,
      objType,
      error: { code: 'fetch_failed', message: '目标路径逃逸知识库根，已拒绝写入' },
    };
  }

  // A wiki doc archived into a custom folder must leave the structure tree:
  // wiki_node_token/watched_root_* are nulled so feishu-view tree queries
  // (which filter wiki_node_token IS NOT NULL) no longer surface it. The
  // original link still carries provenance. Documents already in the
  // structure tree were rejected with already_exists above.
  let commitPlan: AtomicCommitPlan | null = null;
  try {
    // sheet cannot go through docs+fetch (lark-cli 3380002 rejects it): its
    // body is synthesized from sub-sheet CSVs via the workbook pipeline.
    const syncResult = objType === 'sheet'
      ? await syncSheetToCustomFolder({
          larkCliClient: ctx.larkCliClient,
          knowledgeBaseRoot: ctx.knowledgeBaseRoot,
          operationDirectory: ctx.operationDirectory,
          localMdPath,
          objToken,
          wikiNodeToken: null,
          title,
          originalLink: linkStr,
          objEditTime: node.obj_edit_time ?? null,
          spaceId: node.space_id ?? null,
        })
      : await syncDocxToCustomFolder({
          larkCliClient: ctx.larkCliClient,
          knowledgeBaseRoot: ctx.knowledgeBaseRoot,
          operationDirectory: ctx.operationDirectory,
          localMdPath,
          prefetchedDocument,
          objToken,
          wikiNodeToken: null,
          title,
          originalLink: linkStr,
          objEditTime: node.obj_edit_time ?? null,
          spaceId: node.space_id ?? null,
        });
    commitPlan = syncResult.commitPlan;
  } catch (error) {
    const classified = classifyLinkError(error);
    return {
      link: linkStr,
      ok: false,
      objToken,
      title,
      objType,
      error: classified,
    };
  }

  // 5. Record the documents row with the archive contract. If the DB write
  // fails — or the ownership guard refuses because the doc was inserted into
  // the structure tree during the race window — roll back the committed files
  // via the atomic-commit plan's rollback snapshots. This restores any shared
  // media file (images/attachments) that this commit overwrote to its prior
  // bytes, instead of blind-deleting it (which would destroy the version
  // another document may depend on). A rollback failure is surfaced as an
  // error and never reported as "已回滚".
  try {
    const writeResult = ctx.localMapStore.setDocumentCustomFolder({
      objToken,
      folderId: ctx.folder.id,
      wikiNodeToken: null,
      objType: SUPPORTED_DOC_TYPES.has(objType) ? objType : 'docx',
      title,
      localMdPath,
      localRelPath: relPath,
      originalLink: linkStr,
      objEditTime: node.obj_edit_time ?? null,
      spaceId: node.space_id ?? null,
    });
    if (writeResult && !writeResult.applied) {
      // Race: the doc became a structure-tree member between our dup-check and
      // this write. Refuse the archive and undo the file commit so the corpus
      // never holds a file whose mapping row stayed in the structure tree.
      const rb = rollbackAtomicPlan(commitPlan!);
      const message = rb.ok
        ? '归档期间文档进入同步结构树，已拒绝归档并回滚已写入文件'
        : `归档期间文档进入同步结构树，但文件回滚失败（${rb.error}）`;
      return {
        link: linkStr,
        ok: false,
        objToken,
        title,
        objType,
        error: {
          code: 'already_exists',
          message,
          existingLocation: STRUCTURE_TREE_LABEL,
        },
      };
    }
  } catch (dbError) {
    const rb = commitPlan ? rollbackAtomicPlan(commitPlan) : { ok: true, committed: [], restored: [] };
    const dbMessage = dbError instanceof Error ? dbError.message : String(dbError);
    const message = rb.ok
      ? `数据库写入失败，已回滚刚提交的文件：${dbMessage}`
      : `数据库写入失败且回滚失败（${rb.error}），原始错误：${dbMessage}`;
    return {
      link: linkStr,
      ok: false,
      objToken,
      title,
      objType,
      error: {
        code: 'fetch_failed',
        message,
      },
    };
  }

  return {
    link: linkStr,
    ok: true,
    objToken,
    title,
    objType,
  };
}

// ---------------------------------------------------------------------------
// Shared error helper
// ---------------------------------------------------------------------------

function errorResponse(c: any, code: string, error: unknown) {
  if (error instanceof Error && error.message === 'dependencies_not_injected') {
    return c.json({ error: 'dependencies_not_injected' }, 500);
  }
  if (
    error instanceof Error &&
    error.message === 'knowledge_base_root_not_configured'
  ) {
    return c.json({ error: 'knowledge_base_root_not_configured' }, 500);
  }
  console.error(`[custom-folders] ${code}:`, error);
  return c.json(
    {
      error: code,
      message: error instanceof Error ? error.message : String(error),
    },
    500,
  );
}

export { customFolderRoutes };
