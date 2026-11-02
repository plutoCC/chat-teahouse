@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0scripts\sharing-manager.ps1" (
  echo Sharing manager is missing. Keep this launcher in the complete project folder.
  pause
  exit /b 1
)
start "" powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\sharing-manager.ps1"
exit /b 0
