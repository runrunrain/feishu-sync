#!/usr/bin/env python3
"""
SQL-equivalence test for LocalMapStore v0.2.0 methods.

Context: the project's better-sqlite3 native binding is compiled for
Electron 31 (NODE_MODULE_VERSION 125), so it cannot be loaded from plain
`node` v24 (NODE_MODULE_VERSION 137) which is what vitest uses. Running
`electron-rebuild` to fix this would break the desktop runtime.

This script mirrors the SQL emitted by LocalMapStore's v0.2.0 methods
against an in-memory SQLite DB (Python builtin sqlite3) and asserts the
same behavioral contracts the TS test would have. The actual TS code is
covered by `tsc --noEmit`; the SQL strings it sends are reproduced
verbatim here so the test exercises the real queries.

Run: python3 server/tests/local_map_store_sql.py
Exit 0 = all pass.
"""
from __future__ import annotations

import sqlite3
import sys


def fresh_db() -> sqlite3.Connection:
    """Schema mirroring post-migration-v2 state."""
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE TABLE documents (
          obj_token TEXT PRIMARY KEY,
          wiki_node_token TEXT,
          obj_type TEXT NOT NULL CHECK(obj_type IN ('docx','sheet','slides','unknown')),
          title TEXT NOT NULL,
          local_md_path TEXT NOT NULL,
          last_synced_modify_time TEXT NOT NULL,
          last_synced_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'synced' CHECK(status IN ('synced','changed','error','placeholder')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          parent_node_token TEXT,
          space_id TEXT,
          obj_edit_time INTEGER,
          cloud_deleted INTEGER NOT NULL DEFAULT 0,
          last_seen_at TEXT,
          local_sort_order INTEGER
        );
        CREATE TABLE sheet_sheets (
          sheet_obj_token TEXT NOT NULL,
          sheet_id        TEXT NOT NULL,
          sheet_title     TEXT NOT NULL,
          local_csv_path  TEXT NOT NULL,
          local_md_path   TEXT,
          last_synced_modify_time TEXT,
          status          TEXT NOT NULL DEFAULT 'synced' CHECK(status IN ('synced','changed','error','placeholder')),
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (sheet_obj_token, sheet_id),
          FOREIGN KEY (sheet_obj_token) REFERENCES documents(obj_token) ON DELETE CASCADE
        );
        CREATE TABLE sync_log (
          sync_id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          success_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          duration INTEGER,
          context TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE run_log (
          log_id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          level TEXT NOT NULL CHECK(level IN ('debug','info','warn','error')),
          message TEXT NOT NULL,
          context TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        """
    )
    return conn


def assert_eq(label: str, got, expected) -> None:
    if got != expected:
        print(f"FAIL {label}\n  expected: {expected!r}\n  got:      {got!r}")
        sys.exit(1)
    print(f"PASS {label}")


def test_upsert_roundtrip():
    conn = fresh_db()
    upsert_document(conn, dict(
        objToken="TOK1", wikiNodeToken="WNT1", objType="docx",
        title="doc1", localMdPath="/d/doc1.md",
        lastSyncedModifyTime="2026-06-18T00:00:00Z",
        lastSyncedAt="2026-06-18T00:00:00Z", status="synced",
        parentNodeToken="PARENT_A", spaceId="SPACE_X",
        objEditTime=1718700000, cloudDeleted=0,
        lastSeenAt="2026-06-18T00:00:00Z", localSortOrder=3,
    ))
    row = conn.execute(
        "SELECT parent_node_token, space_id, obj_edit_time, cloud_deleted, last_seen_at, local_sort_order FROM documents WHERE obj_token='TOK1'"
    ).fetchone()
    assert_eq("upsert roundtrip parent", row[0], "PARENT_A")
    assert_eq("upsert roundtrip space", row[1], "SPACE_X")
    assert_eq("upsert roundtrip obj_edit_time", row[2], 1718700000)
    assert_eq("upsert roundtrip cloud_deleted", row[3], 0)
    assert_eq("upsert roundtrip local_sort_order", row[5], 3)


def test_partial_update_preserves_mapping():
    conn = fresh_db()
    upsert_document(conn, dict(
        objToken="TOK2", wikiNodeToken="WNT2", objType="docx",
        title="orig", localMdPath="/d/orig.md",
        lastSyncedModifyTime="2026-06-18T00:00:00Z",
        lastSyncedAt="2026-06-18T00:00:00Z", status="synced",
        parentNodeToken="PARENT_B", spaceId="SPACE_Y",
        objEditTime=1718800000,
    ))
    # Subsequent write with only v0.1.0 fields (NULL parentNodeToken etc.)
    upsert_document(conn, dict(
        objToken="TOK2", wikiNodeToken=None, objType="docx",
        title="updated title", localMdPath="/d/updated.md",
        lastSyncedModifyTime="2026-06-18T01:00:00Z",
        lastSyncedAt="2026-06-18T01:00:00Z", status="synced",
        parentNodeToken=None, spaceId=None, objEditTime=None,
        cloudDeleted=None, lastSeenAt=None, localSortOrder=None,
    ))
    row = conn.execute(
        "SELECT title, local_md_path, parent_node_token, space_id, obj_edit_time FROM documents WHERE obj_token='TOK2'"
    ).fetchone()
    assert_eq("partial update title", row[0], "updated title")
    assert_eq("partial update local_md_path", row[1], "/d/updated.md")
    assert_eq("partial update parent preserved", row[2], "PARENT_B")
    assert_eq("partial update space preserved", row[3], "SPACE_Y")
    assert_eq("partial update obj_edit_time preserved", row[4], 1718800000)


def test_upsert_document_seen_inserts_placeholder():
    conn = fresh_db()
    upsert_document_seen(conn, dict(
        objToken="NEW", wikiNodeToken="WNT_NEW",
        parentNodeToken="PARENT_NEW", spaceId="SPACE_NEW",
        objEditTime=1718900000, lastSeenAt="2026-06-18T02:00:00Z",
    ))
    row = conn.execute(
        "SELECT parent_node_token, space_id, obj_edit_time, last_seen_at, status FROM documents WHERE obj_token='NEW'"
    ).fetchone()
    assert_eq("upsert seen parent", row[0], "PARENT_NEW")
    assert_eq("upsert seen status placeholder", row[4], "placeholder")


def test_upsert_document_seen_preserves_sync_fields():
    conn = fresh_db()
    upsert_document(conn, dict(
        objToken="EX", wikiNodeToken=None, objType="docx",
        title="real", localMdPath="/d/real.md",
        lastSyncedModifyTime="2026-06-18T00:00:00Z",
        lastSyncedAt="2026-06-18T00:00:00Z", status="synced",
    ))
    upsert_document_seen(conn, dict(
        objToken="EX", wikiNodeToken="WNT_REAL",
        parentNodeToken="PARENT_REAL", spaceId="SPACE_REAL",
        objEditTime=1719000000, lastSeenAt="2026-06-18T03:00:00Z",
    ))
    row = conn.execute(
        "SELECT title, local_md_path, status, parent_node_token, obj_edit_time, wiki_node_token FROM documents WHERE obj_token='EX'"
    ).fetchone()
    assert_eq("seen preserves title", row[0], "real")
    assert_eq("seen preserves local_md_path", row[1], "/d/real.md")
    assert_eq("seen preserves status", row[2], "synced")
    assert_eq("seen updates parent", row[3], "PARENT_REAL")
    assert_eq("seen updates obj_edit_time", row[4], 1719000000)
    assert_eq("seen updates wiki_node_token", row[5], "WNT_REAL")


def test_mark_cloud_deleted():
    conn = fresh_db()
    upsert_document(conn, dict(
        objToken="DOOMED", wikiNodeToken=None, objType="docx",
        title="d", localMdPath="/d/d.md",
        lastSyncedModifyTime="2026-06-18T00:00:00Z",
        lastSyncedAt="2026-06-18T00:00:00Z", status="synced",
    ))
    conn.execute(
        "UPDATE documents SET cloud_deleted=1, last_seen_at=?, updated_at=datetime('now') WHERE obj_token=?",
        ("2026-06-18T04:00:00Z", "DOOMED"),
    )
    row = conn.execute(
        "SELECT cloud_deleted, last_seen_at FROM documents WHERE obj_token='DOOMED'"
    ).fetchone()
    assert_eq("mark cloud_deleted=1", row[0], 1)
    assert_eq("mark last_seen_at", row[1], "2026-06-18T04:00:00Z")


def test_sheet_sheets_upsert_and_get():
    conn = fresh_db()
    upsert_document(conn, dict(
        objToken="SHP", wikiNodeToken=None, objType="sheet",
        title="parent", localMdPath="/d/p.md",
        lastSyncedModifyTime="2026-06-18T00:00:00Z",
        lastSyncedAt="2026-06-18T00:00:00Z", status="synced",
    ))
    upsert_sheet_sheet(conn, dict(
        sheetObjToken="SHP", sheetId="sub1", sheetTitle="Sub 1",
        localCsvPath="/d/sub1.csv", localMdPath="/d/sub1.md",
    ))
    upsert_sheet_sheet(conn, dict(
        sheetObjToken="SHP", sheetId="sub2", sheetTitle="Sub 2",
        localCsvPath="/d/sub2.csv",
    ))
    rows = conn.execute(
        "SELECT sheet_id FROM sheet_sheets WHERE sheet_obj_token='SHP' ORDER BY sheet_id"
    ).fetchall()
    assert_eq("sheet_sheets count", len(rows), 2)
    assert_eq("sheet_sheets sub1", rows[0][0], "sub1")
    assert_eq("sheet_sheets sub2", rows[1][0], "sub2")


def test_sheet_sheets_upsert_preserves_md_path():
    conn = fresh_db()
    upsert_document(conn, dict(
        objToken="SH2", wikiNodeToken=None, objType="sheet",
        title="p2", localMdPath="/d/p2.md",
        lastSyncedModifyTime="2026-06-18T00:00:00Z",
        lastSyncedAt="2026-06-18T00:00:00Z", status="synced",
    ))
    upsert_sheet_sheet(conn, dict(
        sheetObjToken="SH2", sheetId="a", sheetTitle="A",
        localCsvPath="/d/a.csv", localMdPath="/d/a.md",
    ))
    upsert_sheet_sheet(conn, dict(
        sheetObjToken="SH2", sheetId="a", sheetTitle="A (renamed)",
        localCsvPath="/d/a.csv",
    ))
    row = conn.execute(
        "SELECT sheet_title, local_md_path FROM sheet_sheets WHERE sheet_obj_token='SH2' AND sheet_id='a'"
    ).fetchone()
    assert_eq("sheet_sheets title renamed", row[0], "A (renamed)")
    assert_eq("sheet_sheets md_path preserved", row[1], "/d/a.md")


def test_set_sort_order_scoped_by_parent():
    conn = fresh_db()
    for tok, parent in [("C1", "PX"), ("C2", "PX"), ("C3", "PX"), ("D1", "PY")]:
        upsert_document(conn, dict(
            objToken=tok, wikiNodeToken=None, objType="docx",
            title=tok, localMdPath=f"/d/{tok}.md",
            lastSyncedModifyTime="2026-06-18T00:00:00Z",
            lastSyncedAt="2026-06-18T00:00:00Z", status="synced",
            parentNodeToken=parent,
        ))
    updated = set_sort_order(conn, "PX", ["C3", "C1", "C2"])
    assert_eq("set_sort_order updated count", updated, 3)
    so = {r[0]: r[1] for r in conn.execute(
        "SELECT obj_token, local_sort_order FROM documents WHERE obj_token IN ('C1','C2','C3','D1')"
    ).fetchall()}
    assert_eq("sort C3 first", so["C3"], 0)
    assert_eq("sort C1 second", so["C1"], 1)
    assert_eq("sort C2 third", so["C2"], 2)
    assert_eq("sort D1 untouched", so["D1"], None)


def test_set_sort_order_rejects_cross_parent():
    conn = fresh_db()
    upsert_document(conn, dict(
        objToken="ORPHAN", wikiNodeToken=None, objType="docx",
        title="orphan", localMdPath="/d/o.md",
        lastSyncedModifyTime="2026-06-18T00:00:00Z",
        lastSyncedAt="2026-06-18T00:00:00Z", status="synced",
        parentNodeToken="PX",
    ))
    updated = set_sort_order(conn, "PNONEXIST", ["ORPHAN"])
    assert_eq("cross-parent rejected", updated, 0)
    row = conn.execute(
        "SELECT local_sort_order FROM documents WHERE obj_token='ORPHAN'"
    ).fetchone()
    assert_eq("cross-parent no write", row[0], None)


def test_set_sort_order_top_level_null_parent():
    """R2.2bis-AC1 (top-level scope): parent_node_token=NULL scopes
    the UPDATE to top-level rows only. Verifies NULL = NULL equality
    via `IS ?` binding, which is how TS source differentiates NULL
    parent from a string parent containing the literal 'null'."""
    conn = fresh_db()
    for tok, parent in [("T1", None), ("T2", None), ("CHILD", "T1_WNT")]:
        upsert_document(conn, dict(
            objToken=tok, wikiNodeToken=f"{tok}_WNT", objType="docx",
            title=tok, localMdPath=f"/d/{tok}.md",
            lastSyncedModifyTime="2026-06-18T00:00:00Z",
            lastSyncedAt="2026-06-18T00:00:00Z", status="synced",
            parentNodeToken=parent,
        ))
    updated = set_sort_order(conn, None, ["T2", "T1"])
    assert_eq("top-level reorder updated count", updated, 2)
    so = {r[0]: r[1] for r in conn.execute(
        "SELECT obj_token, local_sort_order FROM documents"
    ).fetchall()}
    assert_eq("top-level T2 first", so["T2"], 0)
    assert_eq("top-level T1 second", so["T1"], 1)
    # Child row is NOT touched (parent != NULL).
    assert_eq("child untouched by top-level reorder", so["CHILD"], None)


def test_upsert_document_preserves_user_sort_order_across_sync():
    """R2.2bis-AC3 (sync preserves user order): the sync flow calls
    upsertDocument() with whatever fields it knows (v0.1.0 set).
    The COALESCE pattern in the ON CONFLICT clause MUST preserve the
    existing local_sort_order (sync flow never knows about it).
    This is the SQL-level guarantee that user reorder survives sync."""
    conn = fresh_db()
    # 1. Initial sync write.
    upsert_document(conn, dict(
        objToken="DOCSYNC", wikiNodeToken="WNT_S", objType="docx",
        title="orig", localMdPath="/d/orig.md",
        lastSyncedModifyTime="2026-06-18T00:00:00Z",
        lastSyncedAt="2026-06-18T00:00:00Z", status="synced",
        parentNodeToken="PARENT_X",
    ))
    # 2. User reorders; setSortOrder writes local_sort_order=5.
    set_sort_order(conn, "PARENT_X", ["DOCSYNC"])
    mid = conn.execute(
        "SELECT local_sort_order FROM documents WHERE obj_token='DOCSYNC'"
    ).fetchone()[0]
    assert_eq("user reorder applied", mid, 0)
    # Re-apply with explicit index 5 (simulating multi-token reorder).
    conn.execute(
        "UPDATE documents SET local_sort_order=5 WHERE obj_token='DOCSYNC'"
    )
    # 3. Subsequent sync call (does NOT pass localSortOrder).
    upsert_document(conn, dict(
        objToken="DOCSYNC", wikiNodeToken="WNT_S", objType="docx",
        title="updated by sync", localMdPath="/d/updated.md",
        lastSyncedModifyTime="2026-06-18T01:00:00Z",
        lastSyncedAt="2026-06-18T01:00:00Z", status="synced",
        parentNodeToken=None, spaceId=None, objEditTime=None,
        cloudDeleted=None, lastSeenAt=None, localSortOrder=None,
    ))
    row = conn.execute(
        "SELECT title, local_md_path, local_sort_order FROM documents WHERE obj_token='DOCSYNC'"
    ).fetchone()
    assert_eq("sync updates title", row[0], "updated by sync")
    assert_eq("sync updates path", row[1], "/d/updated.md")
    # CRITICAL: local_sort_order MUST be preserved (sync does not own this field).
    assert_eq("sync preserves local_sort_order", row[2], 5)



# --- P2-T3 trash-bin methods (restore / purge / list) ----------------------

def test_restore_cloud_deleted_clears_flag():
    """restoreCloudDeleted should clear cloud_deleted back to 0 so the
    row is treated as live again. Mirrors TS source."""
    conn = fresh_db()
    upsert_document(conn, dict(
        objToken="RES", wikiNodeToken=None, objType="docx",
        title="res", localMdPath="/d/res.md",
        lastSyncedModifyTime="2026-06-18T00:00:00Z",
        lastSyncedAt="2026-06-18T00:00:00Z", status="synced",
    ))
    # Mark soft-deleted first
    mark_cloud_deleted(conn, "RES", "2026-06-18T04:00:00Z")
    assert_eq("pre-restore cloud_deleted=1",
              conn.execute("SELECT cloud_deleted FROM documents WHERE obj_token='RES'").fetchone()[0], 1)
    restore_cloud_deleted(conn, "RES")
    assert_eq("post-restore cloud_deleted=0",
              conn.execute("SELECT cloud_deleted FROM documents WHERE obj_token='RES'").fetchone()[0], 0)


def test_purge_cloud_deleted_removes_row_and_cascades():
    """purgeCloudDeleted hard-deletes the documents row; FK ON DELETE
    CASCADE drops associated sheet_sheets rows."""
    conn = fresh_db()
    # Enable FK enforcement (off by default in sqlite3 CLI).
    conn.execute("PRAGMA foreign_keys = ON")
    upsert_document(conn, dict(
        objToken="PURGE", wikiNodeToken=None, objType="sheet",
        title="p", localMdPath="/d/p.md",
        lastSyncedModifyTime="2026-06-18T00:00:00Z",
        lastSyncedAt="2026-06-18T00:00:00Z", status="synced",
    ))
    upsert_sheet_sheet(conn, dict(
        sheetObjToken="PURGE", sheetId="s1", sheetTitle="S1",
        localCsvPath="/d/s1.csv",
    ))
    upsert_sheet_sheet(conn, dict(
        sheetObjToken="PURGE", sheetId="s2", sheetTitle="S2",
        localCsvPath="/d/s2.csv",
    ))
    assert_eq("pre-purge sheet_sheets count",
              conn.execute("SELECT COUNT(*) FROM sheet_sheets WHERE sheet_obj_token='PURGE'").fetchone()[0], 2)
    purge_cloud_deleted(conn, "PURGE")
    assert_eq("post-purge documents row gone",
              conn.execute("SELECT COUNT(*) FROM documents WHERE obj_token='PURGE'").fetchone()[0], 0)
    assert_eq("post-purge sheet_sheets cascade dropped",
              conn.execute("SELECT COUNT(*) FROM sheet_sheets WHERE sheet_obj_token='PURGE'").fetchone()[0], 0)


def test_list_cloud_deleted_returns_only_soft_deleted_ordered():
    """listCloudDeleted returns rows where cloud_deleted=1, ordered by
    last_seen_at desc then updated_at desc."""
    conn = fresh_db()
    for tok, seen in [("A", "2026-06-01T00:00:00Z"),
                      ("B", "2026-06-18T10:00:00Z"),
                      ("C", "2026-06-15T00:00:00Z")]:
        upsert_document(conn, dict(
            objToken=tok, wikiNodeToken=None, objType="docx",
            title=tok, localMdPath=f"/d/{tok}.md",
            lastSyncedModifyTime="2026-06-01T00:00:00Z",
            lastSyncedAt="2026-06-01T00:00:00Z", status="synced",
        ))
        mark_cloud_deleted(conn, tok, seen)
    # Add a live row that must NOT appear in the trash listing.
    upsert_document(conn, dict(
        objToken="LIVE", wikiNodeToken=None, objType="docx",
        title="live", localMdPath="/d/live.md",
        lastSyncedModifyTime="2026-06-01T00:00:00Z",
        lastSyncedAt="2026-06-01T00:00:00Z", status="synced",
    ))
    rows = list_cloud_deleted(conn)
    tokens = [r[0] for r in rows]
    assert_eq("trash excludes live rows", "LIVE" in tokens, False)
    assert_eq("trash contains 3 soft-deleted", len(tokens), 3)
    # Ordered by last_seen_at desc: B (06-18) > C (06-15) > A (06-01)
    assert_eq("trash newest first", tokens, ["B", "C", "A"])


# ---------------------------------------------------------------------------
# SQL mirrors of LocalMapStore methods (verbatim from src code)
# ---------------------------------------------------------------------------

UPSERT_DOCUMENT_SQL = """
INSERT INTO documents (
  obj_token, wiki_node_token, obj_type, title, local_md_path,
  last_synced_modify_time, last_synced_at, status,
  parent_node_token, space_id, obj_edit_time,
  cloud_deleted, last_seen_at, local_sort_order
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(obj_token) DO UPDATE SET
  wiki_node_token = COALESCE(excluded.wiki_node_token, documents.wiki_node_token),
  obj_type = COALESCE(excluded.obj_type, documents.obj_type),
  title = excluded.title,
  local_md_path = excluded.local_md_path,
  last_synced_modify_time = excluded.last_synced_modify_time,
  last_synced_at = excluded.last_synced_at,
  status = excluded.status,
  parent_node_token = COALESCE(excluded.parent_node_token, documents.parent_node_token),
  space_id = COALESCE(excluded.space_id, documents.space_id),
  obj_edit_time = COALESCE(excluded.obj_edit_time, documents.obj_edit_time),
  cloud_deleted = COALESCE(excluded.cloud_deleted, documents.cloud_deleted),
  last_seen_at = COALESCE(excluded.last_seen_at, documents.last_seen_at),
  local_sort_order = documents.local_sort_order,
  updated_at = datetime('now')
"""

UPSERT_DOCUMENT_SEEN_SQL = """
INSERT INTO documents (
  obj_token, wiki_node_token, obj_type, title, local_md_path,
  last_synced_modify_time, last_synced_at, status,
  parent_node_token, space_id, obj_edit_time, last_seen_at
) VALUES (?, ?, 'unknown', '', '', '', ?, 'placeholder', ?, ?, ?, ?)
ON CONFLICT(obj_token) DO UPDATE SET
  wiki_node_token = COALESCE(excluded.wiki_node_token, documents.wiki_node_token),
  parent_node_token = COALESCE(excluded.parent_node_token, documents.parent_node_token),
  space_id = COALESCE(excluded.space_id, documents.space_id),
  obj_edit_time = COALESCE(excluded.obj_edit_time, documents.obj_edit_time),
  last_seen_at = excluded.last_seen_at,
  updated_at = datetime('now')
"""

UPSERT_SHEET_SHEET_SQL = """
INSERT INTO sheet_sheets (
  sheet_obj_token, sheet_id, sheet_title, local_csv_path,
  local_md_path, last_synced_modify_time, status
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(sheet_obj_token, sheet_id) DO UPDATE SET
  sheet_title = excluded.sheet_title,
  local_csv_path = excluded.local_csv_path,
  local_md_path = COALESCE(excluded.local_md_path, sheet_sheets.local_md_path),
  last_synced_modify_time = COALESCE(excluded.last_synced_modify_time, sheet_sheets.last_synced_modify_time),
  status = excluded.status,
  updated_at = datetime('now')
"""

SET_SORT_ORDER_SQL = """
UPDATE documents
SET local_sort_order = ?, updated_at = datetime('now')
WHERE obj_token = ? AND parent_node_token IS ?
"""

# P2-T3 trash-bin methods (verbatim from server/src/modules/local-map-store.ts)
MARK_CLOUD_DELETED_SQL = """
UPDATE documents
SET cloud_deleted = 1, last_seen_at = ?, updated_at = datetime('now')
WHERE obj_token = ?
"""

RESTORE_CLOUD_DELETED_SQL = """
UPDATE documents
SET cloud_deleted = 0, updated_at = datetime('now')
WHERE obj_token = ?
"""

PURGE_CLOUD_DELETED_SQL = """
DELETE FROM documents WHERE obj_token = ?
"""

LIST_CLOUD_DELETED_SQL = """
SELECT * FROM documents
WHERE cloud_deleted = 1
ORDER BY last_seen_at DESC, updated_at DESC
"""


def upsert_document(conn, r):
    conn.execute(
        UPSERT_DOCUMENT_SQL,
        (
            r["objToken"], r.get("wikiNodeToken"), r["objType"], r["title"],
            r["localMdPath"], r["lastSyncedModifyTime"], r["lastSyncedAt"],
            r["status"], r.get("parentNodeToken"), r.get("spaceId"),
            r.get("objEditTime"), r.get("cloudDeleted", 0) or 0,
            r.get("lastSeenAt"), r.get("localSortOrder"),
        ),
    )


def upsert_document_seen(conn, r):
    conn.execute(
        UPSERT_DOCUMENT_SEEN_SQL,
        (
            r["objToken"], r.get("wikiNodeToken"), r["lastSeenAt"],
            r.get("parentNodeToken"), r.get("spaceId"), r.get("objEditTime"),
            r["lastSeenAt"],
        ),
    )


def upsert_sheet_sheet(conn, r):
    conn.execute(
        UPSERT_SHEET_SHEET_SQL,
        (
            r["sheetObjToken"], r["sheetId"], r["sheetTitle"],
            r["localCsvPath"], r.get("localMdPath"),
            r.get("lastSyncedModifyTime"),
            r.get("status", "synced"),
        ),
    )


def set_sort_order(conn, parent, ordered):
    updated = 0
    for idx, tok in enumerate(ordered):
        cur = conn.execute(SET_SORT_ORDER_SQL, (idx, tok, parent))
        updated += cur.rowcount
    return updated


def mark_cloud_deleted(conn, obj_token, timestamp):
    conn.execute(MARK_CLOUD_DELETED_SQL, (timestamp, obj_token))


def restore_cloud_deleted(conn, obj_token):
    conn.execute(RESTORE_CLOUD_DELETED_SQL, (obj_token,))


def purge_cloud_deleted(conn, obj_token):
    conn.execute(PURGE_CLOUD_DELETED_SQL, (obj_token,))


def list_cloud_deleted(conn):
    return conn.execute(LIST_CLOUD_DELETED_SQL).fetchall()


def main():
    print("=" * 60)
    print("LocalMapStore v0.2.0 SQL-equivalence tests")
    print("=" * 60)
    test_upsert_roundtrip()
    test_partial_update_preserves_mapping()
    test_upsert_document_seen_inserts_placeholder()
    test_upsert_document_seen_preserves_sync_fields()
    test_mark_cloud_deleted()
    test_sheet_sheets_upsert_and_get()
    test_sheet_sheets_upsert_preserves_md_path()
    test_set_sort_order_scoped_by_parent()
    test_set_sort_order_rejects_cross_parent()
    test_set_sort_order_top_level_null_parent()
    test_upsert_document_preserves_user_sort_order_across_sync()
    test_restore_cloud_deleted_clears_flag()
    test_purge_cloud_deleted_removes_row_and_cascades()
    test_list_cloud_deleted_returns_only_soft_deleted_ordered()
    print("=" * 60)
    print("All LocalMapStore SQL-equivalence tests passed.")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
