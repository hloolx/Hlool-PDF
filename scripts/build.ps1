$ErrorActionPreference = "Stop"

function Invoke-WithProxyRetry {
    param(
        [Parameter(Mandatory=$true)]
        [scriptblock]$Command
    )
    try {
        & $Command
    } catch {
        Write-Host "Direct network/build step failed; retrying via http://127.0.0.1:9000"
        $env:HTTP_PROXY = "http://127.0.0.1:9000"
        $env:HTTPS_PROXY = "http://127.0.0.1:9000"
        & $Command
    }
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Invoke-WithProxyRetry { npm --prefix web ci }
npm --prefix web run build

Invoke-WithProxyRetry { go test ./... }

New-Item -ItemType Directory -Path dist -Force | Out-Null
$env:CGO_ENABLED = "0"
$env:GOOS = "windows"
$env:GOARCH = "amd64"
go build -tags embed -trimpath -ldflags "-s -w" -o dist\hlool-pdf.exe .\cmd\hlool-pdf

Write-Host "Built dist\hlool-pdf.exe"
