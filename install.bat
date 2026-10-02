@echo off
rem Capacity Planner - install from git (Windows). Real work is done by install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
exit /b %ERRORLEVEL%
