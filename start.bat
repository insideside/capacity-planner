@echo off
rem Capacity Planner - start (Windows). Real work is done by start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
exit /b %ERRORLEVEL%
