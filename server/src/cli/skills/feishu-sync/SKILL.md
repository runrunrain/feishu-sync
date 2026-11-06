---
name: feishu-sync
description: Use the local Feishu Sync app CLI to inspect sync and standard-library status, review pending source changes, build the standard library, or perform supported Feishu Sync operations on request.
---

# Feishu Sync CLI

Start with `feishu-sync --help`. Use `feishu-sync <command> --help` to confirm the installed version's flags and risk level before issuing a command.

If the command is missing from PATH, invoke the installed shim by its full path using your shell's quoting rules. In PowerShell use the call operator `&`. Read the following JSON string as the managed shim path for this device.

    {{FEISHU_SYNC_SHIM}}

For a shared or unpacked copy of this skill, the default shim is `~/.feishu-sync/bin/feishu-sync` on macOS and Linux and `%USERPROFILE%\.feishu-sync\bin\feishu-sync.cmd` on Windows. The app shows the exact path in 设置 → 应用 → 命令行访问.

## Common workflows

- Check the app and library with `feishu-sync status --json` and `feishu-sync kb status --json`.
- Inspect pending source differences with `feishu-sync kb changes --json` before updating the standard library. Use `feishu-sync kb build --help` to choose the build mode and `feishu-sync kb builds --help` to check build progress.
- Read configuration with `feishu-sync config get --json`. Use the command-specific help before changing settings or operating on source documents.
- For cleanup, preview with `feishu-sync clean orphans --json`. Apply cleanup or write back to Feishu only within the user's authorized scope. Where the CLI requires `--yes`, add it after the user has authorized the specific mutation.

Read the JSON envelope and exit status. Exit `2` indicates an argument error, `3` indicates the app or CLI endpoint is unavailable, and `4` indicates confirmation is required. If the endpoint is unavailable, check that the desktop app is running and 命令行访问 is enabled. The CLI handles the local credential. Keep endpoint file contents and tokens out of logs and replies.
