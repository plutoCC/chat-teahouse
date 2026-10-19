param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [ValidateRange(1024, 65535)][int]$Port = 4317
)
$ErrorActionPreference = 'Stop'
$teaRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $teaRoot
$env:PORT = [string]$Port
$env:CHAT_TEA_DATA_DIR = $DataDir
$teaLogs = Join-Path $DataDir 'service-logs'
New-Item -ItemType Directory -Path $teaLogs -Force | Out-Null
$teaStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
try {
  . (Join-Path $PSScriptRoot 'network-env.ps1')
  Initialize-TeaNetwork
  # Windows creates this host independently of the temporary launching terminal.
  $teaServer = Start-Process -FilePath $NodePath -ArgumentList '--import','tsx','server/index.ts','--production' -WorkingDirectory $teaRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $teaLogs ($teaStamp + '.stdout.log')) -RedirectStandardError (Join-Path $teaLogs ($teaStamp + '.stderr.log')) -PassThru
  $teaServer.WaitForExit()
  [pscustomobject]@{ StoppedAt = (Get-Date).ToString('o'); ExitCode = $teaServer.ExitCode } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $teaLogs ($teaStamp + '.exit.json')) -Encoding UTF8
} catch {
  'The background host could not launch the local server. Check Node.js and project dependencies.' | Set-Content -LiteralPath (Join-Path $teaLogs ($teaStamp + '.host-error.txt')) -Encoding UTF8
  exit 1
}
