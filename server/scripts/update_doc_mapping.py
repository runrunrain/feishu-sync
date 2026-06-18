#!/usr/bin/env python3
"""
update_doc_mapping.py — refresh a documents row after header migration.

Used by migrate-kb-structure.mjs when --update-sqlite is passed. The
project's better-sqlite3 native binding is Electron-only, so the Node
script delegates here to CPython's built-in sqlite3.

Performs an UPSERT that mirrors LocalMapStore.upsertDocumentSeen: refreshes
wiki_node_token / space_id / parent_node_token / obj_edit_time / last_seen_at
without disturbing status, local_md_path, or local_sort_order.

Usage:
  python3 update_doc_mapping.py --db <path> --obj-token <TOK> --md-path <PATH> \
      [--wiki-node-token <TOK>] [--space-id <ID>] [--parent-node-token <TOK>] \
      [--obj-edit-time <INT>] [--last-seen-at <ISO>]
"""
from __future__ import annotations

import argparse
import sqlite3
from datetime import datetime, timezone


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db", required=True)
    p.add_argument("--obj-token", required=True)
    p.add_argument("--md-path", required=True)
    p.add_argument("--wiki-node-token")
    p.add_argument("--space-id")
    p.add_argument("--parent-node-token")
    p.add_argument("--obj-edit-time", type=int)
    p.add_argument("--last-seen-at", default=datetime.now(timezone.utc).isoformat())
    args = p.parse_args()

    conn = sqlite3.connect(args.db)

    # Mirror of LocalMapStore.upsertDocumentSeen SQL.
    conn.execute(
        """
        INSERT INTO documents (
          obj_token, wiki_node_token, obj_type, title, local_md_path,
          last_synced_modify_time, last_synced_at, status,
          parent_node_token, space_id, obj_edit_time, last_seen_at
        ) VALUES (?, ?, 'unknown', '', ?, '', ?, 'placeholder', ?, ?, ?, ?)
        ON CONFLICT(obj_token) DO UPDATE SET
          wiki_node_token = COALESCE(excluded.wiki_node_token, documents.wiki_node_token),
          parent_node_token = COALESCE(excluded.parent_node_token, documents.parent_node_token),
          space_id = COALESCE(excluded.space_id, documents.space_id),
          obj_edit_time = COALESCE(excluded.obj_edit_time, documents.obj_edit_time),
          last_seen_at = excluded.last_seen_at,
          updated_at = datetime('now')
        """,
        (
            args.obj_token,
            args.wiki_node_token,
            args.md_path,
            args.last_seen_at,
            args.parent_node_token,
            args.space_id,
            args.obj_edit_time,
            args.last_seen_at,
        ),
    )
    conn.commit()
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
