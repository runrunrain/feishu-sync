amagi-pi is privately distributed inside the application. `package.zip` and
`manifest.json` are release inputs and must ship together; no repository credentials
or access to a public npm package is needed on the end user's device.

`npm run server:build` refreshes the bundle from `AMAGI_PI_SOURCE_DIR`, or a sibling
`amagi-pi` checkout when present. Without a source checkout it verifies and reuses
the checked-in bundle. `AMAGI_PI_USE_BUNDLED=1` explicitly reuses the frozen bundle,
including when a development checkout exists. It uses npm's publication file list and exact locked
production dependencies, excluding Git metadata, developer tools and local state.
The app unpacks and verifies the bundle, then registers it through the existing Pi
local-package installer under the app's private data directory.

The 2.21.36 bundle also applies the app's reviewed background-continuation and
queued-shutdown patch in an isolated staging directory. Its digest participates
in the cache key and release manifest. A stale frozen bundle without that patch
is rejected during builds; the original source checkout is never modified.

Updates follow application releases. Each content revision has its own immutable
installation directory; builds already started retain their original package.
The build runtime loads amagi's native task tools. Ordinary chat sessions retain
the app's controlled task tools because their native names overlap.

Private distribution does not obfuscate plugin source or make the runtime package
unreadable to someone with access to the installed application.
