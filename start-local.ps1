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
  (Join-Path $runtimeRoot "bin\fallback") + ";" +
  (Join-Path $runtimeRoot "bin") + ";" +
  $env:PATH

$logs = Join-Path $root ".local-dev"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$apiLog = Join-Path $logs "api.log"
$webLog = Join-Path $logs "web.log"

function Stop-LocalPortProcess {
  param([int]$Port)

  $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
  $processIds = $connections |
    Where-Object { $_.OwningProcess -and $_.OwningProcess -ne $PID } |
    Select-Object -ExpandProperty OwningProcess -Unique

  foreach ($processId in $processIds) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $process) { continue }
    Stop-Process -Id $processId -Force
  }
}

Stop-LocalPortProcess -Port 8080
Stop-LocalPortProcess -Port 21152
Stop-LocalPortProcess -Port 5173
Stop-LocalPortProcess -Port 5174

Push-Location $root
try {
  $env:PORT = "8080"
  Start-Process -WindowStyle Hidden -FilePath "powershell" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    "`$env:PATH='$($env:PATH)'; `$env:NODE_ENV='development'; `$env:PORT='8080'; `$env:DATABASE_URL='$($env:DATABASE_URL)'; `$env:CLERK_SECRET_KEY='$($env:CLERK_SECRET_KEY)'; `$env:CLERK_PUBLISHABLE_KEY='$($env:CLERK_PUBLISHABLE_KEY)'; cd '$root'; pnpm --filter @workspace/api-server run build; pnpm --filter @workspace/api-server run start *> '$apiLog'"
  )

  Start-Sleep -Seconds 2

  $env:PORT = "21152"
  Start-Process -WindowStyle Hidden -FilePath "powershell" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    "`$env:PATH='$($env:PATH)'; `$env:NODE_ENV='development'; `$env:PORT='21152'; `$env:BASE_PATH='/'; `$env:VITE_CLERK_PUBLISHABLE_KEY='$($env:VITE_CLERK_PUBLISHABLE_KEY)'; cd '$root'; pnpm --filter @workspace/b5acta run dev *> '$webLog'"
  )
}
finally {
  Pop-Location
}

Write-Host "Local API log: $apiLog"
Write-Host "Local web log: $webLog"
Write-Host "Open: http://localhost:21152"
