@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -File "%~dp0Start-Teahouse.ps1" -Action Stop
if errorlevel 1 (
  echo Teahouse could not stop. Please review the message above.
  pause
  exit /b 1
)
exit /b 0
