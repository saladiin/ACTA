# Local Development

This project can run locally on Windows using the downloaded Replit project,
the restored PostgreSQL dump, and the private env backup stored beside the
archive.

## Prerequisites

- PostgreSQL 16 Windows service: `postgresql-x64-16`
- Local database: `b5acta_dev`
- Private files in the parent backup folder:
  - `B5.env`
  - `postgres-local-admin-password.txt`

Do not commit either private file.

## Start

From the project root:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-local.ps1
```

Then open:

```text
http://localhost:21152/lobby
```

## Remote Access Prep

Use `start-local.ps1` only for trusted local development. It runs in development
mode and exposes the built-in P1/P2 commander switch.

For selected remote players, use the production-style remote host script instead:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-remote.ps1 -Port 21152 -AllowedUsers "friend@example.com,user_abc123"
```

See `docs\REMOTE_ACCESS.md` for the full checklist.

## Dev Auth

Local development bypasses Clerk route protection and uses the built-in dev
commander switch:

- `test-user-1`
- `test-user-2`

The API only honors the dev user header when `NODE_ENV` is not `production`.

## Ports

- Frontend: `http://localhost:21152`
- API: `http://localhost:8080`

The Vite dev server proxies `/api` to `http://localhost:8080`.

## Logs

The start script writes logs here:

```text
.local-dev\api.log
.local-dev\web.log
```
