---
name: game-board sidebar phase gating
description: Sub-panels nested inside the activation panel inherit its phase guard. Adding an end-phase sub-panel inside that block produces a silent no-render.
---

The right sidebar in `artifacts/b5acta/src/pages/game-board.tsx` has a large activation-panel block guarded by `currentPhase !== "end"`. Anything nested under it (crit panel, movement HUD, SA picker, etc.) is invisible during the End Phase even if its own inner condition would allow it.

**Why:** This was the actual root cause of a "damage control UI never shows in end phase" bug — the crit/DC panel was nested inside the activation panel and got hidden along with it.

**How to apply:** Before adding a sub-panel that needs to render in End Phase (or any phase the parent excludes), make it a *sibling* of the activation panel, not a child. TypeScript will catch the mismatch with a `'initiative' | 'movement' | 'firing'` vs `'end'` overlap error on any `currentPhase === "end"` comparison inside the nested block — treat that error as a structural signal, not just dead code.
