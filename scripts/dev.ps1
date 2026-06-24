$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (!(Test-Path "web\node_modules")) {
    npm --prefix web ci
}

$logDir = Join-Path $root ".run-logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$apiErr = Join-Path $logDir "api-dev.log"
$apiOut = Join-Path $logDir "api-dev.out.log"

# Allow the Vite dev origin through the backend's CSRF/origin guard. The browser
# talks to Vite (:5173) which proxies to the API (:8088); without this, every
# state-changing POST (login, guest, compose, …) is rejected as cross-origin 403.
$env:HLOOL_CORS_ORIGINS = "http://127.0.0.1:5173"

$api = Start-Process -FilePath "go" `
    -ArgumentList @("run", ".\cmd\hlool-pdf", "--addr", "127.0.0.1:8088", "--data-dir", ".\.hlool-data-dev", "--open=false") `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardError $apiErr `
    -RedirectStandardOutput $apiOut

Write-Host "Backend (go) logs -> $apiErr"

try {
    for ($i = 0; $i -lt 40; $i++) {
        try {
            $health = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8088/healthz" -TimeoutSec 1
            if ($health.StatusCode -eq 200) {
                break
            }
        } catch {
            if ($api.HasExited) {
                throw "Go API exited before becoming healthy."
            }
            Start-Sleep -Milliseconds 250
        }
    }
    npm --prefix web run dev -- --host 127.0.0.1 --port 5173 --strictPort
} finally {
    if (!$api.HasExited) {
        Stop-Process -Id $api.Id -Force
    }
}
