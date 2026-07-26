# AI V2 Planning Package

Status: **DEFERRED - DESIGN ONLY - NOT APPROVED FOR IMPLEMENTATION**

Last reviewed: 2026-07-26

## Purpose

This package preserves the AI design discussion for future implementation.
It describes how ship-level doctrine, fleet coordination, tactical planning,
testing, and rollout should work when the remaining game systems are mature.

These documents do not authorize runtime changes. The current AI must remain
the production behavior until the dependency gates and resume checklist are
explicitly reviewed.

## Document Map

- [Current AI Audit](CURRENT_AI_AUDIT.md): what the existing AI does well,
  where it is simplistic, and concrete profile mismatches.
- [Archetypes And Ship Doctrines](ARCHETYPES_AND_SHIP_DOCTRINES.md): the
  proposed doctrine schema, tactical roles, and assignments for all 43
  currently reviewed ship models.
- [Implementation Plan](IMPLEMENTATION_PLAN.md): proposed modules, data flow,
  activation plans, scoring, and a phased delivery sequence.
- [Risk, Rollout, And Acceptance](RISK_ROLLOUT_AND_ACCEPTANCE.md): regression
  likelihoods, guardrails, shadow mode, rollback, tests, and release criteria.
- [Dependencies And Deferred Backlog](DEPENDENCIES_AND_DEFERRED_BACKLOG.md):
  major game systems that should be completed or explicitly scoped before AI
  V2 work begins.
- [Decisions And Open Questions](DECISIONS_AND_OPEN_QUESTIONS.md): settled
  design choices, unresolved policy questions, and the checklist for reopening
  this project.

## Decision Summary

1. AI personality must be data-driven and ship-specific. The current five
   broad profiles can remain as a compatibility fallback, but they are not
   expressive enough for the full roster.
2. Rules legality and AI preference must stay separate. Personality may rank
   legal choices; it must never redefine whether a move or attack is legal.
3. The planner should produce a complete, inspectable activation plan before
   execution. Existing server rule functions should validate and execute each
   step.
4. AI must reason about complete firing packages, not only one weapon at a
   time. This includes multiple weapons, Attack Dice splitting, reload state,
   target reservations, and opportunity cost.
5. A fleet-level brain should coordinate focus targets, activation order,
   escorts, scouts, fighters, objectives, and ordnance timing.
6. Difficulty should alter lookahead, coordination, and decision noise. It
   should never grant illegal actions, hidden bonuses, or altered dice.
7. AI V2 must be feature-flagged, deployable in pieces, observable through
   audit logs, and removable with one setting.
8. AI V2 is deferred because several major rules systems are still incomplete
   or changing. Building strategic behavior around temporary gaps would create
   avoidable rework and hide rules bugs inside AI behavior.

## Design Principles

### Rules first

The server remains authoritative for movement, targeting, traits, attacks,
damage, and phase progression. AI consumes legal-action APIs and cannot bypass
them.

### Doctrine plus live state

Doctrine supplies preferences such as range band, role, aggression, and target
weights. Current weapons, damage, criticals, objectives, nearby allies,
defensive traits, and board geometry determine the actual action.

### Inspectable decisions

Every plan should explain its selected action, score, alternatives, and
rejected choices. A tester must be able to distinguish poor tactics from a
rules or arithmetic defect.

### Conservative integration

Pure planners should read immutable tactical snapshots. The executor should
submit actions through existing server paths, revalidate before each step, and
replan if state changes.

### No accidental human-game changes

AI work must not alter human-versus-human rules behavior. Shared rule changes
require their own tests and review, independent of AI tuning.

## Maintenance

When a major rules system is completed, update
[Dependencies And Deferred Backlog](DEPENDENCIES_AND_DEFERRED_BACKLOG.md)
rather than beginning AI implementation automatically. If ship stats or the
roster change, update the doctrine roster and rerun its completeness check.

The package should be treated as a design record. Material changes should add
the review date and rationale to
[Decisions And Open Questions](DECISIONS_AND_OPEN_QUESTIONS.md).

