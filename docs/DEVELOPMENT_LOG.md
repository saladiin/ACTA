# Development Log

## Working Notes

- Main server rules are mostly in `artifacts/api-server/src/routes/games.ts`.
- Main board/client UX is mostly in `artifacts/b5acta/src/pages/game-board.tsx`.
- Terrain/station LOS preparation is documented in `docs/TERRAIN_LOS_IMPLEMENTATION_PREP.md`. The published Orion station profile and station combat implementation are authoritative live work on `public-alpha`.
- Current public branch is usually `public-alpha`; confirm with `git status`.
- Preserve unrelated working-tree changes. Do not revert or commit local experimental work unless explicitly asked.
- Campaign Turn 1 now has local initiative and Strategic Target nomination
  support. Campaign `faction` remains a freeform fleet label; players enter the
  actual 2E Fleet Initiative modifier explicitly during setup.
- Generated campaign engagements are now local: commanders privately commit
  Priority modifiers, the server rolls and legally rerolls scenarios, enforces
  scenario-specific FAP limits, and locks each campaign ship to one battle in a
  turn before creating the private tactical game.
- Campaign post-battle resolution is now local: explicit result import preserves
  ship state, derives ship-local XP from tactical audit logs, transfers Strategic
  Targets, writes an append-only RR/XP ledger, supports core XP and RR repairs,
  reinforcements, High Command repair, carrier replenishment, Self-Repair, and
  advances the campaign into the next initiative turn once every commander is
  ready.
- Campaign routes and navigation are development-only until the campaign flow is
  ready for public testing; production does not mount the campaign API or pages.
- Remaining campaign automation includes target exploration, the Hidden Outpost
  payment choice, XP tactical rerolls, Refit and Other Duties tables, Avoiding
  Battle, player elimination, and optional campaign modules.
- The Dilgar Tikrit-class Heavy Cruiser is seeded from Fleet Lists 2E with its
  dedicated mesh and two distinct forward Anti-Ship Missile systems. Dilgar
  bolter and pulsar criticals use the fleet's Masters of Destruction rule.
- The Dilgar Garasoch-class Heavy Carrier is seeded from Fleet Lists 2E with its
  dedicated mesh, five printed weapon systems, carrier traits, and ten Thorun
  Dartfighter flights. The carried flights remain unavailable for deployment
  until an authoritative Thorun profile and mesh are added.
- The Dilgar Omelos-class Light Cruiser is seeded from Fleet Lists 2E with its
  dedicated mesh, seven printed weapon systems, Agile and Anti-Fighter 2, and
  one recorded Thorun Dartfighter flight. Its two forward Anti-Ship Missile
  systems remain separate, ID-preserving weapon rows.
- VFX Lab Material Studies includes a local-only cel-shaded Hyperion preview.
  Its collapsible Surface, Lighting, and Outline controls independently tune or
  disable texture, emissive, transparency, toon bands, scene lights, bloom, and
  the inverted-hull silhouette. This treatment is not applied to live ships.
- The `/shadow-lobby` alternate lobby reuses the live lobby, profile, challenge,
  operation, observer, and chat data. Its static organic dividers use the Shadow
  Battlecrab flesh base texture without the ship material animation; the normal
  lobby remains unchanged. The alternate lobby is development-only and is not
  routed or linked in production.
- Authenticated pages now send a lightweight presence heartbeat while visible.
  Both lobby variants list active callsigns only; no email, provider identity,
  or current engagement is exposed. Presence expires after 90 seconds.
