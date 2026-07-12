# Public Alpha Deployment Prep

This project is ready to prepare as a remote-hosted public alpha without exposing the local machine.

## Recommended first host

Use Render for the first broader test:

- One Node web service serves both the API and the built React client.
- One managed Render Postgres database stores games and player data.
- Clerk handles user auth.
- The deployment branch is `public-alpha`, not the day-to-day development branch.
- The Render build runs `pnpm --filter @workspace/db run push-force` so a newly provisioned Postgres instance receives the Drizzle schema before the API starts serving traffic.
- API startup seeds the base ACTA roster from the checked-in ship CSV, then applies bespoke maintenance rows; this keeps fresh Render databases from missing ships such as Nova and Omega.

Approximate monthly floor:

- Render web service `starter`: 512 MB RAM / 0.5 CPU, listed at $7/month.
- Render Postgres `basic-256mb`: current smallest paid database plan. Render's Blueprint docs list this as the default current database plan for new databases.
- Clerk Hobby: free up to 50,000 monthly retained users per app.

This should fit the expected load of roughly 12 usual users and 24-36 peak concurrent players because the app currently uses normal HTTP polling and database-backed state, not a CPU-heavy realtime simulation server.

## Branch strategy

Use these branches:

- `main`: active development, can keep local/dev conveniences.
- `public-alpha`: stable branch Render deploys from.
- `feature/<name>`: experimental work.

Release flow:

```powershell
git checkout main
git pull
pnpm run typecheck
pnpm --filter @workspace/api-server build
git checkout public-alpha
git merge main
git push github public-alpha
```

Render is configured with `autoDeployTrigger: off` in `render.yaml`, so deployment should be a deliberate button click in Render after the branch is pushed.

## Dev switch policy

The current code already separates local dev from production:

- Frontend dev switching is gated by `import.meta.env.DEV`.
- Temporary username auth is gated by `VITE_B5_USERNAME_AUTH`.
- Backend `x-dev-user-id` impersonation is ignored in production unless temporary username auth is explicitly enabled.

For public alpha, do not set:

```text
B5_USERNAME_AUTH=true
B5_TEMP_USERNAME_AUTH=true
VITE_B5_USERNAME_AUTH=true
```

The included `render.yaml` pins those values to `"false"`.

## Security baseline

Required before sharing the URL:

1. Use Clerk production keys, not test keys.
2. Set `B5_ALLOWED_USERS` for a closed alpha.
3. Set `B5_ALLOWED_ORIGINS` after the Render URL or custom domain is known.
4. Keep Render Postgres `ipAllowList: []`, meaning private-network access only.
5. Do not expose local Windows services or local Postgres to the internet.
6. Do not commit real `.env` files, database URLs, Clerk secrets, or local Postgres passwords.
7. Confirm `NODE_ENV=production`.
8. Confirm `/api/healthz` works on the deployed URL.

## Render setup

1. Connect GitHub repo `saladiin/ACTA` to Render.
2. Create a new Blueprint from `render.yaml`.
3. Use branch `public-alpha`.
4. Enter these secrets when Render prompts:
   - `CLERK_SECRET_KEY`
   - `CLERK_PUBLISHABLE_KEY`
   - `VITE_CLERK_PUBLISHABLE_KEY`
   - `B5_ALLOWED_USERS`
   - `B5_ALLOWED_ORIGINS`
5. Deploy.
6. Add the Render URL in Clerk as an allowed origin/redirect URL.
7. Visit `/api/healthz`.
8. Sign in as an allowlisted user and create a test game.

## Cost guardrails

Stay under scrutiny threshold by starting with:

- `starter` web service.
- `basic-256mb` Postgres.
- One app instance.
- Manual deploys.
- No preview environments.
- No Redis/key-value service.
- No autoscaling.

Upgrade only if observed metrics require it:

- Web memory consistently near 512 MB -> move web service to `standard`.
- DB CPU/memory saturated or slow queries -> move Postgres to `basic-1gb`.
- Polling load becomes excessive -> reduce polling frequency or add realtime only after measuring.

## Pre-launch test checklist

- Build: `pnpm --filter @workspace/b5acta run build`
- Build: `pnpm --filter @workspace/api-server run build`
- Typecheck: `pnpm run typecheck`
- New user sign-up/sign-in works.
- Allowlisted user can create a game.
- Non-allowlisted user gets blocked.
- Two real accounts can join and play at least one round.
- AI game can run at least one full round.
- Refreshing the browser preserves session and game state.
- Mobile/tablet can open board, select ships, and use controls.
- Logs redact auth headers and cookies.

## Later hardening

Before a wider public link:

- Add request rate limiting on `/api`.
- Add basic abuse logging for repeated 401/403/429 responses.
- Add database backup/export instructions.
- Add a public credits/attribution page for fan-use assets.
- Add a visible alpha disclaimer and contact/report-bug link.
- Add a lightweight admin page or SQL recipe for disabling abusive users.
