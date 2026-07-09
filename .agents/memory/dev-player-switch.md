---
name: Dev-only player-switch (testing impersonation)
description: How the b5acta testing player-switch is double-gated so it can never run on the published site
---

# Dev-only player-switch must be double-gated (client DEV + server NODE_ENV)

b5acta has a testing-only "player-switch" that lets one tester act as both
commanders (`test-user-1` / `test-user-2`) without two real Clerk accounts, by
sending an `x-dev-user-id` header that overrides the authenticated user.

This was once removed entirely for security (the server blindly trusted the
header). The re-added version is safe because it is gated on BOTH sides:
- Client (`dev-mode-toggle.tsx`): only renders + injects the header when
  `import.meta.env.DEV`, so it is stripped from the production frontend bundle.
- Server (`auth.ts` `getDevOverrideUserId`): returns null when
  `process.env.NODE_ENV === "production"`, so the header is ignored even if a
  caller sends it manually.

**Why:** the published deployment sets `NODE_ENV=production` (in `artifact.toml`
build + run env), so the override is always inert in production. A single gate is
not enough — the server gate is the real security boundary because anyone can
forge a header.

**How to apply:** never let the server honour a client-supplied identity header
without a hard `NODE_ENV !== "production"` check. If asked to make impersonation
work on the live site, treat it as a security decision and confirm with the user
first. To remove the feature entirely: delete the toggle component + dev-user
helper, the `getDevOverrideUserId` block in auth.ts, and `setExtraHeaders` usage.
