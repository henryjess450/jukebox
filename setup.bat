@echo off
REM Double-click me.
REM
REM A thin wrapper: the real work is in scripts\setup.ps1. Batch cannot prompt
REM for a password without echoing it, and its quoting rules mangle the $ signs
REM in a bcrypt hash, so PowerShell does the work and this just launches it
REM past the execution policy that blocks local scripts by default.

title Jukebox setup
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*

echo.
echo Press any key to close this window.
pause >nul
