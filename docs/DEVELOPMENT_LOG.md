# Development Log

Last updated: 2026-07-17

This is a living handoff note for the Babylon 5 ACTA 3D game. Keep it concise:
record what works, what is partial or broken, and the context another Codex
instance needs before touching the project.

## Current Working Areas

### Core App And Operations

- Local Windows development works through `start-local.ps1`.
- Frontend runs through Vite, with the API proxied under `/api`.
- Public-alpha deployment is tracked on the `public-alpha` branch.
- Game records, units, fleets, ship models, weapons, critical effects, bug
  reports, chat, and audit logs are persisted in PostgreSQL.
- Admin bug reports can be viewed and marked resolved from the admin UI.
- Players can submit in-game bug reports; blocking reports can advance the
  current step through the rescue flow.
- Battle/action logs exist and provide useful player-facing clarity plus
  debugging context.
- Build version display uses a short commit SHA.
- Aggressive caching is supported for static assets with version awareness at
  the app-build level.

### Lobby, Setup, And Game Lifecycle

- Players can create, join, deploy, and play games against human or AI
  opponents.
- Fleet setup distinguishes the player's fleet from the AI/opponent fleet.
- Pre-start games can be abandoned without recording a completed battle.
- Concede and surrender are restricted to active games, preventing deployment
  rooms from accidentally becoming completed games.
- Game-over detection handles destroyed and combat-inert units more reliably
  than early public-alpha builds.

### Board And Visual Presentation

- The 3D board uses inches as world units.
- Ship meshes are wired for many current factions and classes, including recent
  Narn and fighter additions.
- Several mesh orientation fixes are visual rotations only. Avoid using
  `FLIP_MODELS` for pure mesh-facing fixes because it affects arcs, left/right
  turns, and movement calculations.
- Ship name labels are smaller to reduce clipping.
- Settings include visual quality-of-life toggles such as black-space
  background, weapon arc projection, and isometric view mode.
- In isometric mode, camera controls support board, selected-ship, and active
  ship workflows.
- PC hover hints exist for traits and critical effects.

### Movement And Placement

- Movement activation, forward movement, turns, All Stop, All Stop and Pivot,
  Come About-style behavior, and adrift drift are represented.
- The server rejects illegal final-position base overlap.
- Movement paths are not supposed to be blocked merely because they pass over
  another base; final resting position is what matters.
- The client forward-move preview prefers legal final resting positions beyond
  an intervening base when dragging forward.
- Universal no-overlap/contact handling is in place for final placement.
- Fighter deployment from carriers uses a visible 3-inch placement circle.
- Fighters use fighter-style free movement rather than capital-ship turn-gated
  movement.

### Firing, Damage, And VFX

- Firing validates phase, active unit, weapon ownership, enemy target, range,
  arc, and one-use-per-activation weapon firing.
- The attack pipeline includes stealth, dodge/interceptors/shields where
  applicable, attack table results, critical effects, GEG/adaptive-style
  defenses, and damage state updates.
- Beam, laser, tracer, missile, fire, jump point, vortex, and other VFX previews
  exist in the VFX lab.
- VFX lab tuning is preview-only and should not mutate live-game weapon tuning
  unless explicitly applied.
- Hyperspace jump point VFX uses the jump-point aperture style from the lab.
- Hull fire uses the VFX-lab fire tuning.
- Some weapon classes have live-game VFX tuning applied from the lab, including
  Brakiri-style non-beam pulsar/tracer behavior.

### Fighters

- Several fighter meshes are wired and scaled as fighters.
- Sentri, Tiger Starfury, Minbari Flyer, and Frazi should be treated as fighters
  by movement and visual systems.
- Fighter deployment, carrier launch/recovery foundations, dogfight contact, and
  Anti-Fighter interaction scaffolding exist.
- Destroyed-flight recovery exists in some form and should be treated as a
  system needing continued audit, not as fully final.

### AI

- AI can create movement and firing activations.
- AI movement now records pass-over as allowed in audit metadata.
- AI auto-run toggle exists for convenience in solo testing.
- Known AI decisions are recorded into logs for debugging.

## Known Partial Or Missing Areas

### Rule Fidelity

- Fleet/race initiative modifiers are not fully modeled.
- Movement is not fully server-authoritative for every tabletop geometry edge
  case. The server does enforce final overlap, speed caps, some turn limits, and
  minimum movement, but full turn-template fidelity still needs tests.
- Exact arc-border assignment is not strict.
- Strict "nominate all targets before rolling" firing timing is not implemented.
- Splitting one weapon's attack dice across multiple targets is not implemented.
- Multi-target weapons and station-style Targets X are not implemented.
- Ramming speed is not implemented.
- Boarding actions, Stand Down / Prepare to be Boarded, ship capture, and troop
  combat are not implemented.
- Jump engines and gameplay jump point rules are not implemented as a complete
  scenario/hyperspace subsystem. Current work is mostly VFX and future hooks.
- Shuttles are not a meaningful gameplay subsystem yet.

### Fighters

- Fighters are functional enough for public-alpha testing but still need a hard
  compatibility audit against every ship trait, weapon trait, and special rule.
- Fighter launch/recovery should be treated as one integrated rules system:
  deployable fighters and carrier launch/recovery must stay reconciled.
- Fighter attack timing, dogfights, Anti-Fighter, Advanced Anti-Fighter,
  interceptor support, Fleet Carrier support, and destroyed-flight recovery need
  more regression testing.

### Traits And Special Abilities

- Some traits are parsed and displayed before they are fully implemented.
- Command is a likely easy trait to complete further, but its exact scope should
  be confirmed against rules and current state.
- Escort, Guardian Array, and Web of Death need implementation confirmation
  before relying on them in live games.
- Crippled and skeleton crew behavior has improved, but all trait loss,
  command-loss, and firing/movement restrictions need continued audit.
- Critical effect stacking should be checked carefully. Similar penalties such
  as speed reduction should usually use the strongest active penalty rather than
  naive additive stacking, while each critical remains separately repairable.

### Data And Mesh Hygiene

- Duplicate fleet-yard entries have previously appeared for Tinashi, G'Quan,
  Battlecrab, and Avioki. Watch imports and seed scripts for duplicate ship
  model creation.
- Meshes often arrive backward. Prefer visual rotation fields or loader-side
  model transforms that do not affect tactical facing, arcs, turn direction, or
  `FLIP_MODELS`.
- Fighters should render as fighter formations where appropriate, not as single
  capital-ship style models.
- New mesh wiring should include scale, orientation, faction, fighter/capital
  classification, and fleet-yard visibility checks.

### UX And Mobile

- Mobile remains crowded. Important future work includes simplified controls,
  clearer ship stat access, mobile fleet-yard scrolling checks, top-down and
  isometric view polish, and better step-by-step battle clarity.
- Weapon arc projection exists but should be performance-tested when many ships
  are selected or visible.
- Battle log is high value for clarity and bug reports; continue expanding it
  before adding more hidden automation.

### Operational Concerns

- Aggressive caching saves outbound bandwidth but can confuse testers after
  deploys. Keep visible build versioning and tell players to hard refresh when a
  new public-alpha version is out.
- Deploying to live can trigger outbound bandwidth as testers fetch new assets,
  especially GLB meshes and large textures.
- Commit SHA in the UI should be short SHA only; do not expose secrets or env
  values in build metadata.

## Development Practices

- Read existing patterns before editing. Most game rules live in
  `artifacts/api-server/src/routes/games.ts`; most board UX lives in
  `artifacts/b5acta/src/pages/game-board.tsx`.
- Keep server rules as the source of truth whenever practical. Client checks
  should explain and preview server behavior, not invent separate legality.
- Use `rg` for search and keep diffs scoped.
- Use `apply_patch` for manual edits.
- Run `pnpm run typecheck` before handoff after TypeScript changes.
- Do not revert unrelated user or generated changes.
- Do not use destructive git operations.
- When changing meshes, verify visual orientation separately from tactical
  facing. This project has repeatedly hit downstream arc/turn bugs from mixing
  those concepts.

## Suggested Codex Handoff Prompt

Use this prompt when starting another Codex instance on the project:

```text
You are working on the Babylon 5 ACTA 3D game in:
C:\Users\Admin\Documents\replit Babylon 5 ACTA 3D game\Board-Game-Stream\Board-Game-Stream

Current active public branch is usually `public-alpha`; confirm with git status
before editing. The remote is `github` at https://github.com/saladiin/ACTA.git.

Important project shape:
- Main server rules are mostly in `artifacts/api-server/src/routes/games.ts`.
- Main board/client UX is mostly in `artifacts/b5acta/src/pages/game-board.tsx`.
- Ship/fleet/weapon data and schema live under `lib/db` and related seed/import
  paths.
- Local dev runs with `start-local.ps1`; frontend is usually localhost:21152
  and API localhost:8080.

Current rule/implementation principles:
- Board units are inches.
- Server should be source of truth for legality.
- Final-position base overlap/contact is illegal, but movement should not be
  blocked merely because the path passes over another base.
- Fighter systems include deployable fighters and carrier launch/recovery; keep
  those unified rather than building separate incompatible mechanics.
- VFX lab tuning is preview-only unless explicitly applied to live weapons.
- Mesh orientation fixes should be visual rotations only. Do not use
  `FLIP_MODELS` for a model that is merely facing backward, because that changes
  arcs and left/right movement behavior.

Known partial systems:
- Initiative modifiers, ramming, boarding, full jump engine gameplay, shuttles,
  strict target declaration, split fire, multi-target weapons, and several traits
  are incomplete.
- Fighters are playable/foundation-level but need continued audit against ship
  traits, weapon traits, Anti-Fighter, dogfights, Fleet Carrier, and destroyed
  flight recovery.
- Mobile UX is crowded and needs incremental polishing.

Before changing code:
- Read `docs/DEVELOPMENT_LOG.md`.
- Search with `rg` for existing helpers and patterns.
- Preserve unrelated working-tree changes.
- Run `pnpm run typecheck` after TypeScript edits.
- If asked to push, commit focused changes and push the requested branch.
```
