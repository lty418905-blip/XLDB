@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup.ps1" -Mode Tavern -OpenTavern %*
if errorlevel 1 pause
