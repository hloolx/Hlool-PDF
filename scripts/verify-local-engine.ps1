# 本地盖章引擎 ↔ 服务端引擎的像素级对齐验收（LOCAL_FIRST.md P1-1）。
# 用法：pwsh scripts/verify-local-engine.ps1
# 全绿才允许合入任何触碰盖章语义的改动（两个引擎必须同步修改）。
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot 'verify-local-engine'

Push-Location $dir
try {
    if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
        Write-Host '== npm install (first run) =='
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    }
    # Chromium 已在缓存则秒过；首跑会下载一次。
    npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw 'playwright install failed' }

    node verify.mjs
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
