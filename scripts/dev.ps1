$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (!(Test-Path "web\node_modules")) {
    npm --prefix web ci
}

$api = Start-Process -FilePath "go" `
    -ArgumentList @("run", ".\cmd\hlool-pdf", "--mode", "desktop", "--addr", "127.0.0.1:8088", "--data-dir", ".\.hlool-data-dev", "--open=false") `
    -PassThru `
    -WindowStyle Hidden

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
