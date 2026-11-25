# One-command setup & launcher for Windows
# Automatically downloads CLI_to_API, installs dependencies, starts the local
# API bridge, and launches the desktop video editor.

$ErrorActionPreference = "Stop"

$RootDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cli2ApiDir = Join-Path $RootDir ".cli2api"
$WorkDir    = Join-Path $RootDir ".autocut-work"
$Cli2ApiRepo = "https://github.com/alipyth/CLI_to_API.git"
$Port       = 8787
$HealthUrl  = "http://127.0.0.1:$Port/health"

function Require-Command($name, $hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Write-Host "[error] '$name' is required but not found on PATH." -ForegroundColor Red
        Write-Host "        $hint" -ForegroundColor Yellow
        exit 1
    }
}

Require-Command "git"    "Install Git: https://git-scm.com/downloads"
Require-Command "python" "Install Python 3.10+: https://www.python.org/downloads/"
Require-Command "cargo"  "Install Rust: https://rustup.rs"

$pnpmCmd = if (Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue) {
    "pnpm.cmd"
} elseif (Get-Command "pnpm" -ErrorAction SilentlyContinue) {
    "pnpm"
} else {
    Write-Host "[setup] pnpm not found — installing globally via npm..." -ForegroundColor Cyan
    npm.cmd install -g pnpm
    "pnpm.cmd"
}

if (-not (Test-Path $WorkDir)) {
    New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
}

# 1. Auto-download CLI_to_API if missing
if (-not (Test-Path (Join-Path $Cli2ApiDir "pyproject.toml"))) {
    Write-Host "[cli2api] Cloning CLI_to_API into .cli2api..." -ForegroundColor Cyan
    git clone --depth 1 $Cli2ApiRepo $Cli2ApiDir
}

# 2. Create virtualenv & install cli2api on first run
$venvPy = Join-Path $Cli2ApiDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
    Write-Host "[cli2api] Creating Python virtual environment and installing dependencies..." -ForegroundColor Cyan
    python -m venv (Join-Path $Cli2ApiDir ".venv")
    & $venvPy -m pip install --quiet --upgrade pip
    & $venvPy -m pip install --quiet -e $Cli2ApiDir
}

function Test-Cli2Api {
    try {
        $r = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2 -ErrorAction Stop
        return ($r.status -eq "ok")
    } catch {
        return $false
    }
}

# 3. Start cli2api bridge in background (if not already running)
$cliProc = $null
if (Test-Cli2Api) {
    Write-Host "[cli2api] Already running on http://127.0.0.1:$Port" -ForegroundColor Green
} else {
    Write-Host "[cli2api] Starting local API bridge on http://127.0.0.1:$Port..." -ForegroundColor Cyan
    $env:CLI2API_CORS_ORIGINS = "*"
    $env:CLI2API_WORKDIR      = $WorkDir
    $env:CLI2API_PORT         = "$Port"

    $cliProc = Start-Process -FilePath $venvPy `
        -ArgumentList @("-m", "cli2api", "serve", "--host", "127.0.0.1", "--port", "$Port") `
        -WorkingDirectory $Cli2ApiDir `
        -PassThru `
        -WindowStyle Minimized

    Write-Host -NoNewline "[cli2api] Waiting for server" -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Cli2Api) { $ready = $true; break }
        Write-Host -NoNewline "."
    }
    Write-Host ""

    if ($ready) {
        Write-Host "[cli2api] Ready at http://127.0.0.1:$Port/v1" -ForegroundColor Green
    } else {
        Write-Host "[cli2api] Server is still starting; check the minimized window if needed." -ForegroundColor Yellow
    }
}

# 4. Install frontend packages on first run & launch desktop app
try {
    Set-Location $RootDir
    if (-not (Test-Path (Join-Path $RootDir "node_modules"))) {
        Write-Host "[autocut] Installing frontend dependencies..." -ForegroundColor Cyan
        & $pnpmCmd install
    }

    Write-Host "[autocut] Launching desktop app (first build downloads ffmpeg sidecars)..." -ForegroundColor Cyan
    & $pnpmCmd tauri:dev
} finally {
    if ($cliProc -and -not $cliProc.HasExited) {
        Write-Host "[cli2api] Stopping background bridge..." -ForegroundColor DarkGray
        Stop-Process -Id $cliProc.Id -Force -ErrorAction SilentlyContinue
    }
}
