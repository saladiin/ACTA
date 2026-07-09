param(
  [int]$Port = 21152,
  [string]$AllowedUsers = "",
  [string]$AllowedOrigins = "",
  [switch]$NoBuild
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backupRoot = Split-Path -Parent (Split-Path -Parent $root)
$envFile = Join-Path $backupRoot "B5.env"
$pgPasswordFile = Join-Path $backupRoot "postgres-local-admin-password.txt"
$runtimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies"

if (-not (Test-Path -LiteralPath $envFile)) {
  throw "Missing env backup: $envFile"
}

if (-not (Test-Path -LiteralPath $pgPasswordFile)) {
  throw "Missing local Postgres password file: $pgPasswordFile"
}

Get-Content -LiteralPath $envFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -eq "" -or $line.StartsWith("#") -or $line -notmatch "=") { return }
  $parts = $line -split "=", 2
  [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
}

$pgPassword = Get-Content -LiteralPath $pgPasswordFile -Raw
$encodedPassword = [Uri]::EscapeDataString($pgPassword.Trim())

$env:DATABASE_URL = "postgresql://postgres:$encodedPassword@localhost:5432/b5acta_dev"
$env:NODE_ENV = "production"
$env:BASE_PATH = "/"
$env:PORT = "$Port"
$env:B5_SERVE_WEB = "true"
$env:B5_USERNAME_AUTH = "true"
$env:VITE_B5_USERNAME_AUTH = "true"
$env:VITE_CLERK_PROXY_URL = "/api/__clerk"
if ($AllowedUsers.Trim() -ne "") { $env:B5_ALLOWED_USERS = $AllowedUsers.Trim() }
if ($AllowedOrigins.Trim() -ne "") { $env:B5_ALLOWED_ORIGINS = $AllowedOrigins.Trim() }

$env:PATH = (Join-Path $runtimeRoot "native\git\usr\bin") + ";" +
  (Join-Path $runtimeRoot "node\bin") + ";" +
  (Join-Path $runtimeRoot "bin") + ";" +
  $env:PATH

$logs = Join-Path $root ".local-dev"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$apiLog = Join-Path $logs "remote-api.log"

Push-Location $root
try {
  if (-not $NoBuild) {
    pnpm --filter @workspace/b5acta run build
    pnpm --filter @workspace/api-server run build
  }

  $existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty OwningProcess
  if ($existing) {
    Stop-Process -Id $existing -Force
    Start-Sleep -Seconds 1
  }

  Start-Process -WindowStyle Hidden -FilePath "powershell" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    "`$env:PATH='$($env:PATH)'; `$env:NODE_ENV='production'; `$env:PORT='$Port'; `$env:DATABASE_URL='$($env:DATABASE_URL)'; `$env:CLERK_SECRET_KEY='$($env:CLERK_SECRET_KEY)'; `$env:CLERK_PUBLISHABLE_KEY='$($env:CLERK_PUBLISHABLE_KEY)'; `$env:B5_SERVE_WEB='true'; `$env:B5_USERNAME_AUTH='true'; `$env:B5_ALLOWED_USERS='$($env:B5_ALLOWED_USERS)'; `$env:B5_ALLOWED_ORIGINS='$($env:B5_ALLOWED_ORIGINS)'; cd '$root'; pnpm --filter @workspace/api-server run start *> '$apiLog'"
  )
}
finally {
  Pop-Location
}

$addresses = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
  Select-Object -ExpandProperty IPAddress

Write-Host "Remote game server starting on port $Port"
Write-Host "Log: $apiLog"
Write-Host "Local URL: http://localhost:$Port"
foreach ($address in $addresses) {
  Write-Host "LAN URL: http://$address`:$Port"
}
if ($env:B5_ALLOWED_USERS) {
  Write-Host "Access allowlist: configured"
} else {
  Write-Host "Access allowlist: not configured"
}
