@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -File "%~dp0Start-Teahouse.ps1"
if errorlevel 1 (
  echo Teahouse could not start. Please review the message above.
  pause
  exit /b 1
)
exit /b 0
