amagi-pi is privately distributed inside the application. `package.zip` and
`manifest.json` are release inputs and must ship together; no repository credentials
or access to a public npm package is needed on the end user's device.

Source resolution lives in `server/scripts/lib/amagi-source.mjs`. `AMAGI_PI_SOURCE_DIR`
and `AMAGI_PI_USE_BUNDLED=1` are honored first (no network). Desktop installer builds
(`scripts/build-desktop-target.cjs`) enable `AMAGI_PI_LATEST=1` by default: the remote
default branch HEAD (or `AMAGI_PI_REF`, a branch or 40-hex sha) is shallow-fetched and
validated — stable amagi-pi semver, major version 2 (`SUPPORTED_AMAGI_MAJOR`), never
lower than the checked-in manifest (no downgrades). On failure it degrades to a sibling
`amagi-pi` checkout and then this frozen bundle, each with a one-line WARN, unless
`AMAGI_PI_REQUIRE_LATEST=1` fails the build. Other builds (`npm run server:build`, CI
tests) never touch the network: sibling checkout when present, else this frozen bundle.

The manifest currently pins 2.22.0 (sourceCommit 9b155e0e). The 2.21.36 bundle was the
last to require the app's reviewed background-continuation and queued-shutdown patch;
2.22.0 ships the equivalent fixes upstream (`shouldAutoContinue` in task-background.ts,
`cleanupChildrenOnShutdown` in task-run.ts) and carries no `localPatchSha256`.

Bundling uses npm's publication file list and exact locked production dependencies,
excluding Git metadata, developer tools and local state. Output is deterministic: the
same source, lock and patch always rebuild byte-identical archives. Refresh this
frozen bundle with `cd server && npm run build && npm run amagi:refresh`, then commit
the two changed files. The app unpacks and verifies the bundle, then registers it
through the existing Pi local-package installer under the app's private data directory.

Updates follow application releases. Each content revision has its own immutable
installation directory; builds already started retain their original package.
The build runtime loads amagi's native task tools. Ordinary chat sessions retain
the app's controlled task tools because their native names overlap.

Private distribution does not obfuscate plugin source or make the runtime package
unreadable to someone with access to the installed application.
