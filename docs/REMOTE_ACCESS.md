# Remote Access Prep

This project now has a production-style local host mode for letting selected
people access the game remotely.

## What This Mode Does

- Runs the API with `NODE_ENV=production`, so the dev P1/P2 impersonation header
  is ignored.
- Serves the built React game from the API process, so remote players use one
  origin instead of a Vite dev server plus API proxy.
- Supports an optional access allowlist with `B5_ALLOWED_USERS`.
- Supports optional CORS narrowing with `B5_ALLOWED_ORIGINS`.

## Access Allowlist

Set `B5_ALLOWED_USERS` to a comma, semicolon, or whitespace separated list.
Entries may be:

- Clerk user IDs
- Clerk usernames
- Clerk account email addresses

Example:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-remote.ps1 `
  -Port 21152 `
  -AllowedUsers "user_abc123, friend@example.com"
```

If `B5_ALLOWED_USERS` is empty, any signed-in Clerk user can access the app.

## Start Remote Host Mode

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-remote.ps1 -Port 21152
```

The script prints:

- `Local URL`
- one or more `LAN URL` values
- the remote API log path

Players on the same LAN can open the printed LAN URL, assuming Windows Firewall
allows inbound TCP traffic on that port.

To verify only the API path through a LAN URL, open:

```text
http://LAN-IP:21152/api/healthz
```

## Windows Firewall

If LAN users cannot connect, add an inbound rule for the chosen port from an
administrator PowerShell:

```powershell
New-NetFirewallRule `
  -DisplayName "B5 ACTA Remote Game 21152" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 21152 `
  -Action Allow
```

## Internet Access

For true internet access, put this server behind a trusted tunnel or reverse
proxy instead of exposing the machine directly. Suitable options include a VPN,
a private tunnel, or a reverse proxy with HTTPS.

When using a public hostname:

1. Configure Clerk to allow the public origin/redirect URL.
2. Start the server with a restrictive allowlist.
3. Prefer HTTPS.
4. Share only the public hostname with approved players.

Example:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-remote.ps1 `
  -Port 21152 `
  -AllowedUsers "friend@example.com,user_abc123" `
  -AllowedOrigins "https://your-game-host.example"
```

## iPhone and iPad Access

The web client includes iOS web-app metadata and touch-safe board styling. On
iOS, prefer Safari for the first sign-in because it has the most predictable
Clerk session handling.

For the existing local/dev games, especially games created with `test-user-1`
and `test-user-2`, use the Tailscale dev preview mode:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-tailnet.ps1
```

Then open the printed Tailscale URL, for example:

```text
http://100.112.28.113:21152/games/7
```

This mode keeps the dev commander switch available and avoids Clerk custom-domain
redirect issues on raw Tailscale IP addresses. Only use it on a trusted tailnet.

Recommended iOS setup:

1. Host the game behind HTTPS for anyone outside your LAN.
2. Add the public HTTPS URL to Clerk's allowed origins and redirect URLs.
3. Start remote mode with `-AllowedUsers`.
4. On the iPhone or iPad, open the shared URL in Safari and sign in.
5. Optional: use Safari Share -> Add to Home Screen for standalone app-style
   launch.

Touch controls currently map to the 3D board as follows:

- Tap a ship to select it.
- One-finger drag pans the board.
- Two-finger pinch zooms and rotates the board.
- Sidebar controls remain normal touch buttons and lists.

Known mobile constraint: the rules UI is usable on iOS, but it is still a dense
desktop-first command surface. A later dedicated mobile pass should add larger
bottom action controls for movement/firing, but remote iOS access is now
prepared at the hosting/app-shell level.

## Operational Notes

- Keep `B5.env` and `postgres-local-admin-password.txt` private.
- Use `start-local.ps1` for ordinary solo/local development.
- Use `start-remote.ps1` only when preparing a session for real remote users.
- Remote users need Clerk accounts that match the configured access allowlist.
