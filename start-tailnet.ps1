param(
  [int]$WebPort = 21152,
  [int]$ApiPort = 8080
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
$env:NODE_ENV = "development"
$env:BASE_PATH = "/"
$env:PATH = (Join-Path $runtimeRoot "native\git\usr\bin") + ";" +
  (Join-Path $runtimeRoot "node\bin") + ";" +
  (Join-Path $runtimeRoot "bin") + ";" +
  $env:PATH

$logs = Join-Path $root ".local-dev"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$apiLog = Join-Path $logs "tailnet-api.log"
$webLog = Join-Path $logs "tailnet-web.log"

foreach ($port in @($ApiPort, $WebPort)) {
  $existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($processId in $existing) {
    if ($processId) {
      Stop-Process -Id $processId -Force
    }
  }
}

Push-Location $root
try {
  Start-Process -WindowStyle Hidden -FilePath "powershell" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    "`$env:PATH='$($env:PATH)'; `$env:NODE_ENV='development'; `$env:PORT='$ApiPort'; `$env:DATABASE_URL='$($env:DATABASE_URL)'; `$env:CLERK_SECRET_KEY='$($env:CLERK_SECRET_KEY)'; `$env:CLERK_PUBLISHABLE_KEY='$($env:CLERK_PUBLISHABLE_KEY)'; cd '$root'; pnpm --filter @workspace/api-server run build; pnpm --filter @workspace/api-server run start *> '$apiLog'"
  )

  Start-Sleep -Seconds 2

  Start-Process -WindowStyle Hidden -FilePath "powershell" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    "`$env:PATH='$($env:PATH)'; `$env:NODE_ENV='development'; `$env:PORT='$WebPort'; `$env:BASE_PATH='/'; `$env:VITE_CLERK_PUBLISHABLE_KEY='$($env:VITE_CLERK_PUBLISHABLE_KEY)'; cd '$root'; pnpm --filter @workspace/b5acta run dev *> '$webLog'"
  )
}
finally {
  Pop-Location
}

$addresses = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
  Select-Object -ExpandProperty IPAddress

Write-Host "Tailnet/dev game preview starting"
Write-Host "API log: $apiLog"
Write-Host "Web log: $webLog"
Write-Host "Local URL: http://localhost:$WebPort"
foreach ($address in $addresses) {
  Write-Host "Reachable URL: http://$address`:$WebPort"
}
Write-Host "Use this mode for Tailscale access to existing dev games such as /games/7."
