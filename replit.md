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

## Gotchas

- Port 21152 must be registered in `.replit` `[[ports]]` for the b5acta workflow health-check to pass (done via `verifyAndReplaceDotReplit`)
- Do NOT edit `.replit` or `replit.nix` directly — use `verifyAndReplaceDotReplit` callback
- Run `pnpm --filter @workspace/api-spec run codegen` after any OpenAPI spec change before editing frontend
- OBJ model files must be placed in `artifacts/api-server/public/models/` manually; the seed script only creates DB records
- Ship seeding: `artifacts/api-server/src/seed.ts` — run via `pnpm --filter @workspace/api-server run seed` (add script if needed)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See `lib/api-spec/openapi.yaml` for the full API contract
