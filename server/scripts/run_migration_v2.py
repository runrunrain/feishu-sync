#!/usr/bin/env python3
"""
run_migration_v2.py — runner for migration_v2.sql

Why Python (not Node): the project's better-sqlite3 native binding is
compiled against Electron 31 (NODE_MODULE_VERSION 125). Plain `node` is
v24 (NODE_MODULE_VERSION 137) so the .node file refuses to load. SQLite
migrations are one-shot offline operations, so we avoid the ABI dance and
use CPython's built-in sqlite3 module (3.13+ ships a recent SQLite).

Flow:
  1. Resolve DB path (default: ~/.feishu-sync/feishu-sync.db; override via --db)
  2. Backup DB to <db>.bak-v2-<timestamp>
  3. Snapshot documents row count + sample for integrity verification
  4. Apply additive ALTER TABLE statements for missing columns
  5. Apply static DDL (indexes, sheet_sheets, schema_migrations)
     — all idempotent (CREATE IF NOT EXISTS / INSERT OR REPLACE)
  6. Verify: row count unchanged + new columns present + schema_migrations
     contains v2_mapping_expansion

Usage:
  python3 server/scripts/run_migration_v2.py [--db <path>] [--dry-run]
"""
from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

SCHEMA_VERSION = "v2_mapping_expansion"

REQUIRED_COLUMNS = [
    # (name, type, ALTER DML)
    ("parent_node_token", "TEXT", "ALTER TABLE documents ADD COLUMN parent_node_token TEXT"),
    ("space_id", "TEXT", "ALTER TABLE documents ADD COLUMN space_id TEXT"),
    ("obj_edit_time", "INTEGER", "ALTER TABLE documents ADD COLUMN obj_edit_time INTEGER"),
    ("cloud_deleted", "INTEGER",
     "ALTER TABLE documents ADD COLUMN cloud_deleted INTEGER NOT NULL DEFAULT 0"),
    ("last_seen_at", "TEXT", "ALTER TABLE documents ADD COLUMN last_seen_at TEXT"),
    ("local_sort_order", "INTEGER", "ALTER TABLE documents ADD COLUMN local_sort_order INTEGER"),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=str(Path.home() / ".feishu-sync" / "feishu-sync.db"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    db_path = Path(args.db)
    print(f"[migration_v2] DB path: {db_path}")
    print(f"[migration_v2] Mode: {'DRY-RUN' if args.dry_run else 'APPLY'}")

    if not db_path.exists():
        print(f"[migration_v2] DB file does not exist: {db_path}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    # Step 1: pre-migration snapshot
    before_count = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    before_sample = conn.execute(
        "SELECT obj_token, local_md_path, status FROM documents LIMIT 5"
    ).fetchall()
    print(f"[migration_v2] Pre-migration documents row count: {before_count}")
    for row in before_sample:
        print(f"  sample: obj_token={row['obj_token']} status={row['status']}")

    # Step 2: determine which ALTERs are needed
    current_cols = {r[1] for r in conn.execute("PRAGMA table_info(documents)").fetchall()}
    pending = [c for c in REQUIRED_COLUMNS if c[0] not in current_cols]
    if pending:
        names = ", ".join(c[0] for c in pending)
        print(f"[migration_v2] Columns to add: {names}")
    else:
        print("[migration_v2] Columns to add: none (already migrated)")

    if args.dry_run:
        print("[migration_v2] Dry-run preview:")
        for c in pending:
            print(f"  would: {c[2]}")
        print("  would: CREATE documents indexes (5)")
        print("  would: CREATE sheet_sheets table + 2 indexes")
        print(f"  would: INSERT schema_migrations version={SCHEMA_VERSION}")
        conn.close()
        return 0

    # Step 3: backup
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    backup_path = db_path.with_name(f"{db_path.name}.bak-v2-{stamp}")
    shutil.copy2(db_path, backup_path)
    print(f"[migration_v2] Backup written: {backup_path}")

    # Step 4: apply migration atomically
    try:
        cur = conn.cursor()
        cur.execute("BEGIN")
        for name, _type, dml in pending:
            cur.execute(dml)
            print(f"[migration_v2] + documents.{name}")

        cur.executescript("""
            CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents(parent_node_token);
            CREATE INDEX IF NOT EXISTS idx_documents_space ON documents(space_id);
            CREATE INDEX IF NOT EXISTS idx_documents_cloud_deleted ON documents(cloud_deleted);
            CREATE INDEX IF NOT EXISTS idx_documents_obj_edit_time ON documents(obj_edit_time);
            CREATE INDEX IF NOT EXISTS idx_documents_parent_sort ON documents(parent_node_token, local_sort_order);
        """)
        print("[migration_v2] + documents indexes (5)")

        cur.executescript("""
            CREATE TABLE IF NOT EXISTS sheet_sheets (
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
            CREATE INDEX IF NOT EXISTS idx_sheet_sheets_sheet_obj ON sheet_sheets(sheet_obj_token);
            CREATE INDEX IF NOT EXISTS idx_sheet_sheets_status ON sheet_sheets(status);
        """)
        print("[migration_v2] + sheet_sheets table + 2 indexes")

        cur.executescript("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version    TEXT PRIMARY KEY,
              applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        """)
        cur.execute(
            "INSERT OR REPLACE INTO schema_migrations(version) VALUES (?)",
            (SCHEMA_VERSION,),
        )
        print(f"[migration_v2] + schema_migrations record: {SCHEMA_VERSION}")

        conn.commit()
        print("[migration_v2] Transaction committed.")
    except Exception as exc:
        conn.rollback()
        conn.close()
        # Restore from backup so DB stays in pre-migration state.
        shutil.copy2(backup_path, db_path)
        print(f"[migration_v2] Migration failed, restored from backup: {exc}", file=sys.stderr)
        return 1

    # Step 5: verification
    after_cols = {r[1] for r in conn.execute("PRAGMA table_info(documents)").fetchall()}
    missing = [c[0] for c in REQUIRED_COLUMNS if c[0] not in after_cols]
    if missing:
        print(f"[migration_v2] VERIFY FAIL: missing columns {missing}", file=sys.stderr)
        conn.close()
        return 1

    after_count = conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    if after_count != before_count:
        print(
            f"[migration_v2] VERIFY FAIL: row count changed {before_count} -> {after_count}",
            file=sys.stderr,
        )
        conn.close()
        return 1

    version_row = conn.execute(
        "SELECT version, applied_at FROM schema_migrations WHERE version = ?",
        (SCHEMA_VERSION,),
    ).fetchone()
    if version_row is None:
        print("[migration_v2] VERIFY FAIL: schema_migrations row missing", file=sys.stderr)
        conn.close()
        return 1

    print("[migration_v2] Verification:")
    print(f"  documents row count: {after_count} (unchanged from {before_count})")
    print(f"  documents columns: {len(after_cols)} (was {len(current_cols)})")
    print(f"  schema_migrations: {version_row['version']} applied_at {version_row['applied_at']}")

    conn.close()
    print("[migration_v2] Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
