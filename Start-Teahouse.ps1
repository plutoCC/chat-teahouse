param(
  [ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Start',
  [switch]$Foreground,
  [switch]$SkipBuild,
  [ValidateRange(1024, 65535)][int]$Port = 4317
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ($env:PORT -and -not $PSBoundParameters.ContainsKey('Port')) { $Port = [int]$env:PORT }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'PORT must be between 1024 and 65535.' }
Add-Type -AssemblyName System.Net.Http
$teaHandler = New-Object System.Net.Http.HttpClientHandler
$teaHandler.UseProxy = $false
$teaClient = New-Object System.Net.Http.HttpClient($teaHandler)
$teaClient.Timeout = [TimeSpan]::FromSeconds(3)
$teaUrl = 'http://127.0.0.1:' + $Port
$teaMutex = $null
$teaLockHeld = $false
function Read-TeaJson([string]$Path) {
  $response = $teaClient.GetAsync($teaUrl + $Path).GetAwaiter().GetResult()
  try { $response.EnsureSuccessStatusCode() | Out-Null; return ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json) }
  finally { $response.Dispose() }
}
function Get-TeaHealth {
  try { return (Read-TeaJson '/api/health') } catch { return $null }
}
function Test-TeaHealth($Health) {
  return ($Health -and $Health.ok -and ($Health.application -eq 'chat-teahouse' -or $Health.runtime -eq 'deepseek-harness'))
}
try {
  if ($Action -eq 'Start') {
    $teaMutex = New-Object System.Threading.Mutex($false, ('Local\ChatTeahouseLaunch-' + $Port))
    try { $teaLockHeld = $teaMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $teaLockHeld = $true }
    if (-not $teaLockHeld) { Write-Host 'Teahouse is already being started in another window.'; exit 0 }
  }
  $teaHealth = Get-TeaHealth
  if ($Action -eq 'Status') {
    if (Test-TeaHealth $teaHealth) { Write-Host ('Running: ' + $teaUrl + ' (v' + $teaHealth.version + ')'); exit 0 }
    Write-Host ('Not running: ' + $teaUrl); exit 1
  }
  if ($Action -eq 'Stop') {
    if (-not (Test-TeaHealth $teaHealth)) { Write-Host 'Teahouse is already stopped.'; exit 0 }
    $teaBoot = Read-TeaJson '/api/bootstrap'
    $teaRequest = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, ($teaUrl + '/api/service/stop'))
    $teaRequest.Headers.Add('Origin', $teaUrl)
    $teaRequest.Headers.Add('X-CSRF-Token', $teaBoot.csrfToken)
    $teaRequest.Content = New-Object System.Net.Http.StringContent('{}', [Text.Encoding]::UTF8, 'application/json')
    try {
      $teaResponse = $teaClient.SendAsync($teaRequest).GetAwaiter().GetResult()
      try { $teaResponse.EnsureSuccessStatusCode() | Out-Null } finally { $teaResponse.Dispose() }
    } finally { $teaRequest.Dispose() }
    for ($i = 0; $i -lt 40; $i++) {
      if (-not (Get-TeaHealth)) { Write-Host 'Teahouse stopped. Saved conversations are retained.'; exit 0 }
      Start-Sleep -Milliseconds 250
    }
    throw 'Shutdown was requested but has not completed. Check the service logs before restarting.'
  }
  if (Test-TeaHealth $teaHealth) { Write-Host ('Already running: ' + $teaUrl); exit 0 }
  if ($teaHealth) { throw 'The selected port belongs to another application.' }
  $teaProbe = New-Object System.Net.Sockets.TcpClient
  $teaPortBusy = $false
  try { $teaProbe.Connect('127.0.0.1', $Port); $teaPortBusy = $true } catch {} finally { $teaProbe.Dispose() }
  if ($teaPortBusy) { throw 'The port is in use but its health check failed. Refusing to start a second server.' }
  $teaNode = (Get-Command node -ErrorAction Stop).Source
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    & npm.cmd ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  }
  if (-not $SkipBuild) { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'Build failed.' } }
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'dist/index.html'))) { throw 'Missing build. Run without -SkipBuild first.' }
  $teaData = if ($env:CHAT_TEA_DATA_DIR) { [IO.Path]::GetFullPath($env:CHAT_TEA_DATA_DIR) } else { Join-Path $PSScriptRoot 'data' }
  if ($Foreground) {
    $env:PORT = [string]$Port; $env:CHAT_TEA_DATA_DIR = $teaData
    . (Join-Path $PSScriptRoot 'scripts/network-env.ps1')
    Initialize-TeaNetwork
    & $teaNode --import tsx server/index.ts --production
    exit $LASTEXITCODE
  }
  $teaHost = Join-Path $PSScriptRoot 'scripts/service-host.ps1'
  $teaShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  # Arguments go directly to Windows process creation, never through cmd.exe.
  foreach ($teaPath in @($teaShell, $teaHost, $teaNode, $teaData)) { if ($teaPath.Contains('"')) { throw 'A launch path contains an invalid quote.' } }
  $teaCommand = '"' + $teaShell + '" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $teaHost + '" -NodePath "' + $teaNode + '" -DataDir "' + $teaData.TrimEnd('\') + '" -Port ' + $Port
  $teaStartup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]16777216 }
  $teaCreated = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $teaCommand; CurrentDirectory = $PSScriptRoot; ProcessStartupInformation = $teaStartup }
  if ($teaCreated.ReturnValue -ne 0) { throw ('Windows could not launch the background host (code ' + $teaCreated.ReturnValue + '). Use -Foreground to diagnose.') }
  for ($i = 0; $i -lt 40; $i++) {
    $teaHealth = Get-TeaHealth
    if (Test-TeaHealth $teaHealth) { Write-Host ('Running independently in background: ' + $teaUrl); Write-Host 'Use Stop-Teahouse.cmd to stop the local server.'; exit 0 }
    Start-Sleep -Milliseconds 250
  }
  throw ('Server did not become ready. Check ' + (Join-Path $teaData 'service-logs') + ' or run with -Foreground.')
} finally {
  if ($teaLockHeld) { $teaMutex.ReleaseMutex() }
  if ($teaMutex) { $teaMutex.Dispose() }
  $teaClient.Dispose(); $teaHandler.Dispose()
}
