@echo off
rem Capacity Planner - stop (Windows). Real work is done by stop.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
exit /b %ERRORLEVEL%
