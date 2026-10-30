@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install Node.js and reopen this terminal.
  exit /b 2
)
node "%~dp0scripts\verify.mjs" %*
exit /b %errorlevel%
