<#
.SYNOPSIS
    Bootstrap the jukebox on Windows with Docker Desktop.

.DESCRIPTION
    Generates the secrets that must not be guessable, writes .env, and starts
    the app. Safe to re-run: an existing .env is never overwritten.

    Windows runs the APP ONLY. Docker Desktop's Linux VM has no access to the
    sound card, so librespot cannot play audio here. For the real jukebox the
    box needs Linux — see DEPLOY.md.

.EXAMPLE
    .\scripts\setup.ps1
#>

[CmdletBinding()]
param(
    # Set your own admin password instead of a generated one.
    [string] $AdminPassword
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Write-Step($m) { Write-Host "`n==> $m" -ForegroundColor White }
function Write-Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

# --- Docker ----------------------------------------------------------------

Write-Step 'Docker'
try {
    $version = docker version --format '{{.Server.Version}}' 2>$null
    if (-not $version) { throw 'no server version' }
    Write-Ok "Docker Desktop is running (engine $version)"
} catch {
    Write-Host '    Docker is not reachable. Start Docker Desktop and wait for it to say "Engine running", then re-run this.' -ForegroundColor Red
    exit 1
}

# --- audio reality check ---------------------------------------------------

Write-Step 'Audio'
Write-Warn 'Windows cannot run the audio half of this jukebox.'
Write-Warn 'Docker Desktop has no access to the sound card, so librespot is not started.'
Write-Warn 'The app, admin panel and guest page all work; nothing will play.'

# --- .env ------------------------------------------------------------------

Write-Step 'Configuration'

if (Test-Path .env) {
    Write-Ok '.env already exists; leaving it alone'
} else {
    if (-not (Test-Path .env.example)) { throw '.env.example is missing — is this the repository root?' }

    # 36 random bytes, base64. Signs session cookies.
    $bytes = New-Object byte[] 36
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $cookieSecret = [Convert]::ToBase64String($bytes)

    if ([string]::IsNullOrWhiteSpace($AdminPassword)) {
        $suffix = -join ((48..57) + (97..122) | Get-Random -Count 8 | ForEach-Object { [char]$_ })
        $AdminPassword = "jukebox-$suffix"
    }

    Write-Ok 'hashing the admin password (pulls node:20-slim the first time)'
    $node = "npm i -s bcryptjs >/dev/null 2>&1 && node -e `"console.log(require('bcryptjs').hashSync(process.argv[1],12))`" '$AdminPassword'"
    $adminHash = (docker run --rm node:20-slim sh -c $node) | Select-Object -Last 1

    if ($adminHash -notmatch '^\$2[aby]\$\d{2}\$') { throw "could not generate a bcrypt hash; got: $adminHash" }

    $content = Get-Content .env.example -Raw

    # Single quotes on the hash: it contains '$', which Docker Compose would
    # otherwise read as a variable to substitute, leaving a mangled value.
    $content = $content -replace '(?m)^COOKIE_SECRET=.*$',       "COOKIE_SECRET='$cookieSecret'"
    $content = $content -replace '(?m)^ADMIN_PASSWORD_HASH=.*$', "ADMIN_PASSWORD_HASH='$adminHash'"
    $content = $content -replace '(?m)^PUBLIC_URL=.*$',          'PUBLIC_URL=http://127.0.0.1:8080'
    $content = $content -replace '(?m)^SPOTIFY_CLIENT_ID=.*$',     'SPOTIFY_CLIENT_ID=replace-me-from-spotify-dashboard'
    $content = $content -replace '(?m)^SPOTIFY_CLIENT_SECRET=.*$', 'SPOTIFY_CLIENT_SECRET=replace-me-from-spotify-dashboard'

    # LF line endings and no byte-order mark. A BOM would turn the first key
    # into something no dotenv parser recognises.
    $content = $content -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText(
        (Join-Path (Get-Location) '.env'),
        $content,
        (New-Object System.Text.UTF8Encoding($false))
    )

    Write-Ok 'wrote .env'
    Write-Host "`n    ADMIN PASSWORD: $AdminPassword" -ForegroundColor Cyan
    Write-Host '    Write this down — it is not stored anywhere in plain text.'
}

# --- start -----------------------------------------------------------------

Write-Step 'Starting'
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { throw 'docker compose failed' }

Write-Step 'Done'
Write-Ok 'guest page:  http://127.0.0.1:8080/'
Write-Ok 'admin:       http://127.0.0.1:8080/admin'
Write-Host ''
Write-Host '    Logs:  docker compose logs -f'
Write-Host '    Stop:  docker compose down'
Write-Host ''
Write-Host '    Spotify search and playback stay off until you put real credentials'
Write-Host '    in .env and restart. Audio needs a Linux box — see DEPLOY.md.'
