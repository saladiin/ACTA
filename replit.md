# Babylon 5: A Call to Arms

An async multiplayer tabletop wargame playable online, featuring 3D ship models (OBJ format), hex-grid combat, and turn-based gameplay between two commanders.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server (port 8080)
- `pnpm --filter @workspace/b5acta run dev` — Frontend (port 21152)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 (port 8080, path prefix `/api`)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Auth: Clerk (email/password, white-label)
- Frontend: React + Vite, Three.js / @react-three/fiber for 3D board

## Where things live

- `lib/api-spec/openapi.yaml` — source of truth for all API contracts
- `lib/db/src/schema/` — Drizzle ORM schema (shipModels, players, fleets, ships, games, gameUnits, turns)
- `lib/api-client-react/src/generated/api.ts` — generated React Query hooks (do not edit)
- `artifacts/api-server/src/routes/` — Express route handlers
- `artifacts/api-server/public/models/` — OBJ ship model files (user-supplied)
- `artifacts/b5acta/src/pages/` — frontend pages (lobby, fleets, games, new-game, game-board)
- `artifacts/b5acta/src/components/layout.tsx` — main app shell with sidebar nav

## Architecture decisions

- Contract-first: OpenAPI spec drives codegen for both React Query hooks and Zod validation schemas
- Clerk proxy middleware on the API server handles auth — `requireAuth` extracts `userId`, `ensurePlayer` JIT-provisions player records
- Turn system: challenger moves on odd turns, opponent on even turns
- Deploy phase: both players must place their fleets before status transitions to `active`
- OBJ models served at `/api/models/:filename` from `artifacts/api-server/public/models/`; frontend falls back to a colored box if model not found

## Product

- Home page: landing/marketing with Login / Enlist CTAs
- Lobby: incoming challenges, active operations, recent engagements, profile stats
- Fleets: build named fleets, assign ships from the 6 seeded ship classes (Hyperion, Omega, Sharlin, Nial, Primus, G'Quan)
- Active Ops / Games list: all games for the current player
- New Engagement: search for an opponent by username, pick a fleet, set point limit, send challenge
- Game Board: 3D hex grid via @react-three/fiber, ship models loaded as OBJ, sidebar shows turn status, combat log, fleet roster; deploy/accept/decline/submit-turn actions

## User preferences

- Military/sci-fi aesthetic: dark background, amber primary, monospaced uppercase labels, "B5: ACTA" branding
- `data-testid` attributes on all interactive elements

## Model orientation spec

All ship `.glb`/`.obj` uploads must follow this convention so the engine's heading, movement, and weapon-arc math work without per-model patching:

- **Forward axis**: nose points along local **+Z** (heading 0° → ship faces +Z on the board)
- **Up axis**: local **+Y**
- **Port / Starboard**: Port = local **+X**, Starboard = local **−X**
- **Origin**: geometric center at (0, 0, 0), sitting on the XZ plane (don't bury it below Y=0)
- **Scale**: irrelevant — the renderer auto-scales the longest horizontal dimension to ~2"
- **Blender export**: with the model at origin and nose pointing along Blender's **+Y** ("forward" in the viewport), use the standard glTF exporter (+Y up, −Z forward). The loader's glTF axis convention will land the nose on world +Z.
- **Textures**: embed in the `.glb` (we do not load external `.mtl` for GLBs)

`FLIP_MODELS` (in both `game-board.tsx` and `games.ts`) is intentionally an **empty set** — it exists only as an emergency escape hatch for a one-off misauthored model. The correct fix is always to re-export the model with proper orientation.

## Gotchas

- Port 21152 must be registered in `.replit` `[[ports]]` for the b5acta workflow health-check to pass (done via `verifyAndReplaceDotReplit`)
- Do NOT edit `.replit` or `replit.nix` directly — use `verifyAndReplaceDotReplit` callback
- Run `pnpm --filter @workspace/api-spec run codegen` after any OpenAPI spec change before editing frontend
- OBJ model files must be placed in `artifacts/api-server/public/models/` manually; the seed script only creates DB records
- Ship seeding: `artifacts/api-server/src/seed.ts` — run via `pnpm --filter @workspace/api-server run seed` (add script if needed)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See `lib/api-spec/openapi.yaml` for the full API contract
