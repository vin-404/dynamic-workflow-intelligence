# Starts the backend correctly. Run from anywhere:  .\scripts\run-backend.ps1
# Two things this gets right that are easy to get wrong by hand:
#   1. cwd MUST be the repo root  (backend/app/services/intelligence.py does `import engine`)
#   2. port MUST be 8001          (the frontend's fallback API URL)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path ".\.venv\Scripts\python.exe")) {
    Write-Host "No virtual environment found. Run .\scripts\setup.ps1 first." -ForegroundColor Red
    exit 1
}

Write-Host "Starting backend on http://localhost:8001 (repo root: $root)" -ForegroundColor Cyan
Write-Host "Health check: http://localhost:8001/health`n" -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m uvicorn backend.app.main:app --reload --port 8001
