# Development Log

## Critical Local-Only Restriction

- Do not commit or push Orion Starbase / Starbase roster work unless the user explicitly requests it in the current task.
- Known local-only Starbase-related changes may appear in `artifacts/api-server/src/lib/schema-maintenance.ts` and `attached_assets/acta_ships_12APR26_1779321905109.csv`.
- Treat Starbase rows, `DORMANT_CSV_SHIP_NAMES`, and Orion Starbase seed data as local experimental/dormant work. Preserve it locally if present, but keep it out of focused public-alpha commits.
- When pushing unrelated fixes, stage only the requested hunks/files and verify the staged diff does not include `Orion`, `Starbase`, or `DORMANT`.

## Working Notes

- Main server rules are mostly in `artifacts/api-server/src/routes/games.ts`.
- Main board/client UX is mostly in `artifacts/b5acta/src/pages/game-board.tsx`.
- Terrain/station LOS preparation is documented in `docs/TERRAIN_LOS_IMPLEMENTATION_PREP.md`; do not use dormant Orion Starbase roster work as the station implementation path unless explicitly requested.
- Current public branch is usually `public-alpha`; confirm with `git status`.
- Preserve unrelated working-tree changes. Do not revert or commit local experimental work unless explicitly asked.
