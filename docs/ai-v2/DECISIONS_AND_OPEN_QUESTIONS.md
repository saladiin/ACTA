# Decisions And Open Questions

Status: **DESIGN RECORD - DEFERRED**

Review date: 2026-07-26

## Settled Decisions

### Preserve the current AI

The current five-profile AI remains the compatibility implementation and
rollback path. AI V2 will be additive and feature-flagged.

### Separate legality from tactics

Server rule functions decide what is legal. AI doctrine ranks legal options.
No personality or difficulty setting may bypass a rule.

### Use per-ship doctrine

Every playable canonical ship model should have an explicit doctrine. Aliases
resolve to the canonical model and do not receive separate behavior.

### Plan complete activations

The AI should plan movement, special action, targets, and all weapon
allocations as a coherent package, then revalidate during execution.

### Coordinate at fleet level

Ship doctrine is necessary but insufficient. A fleet brain should set focus,
screening, escort, activation, fighter, objective, and ordnance intent.

### Keep difficulty fair

Difficulty changes lookahead, candidate breadth, coordination, and decision
noise. It does not alter stats, dice, hidden information, or legality.

### Keep decisions inspectable

Plans must log scores, alternatives, assumptions, and rejection reasons.

### Defer implementation

No AI V2 behavior should be implemented until the major game-system dependency
review is complete. This package is preservation and preparation only.

## Existing Taste Decisions To Preserve

Some targeting and arc restrictions were intentionally left as current game
taste choices even where stricter tabletop interpretation may differ. They may
be reconsidered later, but AI V2 should consume the game's chosen legality
rather than silently enforcing a different version.

Attack Dice splitting is the stated exception: it is desired and should be
implemented in the human firing flow before AI planning uses it.

## Open Product Questions

### Rules strictness

- Which targeting, declaration, and arc-border rules are strict server rules
  versus intentional usability simplifications?
- Should AI use the same simplified choices at every difficulty?

### Information access

- Can AI use only currently visible public state?
- Are future hidden-order, reinforcement, or scenario systems intended?
- What memory may AI retain across rounds?

### Retreat and disengagement

- Should ordinary ships preserve themselves in annihilation scenarios?
- At what hull, crew, critical, or objective state should retreat be preferred?
- How should Ancients value regeneration compared with escape?

### Faction identity

- Should faction temperament modify ship doctrine?
- Examples include Centauri aggression, Minbari range and Stealth discipline,
  Narn ordnance timing, Earth Alliance formation play, and Ancient predation.
- Should faction behavior be cosmetic flavor, measurable weights, or both?

### Personality variation

- Should two copies of the same ship behave identically?
- Is small seeded temperament variation desirable?
- Should named commanders or AI opponents have fleet-level personalities?

### Difficulty

- How many public difficulty levels are useful?
- Should lower difficulty choose among near-optimal plans or use shorter
  lookahead?
- What planner time budget is acceptable on the production host?

### Objectives

- Which scenarios should AI V2 support first?
- How should objective value compare with expected damage?
- Can some ships be assigned permanently to an objective, or should all
  assignments be revisited each round?

### Fighters

- When may a capital ship justifiably target a fighter despite viable capital
  targets?
- How should fighter screens reserve dogfight targets?
- When should a strike flight abandon its capital target to protect a carrier?

### Special actions

- Should AI declare a special action only when expected value exceeds ordinary
  behavior by a margin?
- How conservative should the AI be when an action depends on Crew Quality?
- Does a failed action consume tactical commitment in every case, and how is
  that represented in planning?

### Fleet construction

- Should AI build historically themed fleets, competitive fleets, or selectable
  presets?
- How much composition randomness is desirable?
- How should priority-level allocation and lower-priority splitting be scored?

## Engineering Questions

- Can shared combat evaluation be extracted without changing live resolution?
- What is the canonical legal-action interface for movement?
- How will plans identify a state revision and detect staleness?
- Should `ai_state` live on the game row or in a separate event/state table?
- How much plan detail belongs in permanent audit storage?
- What retention policy is appropriate for simulation logs?
- Can shadow mode run within the existing server performance envelope?
- Which seeded RNG boundary covers planner noise versus combat rolls?

## Review Triggers

Revisit this package when any of the following occurs:

- Attack Dice splitting is completed.
- Boarding implementation begins or completes.
- Station rules become playable.
- Fighter launch, recovery, and dogfighting become rules-complete.
- Jump point mechanics become playable.
- Objective/scenario state is added.
- Terrain and LOS become authoritative.
- The playable roster changes materially.
- Current AI behavior is refactored out of the games route.

## Change Record

### 2026-07-26

- Preserved the current AI audit, proposed doctrine framework, 43 reviewed ship
  assignments, modular implementation plan, risk estimates, rollout controls,
  dependency gates, and unresolved decisions.
- Marked AI V2 design-only and deferred because major systems remain under
  development.
- Confirmed that this documentation change does not authorize or introduce
  runtime AI behavior.

