---
name: Callsign vs email identity
description: Why the public display name (players.username) is decoupled from email, and why callsigns are not unique.
---

# Public callsign is decoupled from email

A player's public display name (`players.username`, shown to other commanders) must **never** be derived from their email address. Email/password is a Clerk-only login concern; the public callsign lives in our own `players` table and is user-editable.

**Why:** linking a public name to the email localpart leaks the user's email identity to opponents. The provisioning path (`ensurePlayer`) previously fell back to `email.split("@")[0]` — this was the leak and was removed.

**How to apply:**
- New players get a neutral generated default (`Commander-XXXX`). An explicit Clerk username is honored only if it passes the callsign validator; otherwise fall back to the generated default.
- Callsign rules (length 2–24; `[A-Za-z0-9 _-]`) live in the OpenAPI `UpdateProfileInput` schema AND a server-side `sanitizeCallsign` helper in `players.ts`, used by both provisioning and `PATCH /players/me`. Keep these in sync if rules change.

# Callsigns are intentionally NOT unique

Challenges/games resolve players by `clerkUserId`, never by username (engagements are open/join-by-id, not targeted-by-name). So `players.username` is purely cosmetic.

**Why:** uniqueness would add collision-handling friction for zero correctness benefit. Do not add a unique constraint on `players.username` or assume names are unique anywhere in auth/challenge logic.
