# Terrain And LOS Implementation Prep

## Goal

Prepare terrain, asteroid fields, nebula/gas clouds, debris, and stations to affect attacks without making visual-only scenery authoritative.

## Current Prep State

- `artifacts/api-server/src/lib/line-of-sight.ts` contains reusable LOS geometry for circular and polygon blockers.
- `artifacts/b5acta/src/lib/line-of-sight.ts` mirrors the same public shape for client previews.
- Server attack legality has a placeholder `lineOfSightObstaclesForGame(...)` source. It currently returns `[]`, so no live behavior changes.
- Player fire validation and AI fire planning now call the LOS gate after range/arc checks.
- Client target preview and target-click handling call the same LOS gate through an empty placeholder obstacle list.

## Recommended Data Model

Use a persisted `game_terrain_objects` table or equivalent API shape:

- `id`
- `game_id`
- `kind`: `asteroid-field`, `nebula`, `gas-cloud`, `debris-field`, `station`, `terrain`
- `name`
- `x`, `z`
- `radius_inches`
- `polygon_json`
- `effect`: `blocked` or `obscured`
- `active`
- `blocks_from_inside`
- `movement_effect_json`
- `attack_effect_json`

Circular blockers should be the default first implementation. Polygon support exists for later irregular fields.

## Rollout Order

1. Persist terrain objects and include them in `GET /api/games/:gameId`.
2. Map API terrain objects into `lineOfSightObstaclesForGame(...)` on the server.
3. Map the same API objects into `lineOfSightObstacles` in `game-board.tsx`.
4. Render simple terrain markers locally: translucent circles first, meshes/textures later.
5. Add rules one terrain kind at a time.

## Rules Handling

- Server remains authoritative for final legality.
- Client preview is advisory and should never be the only blocker.
- `blocked` means no shot may be declared through the object.
- `obscured` should not be treated as blocked; implement separately as hit penalties, stealth modifiers, range effects, or scenario-specific rules.
- Stations should not be implemented through the dormant Orion Starbase roster work unless explicitly requested.

## Open Rule Decisions

- Whether a ship inside an asteroid/nebula can shoot out without LOS blockage.
- Whether a target inside an asteroid/nebula can be shot normally, obscured, or blocked.
- Whether stations block LOS as a circular base, exact mesh footprint, or custom polygon.
- Whether terrain affects movement, causes damage, or only affects firing.
- Whether fighters interact differently with terrain.
