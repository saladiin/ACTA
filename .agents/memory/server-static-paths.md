---
name: Server static file paths (dev vs prod cwd)
description: Why API-server static-file lookups must resolve relative to the bundle, not process.cwd()
---

# Resolve served static files relative to the bundle, not `process.cwd()`

Any code in `@workspace/api-server` that reads on-disk assets (e.g. the OBJ/GLB
ship models served at `/api/models/:filename`) must resolve paths relative to the
bundle location (`fileURLToPath(import.meta.url)` → `dist/`), NOT `process.cwd()`.

**Why:** the process's working directory differs by environment, so a
`process.cwd()`-based path works in dev but silently breaks in production:
- Dev: the workflow runs `pnpm --filter @workspace/api-server run dev`, so cwd is
  the package dir `artifacts/api-server` → `public/models` resolves.
- Prod: the deployment runs `node artifacts/api-server/dist/index.mjs` from the
  REPO ROOT (see `artifact.toml` `services.production.run`), so cwd is the repo
  root → `public/models` points at `<root>/public/models`, which does not exist.

Symptom this caused: every `/api/models/*` request 404'd only on the published
site, and the 3D board fell back to placeholder boxes. Both dev and prod run the
bundled `dist/index.mjs`, so an `import.meta.url`-relative path (`../public/models`)
is correct in both. The `.glb` files ARE committed to git, so they ship with the
deployment — the only bug was the path resolution.

**How to apply:** for any new served-from-disk asset, compute the dir from
`import.meta.url` and keep cwd-based fallbacks only as a safety net.
