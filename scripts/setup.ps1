# Setup script — run from the repo root:  .\scripts\setup.ps1
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "Repo root: $root" -ForegroundColor Cyan

# --- Python version check -----------------------------------------------
$pyv = (python --version 2>&1)
Write-Host "Found $pyv"
if ($pyv -match "Python 3\.(\d+)") {
    $minor = [int]$Matches[1]
    if ($minor -lt 11) { Write-Host "ERROR: Python 3.11+ required (the code uses 'X | Y' type syntax)." -ForegroundColor Red; exit 1 }
    if ($minor -ge 13) { Write-Host "WARNING: Python 3.$minor may lack prebuilt wheels. 3.11 or 3.12 is safest." -ForegroundColor Yellow }
}

# --- Node version check -------------------------------------------------
try {
    $nodev = (node --version)
    Write-Host "Found Node $nodev"
    if ($nodev -match "^v(\d+)") {
        if ([int]$Matches[1] -lt 20) { Write-Host "ERROR: Node 20+ required for Next.js 16 (found $nodev)." -ForegroundColor Red; exit 1 }
    }
} catch { Write-Host "ERROR: Node.js not found. Install Node 20 or newer." -ForegroundColor Red; exit 1 }

# --- warn about the .env trap -------------------------------------------
if (Test-Path ".env") {
    Write-Host "WARNING: a .env file exists. If it came from .env.example it points at PostgreSQL and the app will crash. Delete it unless you meant it." -ForegroundColor Yellow
}

# --- backend ------------------------------------------------------------
Write-Host "`nCreating virtual environment..." -ForegroundColor Cyan
if (-not (Test-Path ".venv")) { python -m venv .venv }
& ".\.venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
Write-Host "Installing backend dependencies (this takes a minute)..." -ForegroundColor Cyan
& ".\.venv\Scripts\python.exe" -m pip install -r "backend\requirements.txt" --quiet
Write-Host "Backend dependencies installed." -ForegroundColor Green

# --- frontend -----------------------------------------------------------
Write-Host "`nInstalling frontend dependencies (this takes a few minutes)..." -ForegroundColor Cyan
Push-Location frontend
npm install --silent
Pop-Location
Write-Host "Frontend dependencies installed." -ForegroundColor Green

Write-Host @"

Setup complete. Now open TWO terminals, both at the repo root:

  Terminal 1:  .\scripts\run-backend.ps1
  Terminal 2:  cd frontend ; npm run dev

Then open http://localhost:3000
Backend health check: http://localhost:8001/health
"@ -ForegroundColor Green
