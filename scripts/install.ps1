# ChatBridge: install or update on this PC.
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$node = (node --version) -replace '^v',''
if ([version]($node -split '-')[0] -lt [version]"22.12.0") { throw "Node $node is too old; install Node 22.12 or newer." }

Write-Host "installing dependencies..." -ForegroundColor Cyan
if (Test-Path package-lock.json) { npm ci } else { npm install }

Write-Host "building..." -ForegroundColor Cyan
npm run build

Write-Host "running tests..." -ForegroundColor Cyan
npm test

Write-Host "linking the chatbridge command..." -ForegroundColor Cyan
npm link

if (-not (Test-Path "$env:USERPROFILE\.chatbridge\config.json")) {
  Write-Host "first run: creating config and owner credentials..." -ForegroundColor Cyan
  chatbridge init
}

Write-Host ""
chatbridge doctor
Write-Host ""
Write-Host "done. next:" -ForegroundColor Green
Write-Host "  chatbridge tunnel status     is ChatGPT able to reach this PC"
Write-Host "  chatbridge workbench <folder>  open the workbench"
