<#
.SYNOPSIS
    Set up and start the jukebox on this machine.

.DESCRIPTION
    Asks for the keys it needs, writes .env, and starts the containers. Safe to
    re-run: it offers to keep an existing .env rather than overwriting it.

    Double-click setup.bat rather than running this directly -- Windows blocks
    local scripts by default and the .bat gets past that.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
#>

# ASCII only: Windows PowerShell 5.1 decodes .ps1 as ANSI unless the file has a
# UTF-8 BOM, which turns anything else into mojibake.

[CmdletBinding()]
param(
    # Skip the questions and only (re)start the containers.
    [switch] $StartOnly
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "    $m" -ForegroundColor Red }

function Ask($prompt, $default) {
    if ($default) {
        $answer = Read-Host "    $prompt [$default]"
        if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
        return $answer.Trim()
    }
    return (Read-Host "    $prompt").Trim()
}

function AskSecret($prompt) {
    $secure = Read-Host "    $prompt" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function AskYesNo($prompt, $defaultYes) {
    $suffix = if ($defaultYes) { '[Y/n]' } else { '[y/N]' }
    $answer = (Read-Host "    $prompt $suffix").Trim().ToLower()
    if ($answer -eq '') { return $defaultYes }
    return ($answer -eq 'y' -or $answer -eq 'yes')
}

Write-Host ''
Write-Host '  JUKEBOX SETUP' -ForegroundColor White
Write-Host '  ------------------------------------------------------------'

# --- Docker ----------------------------------------------------------------

Step 'Checking Docker'
$engine = $null
try { $engine = docker version --format '{{.Server.Version}}' 2>$null } catch { }
if (-not $engine) {
    Fail 'Docker is not running.'
    Fail 'Open Docker Desktop, wait until it says "Engine running", then run this again.'
    exit 1
}
Ok "Docker Desktop is running (engine $engine)"

# --- .env ------------------------------------------------------------------

$envPath = Join-Path (Get-Location) '.env'
$writeEnv = -not $StartOnly

if ($writeEnv -and (Test-Path $envPath)) {
    Step 'Existing configuration'
    Warn 'This folder already has a .env file.'
    $writeEnv = AskYesNo 'Replace it and enter the keys again?' $false
    if (-not $writeEnv) { Ok 'Keeping the existing .env' }
}

if ($writeEnv) {
    if (-not (Test-Path '.env.example')) { Fail '.env.example is missing -- is this the repo folder?'; exit 1 }

    Step 'Admin password'
    Write-Host '    This is how you sign in to the admin panel. Pick something you will remember.'
    $adminPassword = ''
    while ($adminPassword.Length -lt 10) {
        $adminPassword = AskSecret 'Admin password (at least 10 characters, not shown)'
        if ($adminPassword.Length -lt 10) { Warn 'Too short -- use at least 10 characters.' }
    }

    Step 'Spotify'
    Write-Host '    From https://developer.spotify.com/dashboard -- your app -> Settings.'
    Write-Host '    Leave blank to fill in later; search and playback stay off until you do.'
    $spotifyId = Ask 'Client ID' ''
    $spotifySecret = if ($spotifyId) { AskSecret 'Client secret (not shown)' } else { '' }
    if (-not $spotifyId)     { $spotifyId = 'replace-me-from-spotify-dashboard' }
    if (-not $spotifySecret) { $spotifySecret = 'replace-me-from-spotify-dashboard' }

    Step 'Stripe'
    Write-Host '    Only needed to charge for requests. Leave blank to run free.'
    Write-Host '    Use a TEST key (sk_test_...) until you have tried it end to end.'
    $stripeKey = AskSecret 'Stripe secret key (optional, not shown)'
    if ($stripeKey -and -not ($stripeKey -match '^(sk|rk)_(test|live)_')) {
        Warn 'That does not look like a Stripe secret key. Saving it anyway.'
    }
    if ($stripeKey -match '^(sk|rk)_live_') {
        Warn 'That is a LIVE key -- real cards will be charged once you turn off free mode.'
    }

    Step 'Network'
    $reachable = AskYesNo 'Should phones on this network be able to reach it?' $true
    $bindHost = if ($reachable) { '0.0.0.0' } else { '127.0.0.1' }
    # 'y' ended up in here once, answered to the previous yes/no question, and
    # Compose then failed with an unhelpful 'invalid containerPort: y'.
    $port = ''
    while ($port -eq '') {
        $answer = Ask 'Port to run on (a number)' '4321'
        if ($answer -match '^\d+$' -and [int]$answer -ge 1 -and [int]$answer -le 65535) {
            $port = $answer
        } else {
            Warn "'$answer' is not a port number. Enter something between 1 and 65535, or press Enter for 4321."
        }
    }

    Step 'Writing configuration'
    $bytes = New-Object byte[] 36
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $cookieSecret = [Convert]::ToBase64String($bytes)

    Ok 'Hashing the admin password (this pulls a small image the first time)'

    # Everything below is base64 so that nothing with a quote in it is ever
    # passed to a native command. Windows PowerShell does not escape embedded
    # double quotes when calling one, which silently corrupted the command and
    # produced 'sh: Syntax error: "(" unexpected'.
    $js = @'
const pw = Buffer.from(process.env.PWB64, 'base64').toString('utf8');
console.log(require('bcryptjs').hashSync(pw, 12));
'@
    $jsB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))
    $pwB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($adminPassword))

    # No quotes anywhere in this string, so there is nothing to mangle.
    # Install and run in the same directory: installing at / leaves the module
    # somewhere node will not resolve from, and it fails with MODULE_NOT_FOUND.
    $shell = 'cd /tmp && echo ' + $jsB64 + ' | base64 -d > h.js && npm i -s bcryptjs >/dev/null 2>&1 && node h.js'

    $output = docker run --rm -e PWB64=$pwB64 node:20-slim sh -c $shell 2>&1
    $adminHash = ($output | Where-Object { $_ -match '^\$2[aby]\$\d{2}\$' } | Select-Object -Last 1)

    if (-not $adminHash) {
        Fail 'Could not hash the admin password. Docker said:'
        $output | ForEach-Object { Write-Host "      $_" }
        Fail 'Nothing was written. Fix the above and run setup.bat again.'
        exit 1
    }
    Ok 'Password hashed'

    $content = Get-Content .env.example -Raw

    # The hash is single-quoted because it is full of $, which Docker Compose
    # would otherwise read as variables to substitute.
    $content = $content -replace '(?m)^COOKIE_SECRET=.*$',         "COOKIE_SECRET='$cookieSecret'"
    $content = $content -replace '(?m)^ADMIN_PASSWORD_HASH=.*$',   "ADMIN_PASSWORD_HASH='$adminHash'"
    $content = $content -replace '(?m)^SPOTIFY_CLIENT_ID=.*$',     "SPOTIFY_CLIENT_ID=$spotifyId"
    $content = $content -replace '(?m)^SPOTIFY_CLIENT_SECRET=.*$', "SPOTIFY_CLIENT_SECRET=$spotifySecret"
    $content = $content -replace '(?m)^STRIPE_SECRET_KEY=.*$',     "STRIPE_SECRET_KEY=$stripeKey"
    $content = $content -replace '(?m)^BIND_HOST=.*$',             "BIND_HOST=$bindHost"
    $content = $content -replace '(?m)^PORT=.*$',                  "PORT=$port"
    $content = $content -replace '(?m)^PUBLIC_URL=.*$',            "PUBLIC_URL=http://127.0.0.1:$port"

    # LF, and no byte-order mark: a BOM would make the first key unreadable.
    $content = $content -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($envPath, $content, (New-Object System.Text.UTF8Encoding($false)))
    Ok 'Wrote .env'
}

# --- start -----------------------------------------------------------------

$port = '4321'
$bindHost = '127.0.0.1'
if (Test-Path $envPath) {
    $envText = Get-Content $envPath -Raw
    if ($envText -match '(?m)^PORT=(.+)$')      { $port = $Matches[1].Trim().Trim("'").Trim('"') }
    if ($envText -match '(?m)^BIND_HOST=(.+)$') { $bindHost = $Matches[1].Trim().Trim("'").Trim('"') }
}

Step 'Starting'
Ok "port $port, reachable from $(if ($bindHost -eq '0.0.0.0') { 'anywhere on this network' } else { 'this machine only' })"
$composeArgs = @('compose', '-f', 'docker-compose.yml')
if (AskYesNo 'Also serve on port 80, so the address needs no port number?' $false) {
    $composeArgs += @('-f', 'docker-compose.port80.yml')
}
$composeArgs += @('up', '-d', '--build')

& docker @composeArgs
if ($LASTEXITCODE -ne 0) {
    Fail 'Docker could not start the stack. The error above says why.'
    Fail 'If it mentions port 80 being in use, run setup.bat again and answer no to the port 80 question.'
    Fail 'If it mentions an invalid port, your .env has a bad PORT value -- re-run and re-enter the keys.'
    exit 1
}

# --- did it actually stay up? ----------------------------------------------

Step 'Checking it came up'
$healthy = $false
foreach ($attempt in 1..20) {
    Start-Sleep -Seconds 3
    $state = (docker inspect -f '{{.State.Status}}' jukebox-app 2>$null)
    if ($state -eq 'running') {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 4 -UseBasicParsing
            if ($response.StatusCode -eq 200) { $healthy = $true; break }
        } catch { }
    }
    if ($state -eq 'restarting' -or $state -eq 'exited') {
        Fail "The container is $state -- it is crashing on startup. The last lines of its log:"
        Write-Host ''
        docker compose logs --no-log-prefix --tail 30 jukebox
        Write-Host ''
        Fail 'The usual cause is a bad value in .env. Run this again and re-enter the keys.'
        exit 1
    }
}

if (-not $healthy) {
    Fail 'It started but is not answering. The last lines of its log:'
    Write-Host ''
    docker compose logs --no-log-prefix --tail 30 jukebox
    exit 1
}

Step 'Ready'
Ok "guest page:  http://127.0.0.1:$port/"
Ok "admin:       http://127.0.0.1:$port/admin"
if ($bindHost -eq '0.0.0.0') {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
           Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
           Select-Object -First 1).IPAddress
    if ($ip) { Ok "on this network: http://${ip}:$port/   <- what a QR code should point at" }
}
Write-Host ''
Write-Host '    Logs:     docker compose logs -f'
Write-Host '    Stop:     docker compose down'
Write-Host '    Restart:  double-click setup.bat again'
Write-Host ''
Warn 'Audio needs Linux. On Windows the pages all work, but nothing will play.'
