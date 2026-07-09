---
name: Production DB data is not migrated on publish
description: Why reference/catalog data drifts between dev and prod, and the self-heal pattern used to fix it
---

The production PostgreSQL database is **separate** from development. Replit's Publish flow migrates **schema only** — it does NOT copy data rows. So reference/catalog rows seeded long ago in production keep their old values even after dev is corrected.

Tooling (`executeSql`) is **read-only** against production, so the agent cannot UPDATE a prod row directly.

**Why this bit us:** a ship model was re-exported `omega.obj` → `omega.glb`; dev's `ship_models.filename` was updated but the production row still said `omega.obj`, so the live board requested a file that 404'd and fell back to a placeholder box. Other models looked fine because their prod rows already matched existing files.

**How to apply / fix pattern:** the only way to correct prod data is through the running app (it has a read-write `DATABASE_URL`). For reference/catalog data, add an idempotent self-heal that runs at server **startup before `listen`** (so first post-deploy requests don't see stale data). Constrain it tightly: only act when the recorded value is provably wrong (e.g. file missing on disk) and a correct replacement is unambiguous; make it a no-op once fixed; catch+log all errors so it can never crash boot. See `reconcileModelFilenames()` in `artifacts/api-server/src/lib/models.ts`. This is data reconciliation, NOT a schema migration — never write schema-migration scripts/DDL for prod (that's the Publish flow's job).
