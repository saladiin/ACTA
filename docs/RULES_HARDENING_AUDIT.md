# Rules Hardening Audit

Last updated: 2026-07-13

## Current Coverage

### Fighters

Implemented:
- Carried fighter inventory is populated from `smallCraft`.
- Deployment supports the 3-inch carried-fighter setup rule.
- End Phase launch/recovery routes exist.
- `Scramble! Scramble!` increases launch capacity for the turn.
- Fleet Carrier supports pre-battle deployment, dogfight bonus, and destroyed-flight recovery support.
- Destroyed carried fighters can attempt recovery.
- Fighters in contact are handled as dogfights instead of normal weapon fire.
- Fighter flights cannot use Special Actions.

Audit gaps:
- `G'Quan Cruiser` / `G'Quan Heavy Cruiser` carry `Frazi`, but no `Frazi Flight` model is currently seeded or present in `public/models`.
- `Sharlin War Cruiser` carries `Flyer`, but no `Flyer Flight` model is currently seeded or present in `public/models`.

### Anti-Fighter, Escort, And Web Of Death

Implemented:
- Anti-Fighter and Advanced Anti-Fighter target enemy fighter flights within 2 inches.
- Dogfighting fighters are skipped by Anti-Fighter.
- Advanced Anti-Fighter currently applies as Anti-Fighter with a +1 roll bonus.
- `Escort` is parsed and can lend Anti-Fighter dice to protect allied units within 8 inches.
- Minbari `Web of Death` is modeled as restricted Escort behavior for non-fighter Minbari ships within 4 inches of another non-fighter Minbari ship. It protects nearby Minbari ships within 4 inches and does not create extra dice.

Deferred:
- Guardian Array is parsed, but interceptor lending needs an attack-declaration UI/choice so a player can decide whether to spend another ship's interceptor pool. Auto-spending another ship's interceptors would be rules-hostile.
- Exact Advanced Anti-Fighter edge cases remain marked for rule verification.
- Line of sight for Escort/Web is not separately modeled because current board terrain/LOS blockers are not implemented.

### Movement, Contact, And Collision

Implemented:
- Final base overlap is illegal for all units.
- Base contact is still legal and distinct from overlap.
- Player movement validates the requested final position for illegal overlap.
- Movement paths are not blocked merely because they pass over another base; the ACTA rules text found so far only confirms final-position stacking as illegal outside special cases.
- Fighter contact with enemy fighters locks them into dogfight handling.

Deferred:
- Ramming needs an explicit special-action exception to intentional enemy contact and a dedicated damage path.
- Terrain/station collision rules are not modeled.

### VFX

Implemented:
- Live missile VFX now use the tuned orange/red missile-volley preset.
- Live tracer VFX now route colors by weapon/faction, keeping Brakiri/League-style non-beam fire green while giving matter/particle weapons a warmer tracer.
- Energy mines, beams, missiles, and tracers are classified by weapon name/traits.

Audit command:

```sh
pnpm run audit:rules
```

The audit reports:
- Carried fighter entries that do not resolve to current fighter models.
- Ship traits that are implemented, explicitly deferred, or unknown.
- Weapon VFX classification counts and live tuning checks.
