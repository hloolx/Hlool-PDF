# 可选的浏览器盖章引擎 ↔ Go 参考引擎的像素级对比。
# 用法：pwsh scripts/verify-local-engine.ps1
# 本机已有 Edge 时可设置 $env:PLAYWRIGHT_CHANNEL='msedge'。
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot 'verify-local-engine'

Push-Location $dir
try {
    if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
        npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'Direct install failed; retrying via http://127.0.0.1:9000'
            $env:HTTP_PROXY = $env:HTTPS_PROXY = 'http://127.0.0.1:9000'
            npm ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
        }
    }
    # Chromium 已在缓存则秒过；首跑会下载一次。
    if (-not $env:PLAYWRIGHT_CHANNEL) {
        npx playwright install chromium
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'Direct download failed; retrying via http://127.0.0.1:9000'
            $env:HTTP_PROXY = $env:HTTPS_PROXY = 'http://127.0.0.1:9000'
            npx playwright install chromium
            if ($LASTEXITCODE -ne 0) { throw 'playwright install failed' }
        }
    }

    node verify.mjs
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
