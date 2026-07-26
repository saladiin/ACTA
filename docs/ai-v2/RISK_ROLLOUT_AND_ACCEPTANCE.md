# Risk, Rollout, And Acceptance

Status: **PROPOSED SAFETY PLAN - DEFERRED**

Review date: 2026-07-26

## Overall Risk

An all-at-once AI rewrite inside the current game route has an estimated
60-80 percent chance of causing a visible regression during initial
integration. This does not mean the design is infeasible; it means the action
space and shared phase state are too broad for a single replacement release.

With isolated pure planners, feature flags, shadow evaluation, existing rules
execution, and staged rollout, the expected risks are substantially lower:

| Outcome | Estimated initial likelihood |
| --- | ---: |
| Human-versus-human regression | Below 5 percent |
| Current AI becomes unusable | Below 5 percent |
| AI V2 has a visible tactical bug during early testing | 25-40 percent |
| AI V2 causes a stuck or corrupted match after test hardening | 5-10 percent |
| Nullable doctrine migration causes a serious issue | Below 10 percent |

These are engineering estimates, not measured production statistics. Update
them after shadow-mode and simulation data exist.

## Component Risk

| Component | Initial bug likelihood | Main hazards |
| --- | ---: | --- |
| Doctrine data and assignments | Below 10 percent | Missing model, duplicate alias, bad range band. |
| Full firing packages | 35-50 percent | Multiweapon state, Attack Dice splitting, reloads, target death, target declaration. |
| Movement lookahead | 25-40 percent | Turn signs, segment distance, collision, board edges, stale geometry. |
| Activation sequencing | 20-35 percent | Fighter/capital segments, active-unit locks, phase advancement. |
| Special actions | 20-30 percent | Incomplete mechanics, mutually exclusive effects, timing. |
| Fleet brain | 10-20 percent | Stale focus, over-coordination, reservation deadlocks. |

## Highest-Risk Failure Modes

### Partial multiweapon activation

An early attack can destroy a target, apply a critical, consume a reload, or
advance state. The remaining firing package must be revalidated instead of
blindly replayed.

### Attack Dice splitting

Splitting expands the candidate space and requires exact accounting of declared,
intercepted, rolled, and resolved dice. The human rules implementation should
be stable before the AI uses it.

### Fighter and capital timing

Fighter attack precedence has previously produced confusing activation
behavior. AI sequencing must use one authoritative phase-segment state and
never infer fighter presence from an unrelated condition.

### Movement geometry

Turn-direction signs, cumulative segment distance, minimum movement before
turns, overlap, and base radius are all stateful. Future AI movement must call
the same server validator as human movement.

### Shared rules coupling

Adding AI-only interpretations to shared rules helpers can silently change
human games. Shared rule fixes need independent tests and review.

### Planner cost

Naive combinations of movement points, headings, targets, weapons, and split
dice can grow quickly. Candidate limits, time budgets, and deterministic
fallbacks are required.

## Required Guardrails

1. Keep the current AI as `AI_DOCTRINE_V1` and the default until explicit
   promotion.
2. Restrict AI V2 to AI-controlled seats.
3. Build pure, read-only planners from immutable snapshots.
4. Execute plans only through existing server rule commands.
5. Feature-flag firing, movement, special actions, fleet coordination, and
   fighter behavior independently.
6. Add a shadow mode in which AI V2 plans and logs while AI V1 acts.
7. Make `ai_doctrine` nullable with a tested V1 fallback.
8. Revalidate before every mutating step.
9. Keep one-setting rollback to V1.
10. Never combine a shared rules-engine rewrite with an AI rollout.

## Shadow Mode

Shadow mode is the preferred first live evaluation:

1. Build the same tactical snapshot used by the acting AI.
2. Let AI V2 produce a plan without mutating state.
3. Let AI V1 take the actual action.
4. Log both choices and their expected-value components.
5. Compare legality, target choice, range, exposure, and eventual outcome.

Shadow mode should have a strict time budget and must be disabled automatically
if it affects server responsiveness.

## Rollout Stages

### Stage A: local and test-only

- Doctrine validation.
- Unit and serialized scenario tests.
- Seeded AI-versus-AI batches.
- No production execution.

### Stage B: shadow mode

- Selected test matches only.
- Compare V1 action with V2 recommendation.
- Record planner latency and invalid-plan rate.

### Stage C: opt-in firing

- V2 firing flag enabled for designated AI matches.
- V1 movement and sequencing remain active.
- Immediate rollback on stuck activation or invalid state.

### Stage D: opt-in movement

- Doctrine movement enabled separately.
- Board-edge, collision, and turn audit reviewed after every test match.

### Stage E: special actions and fleet brain

- Enable one subsystem at a time.
- Keep fighter and station behavior disabled until their rule gates pass.

### Stage F: default for AI matches

- Promote only after acceptance criteria pass.
- Retain V1 for at least one public testing cycle.

## Rollback

Rollback must:

- Require one server configuration change.
- Stop creating V2 plans for new activations.
- Preserve current match state.
- Allow V1 to continue the same AI seat.
- Leave V2 audit data readable for diagnosis.
- Avoid a database down-migration as an emergency requirement.

If a partially executed plan cannot safely return to V1, the executor should
end only the current legal step and re-enter through normal active-unit state.

## Acceptance Criteria

AI V2 is not ready for default use until all of the following are true:

- No known illegal AI action in the supported feature set.
- Every capital ship fires its selected full legal allocation or logs a clear
  reason for holding a weapon.
- Attack Dice splitting accounts for every die exactly once.
- Destroyed or otherwise invalid units are never selected as targets.
- Capital ships treat fighters as lowest target priority when other viable
  capital targets exist, except for an explainable tactical override.
- All playable roster models have explicit doctrine; no accidental `brawler`
  fallback remains.
- Canonical aliases resolve to one doctrine.
- Identical seed and state produce an identical plan.
- Every plan logs alternatives, score components, and rejection reasons.
- Ordinary activation planning meets the 150 ms target.
- Fleet replanning meets the 500 ms target.
- Difficulty changes planning quality rather than rules.
- Human-versus-human regression tests remain unchanged with all V2 flags off.
- Stale plans and target destruction cause safe replanning.
- Current AI can resume through the rollback flag.

## Stop Conditions

Pause rollout immediately if:

- A human-controlled match changes with all V2 flags disabled.
- An AI action bypasses server legality.
- Phase progression becomes stuck.
- A weapon or movement resource is consumed twice.
- A destroyed unit acts or is attacked.
- Planner latency causes polling, input, or match responsiveness problems.
- Audit records cannot explain the action taken.

## Residual Risk

Even after technical acceptance, doctrine weights can produce tactically odd
choices. That is expected tuning work, not automatically a rules defect.
Reweighting should be based on reproducible scenarios and logs, not a single
match result.

