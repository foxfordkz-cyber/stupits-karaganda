@echo off
node "%~dp0scripts\verify-team.mjs" %*
exit /b %errorlevel%
