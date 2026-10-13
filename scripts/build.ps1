$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
npm --prefix web ci
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Dependency download failed; retrying via http://127.0.0.1:9000'
    $env:HTTP_PROXY = 'http://127.0.0.1:9000'
    $env:HTTPS_PROXY = 'http://127.0.0.1:9000'
    npm --prefix web ci --proxy http://127.0.0.1:9000
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
npm --prefix web run build
if ($LASTEXITCODE -ne 0) { throw 'Browser build failed.' }
Write-Host 'Built web/dist. Preview with npm run preview. Go is not required.'
