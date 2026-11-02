param(
  [ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Start',
  [string]$Origin,
  [string]$DataDir,
  [ValidateRange(1024, 65535)][int]$AdminPort = 4318,
  [ValidateRange(1024, 65535)][int]$GatewayPort = 4319,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$teaRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$teaLaunchDir = Join-Path $teaRoot 'data-hosted'
$teaConfigPath = Join-Path $teaLaunchDir 'hosting-launch.json'
$teaRuntime = Join-Path $teaLaunchDir 'runtime'
$teaStatePath = Join-Path $teaRuntime 'hosting-launch-process.json'
$teaEntry = Join-Path $teaRoot 'server/hosting/index.ts'
$teaArguments = '--import tsx "' + $teaEntry + '"'
$teaMutex = $null; $teaLockHeld = $false; $teaClient = $null; $teaHandler = $null
$teaPreviousEnv = @{}
# These launch values seed a new installation. The running host reads hosting-settings.json
# for live, versioned product limits saved by the local sharing manager; never overwrite it here.
$teaLimitVariables = [ordered]@{
  dailyCny = 'DAILY_CNY'; userDailyCny = 'USER_DAILY_CNY'; monthlyCny = 'MONTHLY_CNY'; exchangeRate = 'USD_CNY'
  dailyCalls = 'DAILY_CALLS'; userDailyCalls = 'USER_DAILY_CALLS'; concurrency = 'CONCURRENCY'
  userConcurrency = 'USER_CONCURRENCY'; maxOutputTokens = 'MAX_OUTPUT_TOKENS'
}

function Read-HostedJson([string]$Path) {
  try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) }
  catch { throw ('Invalid hosting JSON file: ' + $Path) }
}
function Write-HostedJson([string]$Path, $Value, [switch]$CreateOnly) {
  $teaBytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 6) + "`n")
  if ($CreateOnly) {
    $teaFile = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $teaFile.Write($teaBytes, 0, $teaBytes.Length) } finally { $teaFile.Dispose() }
  } else {
    $teaTemporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try { [IO.File]::WriteAllBytes($teaTemporary, $teaBytes); Move-Item -LiteralPath $teaTemporary -Destination $Path -Force }
    finally { if (Test-Path -LiteralPath $teaTemporary) { Remove-Item -LiteralPath $teaTemporary } }
  }
}
function Test-HostedContains([string]$Parent, [string]$Child) {
  return ($Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or $Child.StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))
}
function Assert-HostedDirectory([string]$Path) {
  $teaPersonal = if ($env:CHAT_TEA_DATA_DIR) { [IO.Path]::GetFullPath($env:CHAT_TEA_DATA_DIR) } else { Join-Path $teaRoot 'data' }
  if ((Test-HostedContains $Path $teaRoot) -or (Test-HostedContains $Path $teaPersonal) -or (Test-HostedContains $teaPersonal $Path)) {
    throw 'Hosted data must be in a dedicated directory separate from the personal workspace.'
  }
  for ($teaCursor = $Path; $teaCursor; $teaCursor = Split-Path -Parent $teaCursor) {
    if ((Test-Path -LiteralPath $teaCursor) -and ((Get-Item -LiteralPath $teaCursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Hosted data and launch directories must not use symbolic links or junctions.'
    }
    if ($teaCursor -eq [IO.Path]::GetPathRoot($teaCursor)) { break }
  }
  if (Test-Path -LiteralPath (Join-Path $Path 'teahouse.sqlite')) { throw 'A personal database cannot be used as the hosted data root.' }
}
function Set-HostedEnv([string]$Name, [string]$Value) {
  if (-not $teaPreviousEnv.ContainsKey($Name)) { $teaPreviousEnv[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process') }
  [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}
function Get-HostedHealth {
  try {
    $teaResponse = $teaClient.GetAsync('http://127.0.0.1:' + $AdminPort + '/api/health').GetAwaiter().GetResult()
    try {
      if (-not $teaResponse.IsSuccessStatusCode) { return $null }
      return ($teaResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json)
    } finally { $teaResponse.Dispose() }
  } catch { return $null }
}
function Test-HostedHealth($Health) { return ($Health -and $Health.ok -eq $true -and $Health.application -eq 'chat-teahouse') }
function Get-HostedListeners {
  # Query by local port instead of scanning or stopping unrelated Node processes.
  return @(Get-NetTCPConnection -State Listen -LocalPort @($AdminPort, $GatewayPort) -ErrorAction SilentlyContinue)
}
function Get-HostedLockPid {
  if (-not (Test-Path -LiteralPath $teaProcessLock)) { return $null }
  $teaPidText = (Get-Content -LiteralPath $teaProcessLock -Raw).Trim()
  $teaLockedPid = 0
  if ($teaPidText -notmatch '^[1-9][0-9]*$' -or -not [int]::TryParse($teaPidText, [ref]$teaLockedPid)) { throw 'Invalid hosted process lock. Check the service before changing it.' }
  return $teaLockedPid
}
function Get-HostedProcess {
  $teaLockedPid = Get-HostedLockPid
  if (-not (Test-Path -LiteralPath $teaStatePath)) {
    if ($teaLockedPid -and (Get-Process -Id $teaLockedPid -ErrorAction SilentlyContinue)) { throw 'A hosted process is already using this directory but was not started by this launcher. Manage it from its original terminal.' }
    return $null
  }
  $teaState = Read-HostedJson $teaStatePath
  if (-not $teaState.processId -or -not $teaState.startTimeUtcTicks -or -not $teaState.nodePath -or $teaState.scriptPath -ne $teaEntry -or $teaState.dataDir -ne $teaData) { throw 'Hosting process state does not match this workspace. Refusing to control it.' }
  $teaProcess = Get-Process -Id ([int]$teaState.processId) -ErrorAction SilentlyContinue
  if (-not $teaProcess) {
    if ($teaLockedPid -and (Get-Process -Id $teaLockedPid -ErrorAction SilentlyContinue)) { throw 'Another process owns the hosted lock. Refusing to control it.' }
    return $null
  }
  try {
    # Pin a process handle before inspecting its creation time, so PID reuse cannot redirect Stop.
    $null = $teaProcess.Handle
    $teaDetails = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $teaProcess.Id)
    $teaCommandPattern = '^"?' + [regex]::Escape([string]$teaState.nodePath) + '"?\s+' + [regex]::Escape($teaArguments) + '\s*$'
    if ($teaProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$teaState.startTimeUtcTicks -or
        $teaDetails.ExecutablePath -ne $teaState.nodePath -or $teaDetails.CommandLine -notmatch $teaCommandPattern -or
        $teaLockedPid -ne $teaProcess.Id) { throw 'Hosting process identity or lock does not match. Refusing to control another process.' }
    return $teaProcess
  } catch { $teaProcess.Dispose(); throw }
}
function Test-HostedReady($Process) {
  if (-not $Process -or -not (Test-HostedHealth (Get-HostedHealth))) { return $false }
  $teaListeners = @(Get-HostedListeners)
  return ($teaListeners.Count -eq 2 -and @($teaListeners | Where-Object { $_.OwningProcess -ne $Process.Id -or $_.LocalAddress -ne '127.0.0.1' }).Count -eq 0)
}

try {
  Set-Location -LiteralPath $teaRoot
  Assert-HostedDirectory $teaLaunchDir
  $teaHash = [Security.Cryptography.SHA256]::Create()
  try { $teaMutexName = [BitConverter]::ToString($teaHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($teaRoot.ToLowerInvariant()))).Replace('-', '') }
  finally { $teaHash.Dispose() }
  $teaMutex = New-Object Threading.Mutex($false, ('Local\ChatTeahouseHosted-' + $teaMutexName))
  try { $teaLockHeld = $teaMutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $teaLockHeld = $true }
  if (-not $teaLockHeld) { throw 'Another hosting command is still running. Try again after it finishes.' }

  $teaNewConfig = -not (Test-Path -LiteralPath $teaConfigPath)
  if ($teaNewConfig) {
    if ($Action -ne 'Start') { Write-Host 'Hosted service is not configured.'; if ($Action -eq 'Status') { exit 1 }; exit 0 }
    if (-not $Origin) { throw 'First startup requires -Origin https://your-dedicated-hostname (without a trailing slash).' }
    $teaData = if ($DataDir) { [IO.Path]::GetFullPath($DataDir) } else { $teaLaunchDir }
    $teaLimits = [ordered]@{ dailyCny = 20; userDailyCny = 5; monthlyCny = 300; exchangeRate = 7; dailyCalls = 200; userDailyCalls = 50; concurrency = 4; userConcurrency = 2; maxOutputTokens = 16384 }
    foreach ($teaKey in $teaLimitVariables.Keys) {
      $teaValue = [Environment]::GetEnvironmentVariable(('CHAT_TEA_HOST_' + $teaLimitVariables[$teaKey]), 'Process')
      if ($null -ne $teaValue) { $teaLimits[$teaKey] = [double]::Parse($teaValue, [Globalization.CultureInfo]::InvariantCulture) }
    }
    $teaConfig = [pscustomobject]@{ publicOrigin = $Origin; dataDir = $teaData; adminPort = $AdminPort; gatewayPort = $GatewayPort; limits = [pscustomobject]$teaLimits }
  } else {
    $teaConfig = Read-HostedJson $teaConfigPath
    foreach ($teaPair in @(@('Origin', 'publicOrigin'), @('DataDir', 'dataDir'), @('AdminPort', 'adminPort'), @('GatewayPort', 'gatewayPort'))) {
      if ($PSBoundParameters.ContainsKey($teaPair[0]) -and $PSBoundParameters[$teaPair[0]] -ne $teaConfig.($teaPair[1])) { throw ('Saved ' + $teaPair[1] + ' differs. Stop the website and deliberately edit ' + $teaConfigPath + ' before restarting.') }
    }
    $Origin = [string]$teaConfig.publicOrigin; $teaData = [string]$teaConfig.dataDir
    $AdminPort = [int]$teaConfig.adminPort; $GatewayPort = [int]$teaConfig.gatewayPort
  }
  $teaUri = $null
  if (-not [Uri]::TryCreate($Origin, [UriKind]::Absolute, [ref]$teaUri) -or $teaUri.Scheme -cne 'https' -or $teaUri.UserInfo -or $teaUri.IsLoopback -or $teaUri.GetLeftPart([UriPartial]::Authority) -cne $Origin) { throw 'Origin must be a canonical public HTTPS origin with no path, credentials, query, or trailing slash.' }
  if ($AdminPort -lt 1024 -or $AdminPort -gt 65535 -or $GatewayPort -lt 1024 -or $GatewayPort -gt 65535 -or $AdminPort -eq $GatewayPort -or $AdminPort -eq 4317 -or $GatewayPort -eq 4317) { throw 'Use distinct hosting ports between 1024 and 65535; port 4317 is reserved for the personal service.' }
  if (-not $teaData -or -not [IO.Path]::IsPathRooted($teaData) -or [IO.Path]::GetFullPath($teaData) -ne $teaData) { throw 'The saved hosted data directory must be an absolute, normalized path.' }
  Assert-HostedDirectory $teaData
  foreach ($teaKey in $teaLimitVariables.Keys) {
    $teaValue = $teaConfig.limits.$teaKey
    if ($teaValue -isnot [ValueType] -or [double]::IsNaN([double]$teaValue) -or $teaValue -le 0 -or $teaValue -gt 10000000 -or ($teaKey -in @('dailyCalls', 'userDailyCalls', 'concurrency', 'userConcurrency', 'maxOutputTokens') -and [Math]::Floor($teaValue) -ne $teaValue)) { throw ('Invalid hosted limit: ' + $teaKey) }
  }
  $teaProcessLock = Join-Path $teaData 'hosting-process.lock'
  Add-Type -AssemblyName System.Net.Http
  $teaHandler = New-Object Net.Http.HttpClientHandler; $teaHandler.UseProxy = $false
  $teaClient = New-Object Net.Http.HttpClient($teaHandler); $teaClient.Timeout = [TimeSpan]::FromSeconds(2)
  $teaExisting = Get-HostedProcess
  try {
    if ($Action -eq 'Status') {
      if (Test-HostedReady $teaExisting) { Write-Host ('Running: ' + $Origin + ' | local admin http://127.0.0.1:' + $AdminPort + ' | gateway http://127.0.0.1:' + $GatewayPort); exit 0 }
      if ($teaExisting) { throw 'The hosted process exists but is not healthy on both configured loopback ports. Check data-hosted/service-logs.' }
      Write-Host 'Hosted service is stopped.'; exit 1
    }
    if ($Action -eq 'Stop') {
      if (-not $teaExisting) { Write-Host 'Hosted service is already stopped.'; exit 0 }
      Write-Warning 'Stopping the hosted process interrupts active requests. Saved website data and quota reservations are retained.'
      # Windows cannot deliver Node SIGTERM gracefully. Kill only the pinned, fully verified process.
      $teaExisting.Kill()
      if (-not $teaExisting.WaitForExit(10000)) { throw 'The verified hosted process has not exited. Check it before restarting.' }
      if ((Get-HostedLockPid) -eq $teaExisting.Id) { Remove-Item -LiteralPath $teaProcessLock }
      Remove-Item -LiteralPath $teaStatePath
      Write-Host 'Hosted service stopped. Website data is retained.'; exit 0
    }
    if ($teaExisting) {
      if (-not (Test-HostedReady $teaExisting)) { throw 'An existing hosted process is unhealthy. Inspect its logs before stopping or restarting it.' }
      Write-Host ('Already running: ' + $Origin + ' | local admin http://127.0.0.1:' + $AdminPort); exit 0
    }
  } finally { if ($teaExisting) { $teaExisting.Dispose() } }
  if (@(Get-HostedListeners).Count) { throw 'A configured hosting port is already occupied. No process was stopped.' }
  $teaNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $teaNodeCommand) { throw 'Install Node.js 24 or newer before starting the hosted service.' }
  $teaNode = $teaNodeCommand.Source
  $teaMajor = & $teaNode -p 'parseInt(process.versions.node)'
  if ($LASTEXITCODE -ne 0 -or [int]$teaMajor -lt 24) { throw 'Node.js 24 or newer is required.' }
  if (-not (Test-Path -LiteralPath (Join-Path $teaRoot 'node_modules/tsx/package.json'))) { throw 'Dependencies are missing. Run npm.cmd ci before launching.' }
  if (-not $SkipBuild) { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'Build failed. Hosted service was not started.' } }
  if (-not (Test-Path -LiteralPath (Join-Path $teaRoot 'dist/index.html'))) { throw 'Missing production build. Run npm.cmd run build first.' }
  foreach ($teaPath in @($teaNode, $teaEntry, $teaData)) { if ($teaPath.Contains('"')) { throw 'A launch path contains an invalid quote.' } }
  New-Item -ItemType Directory -Path $teaRuntime -Force | Out-Null
  if ($teaNewConfig) { Write-HostedJson $teaConfigPath $teaConfig -CreateOnly }
  $teaLogs = Join-Path $teaLaunchDir 'service-logs'; New-Item -ItemType Directory -Path $teaLogs -Force | Out-Null
  Set-HostedEnv 'CHAT_TEA_PUBLIC_ORIGIN' $Origin
  Set-HostedEnv 'CHAT_TEA_HOST_DATA_DIR' $teaData
  Set-HostedEnv 'CHAT_TEA_ADMIN_PORT' ([string]$AdminPort)
  Set-HostedEnv 'CHAT_TEA_HOST_PORT' ([string]$GatewayPort)
  foreach ($teaKey in $teaLimitVariables.Keys) { Set-HostedEnv ('CHAT_TEA_HOST_' + $teaLimitVariables[$teaKey]) ([Convert]::ToString($teaConfig.limits.$teaKey, [Globalization.CultureInfo]::InvariantCulture)) }
  foreach ($teaName in @('HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY')) { $teaPreviousEnv[$teaName] = [Environment]::GetEnvironmentVariable($teaName, 'Process') }
  . (Join-Path $PSScriptRoot 'network-env.ps1'); Initialize-TeaNetwork
  $teaStamp = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $teaStarted = Start-Process -FilePath $teaNode -ArgumentList $teaArguments -WorkingDirectory $teaRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $teaLogs ($teaStamp + '.stdout.log')) -RedirectStandardError (Join-Path $teaLogs ($teaStamp + '.stderr.log')) -PassThru
  try {
    Write-HostedJson $teaStatePath ([pscustomobject]@{ processId = $teaStarted.Id; startTimeUtcTicks = $teaStarted.StartTime.ToUniversalTime().Ticks.ToString(); nodePath = $teaNode; scriptPath = $teaEntry; dataDir = $teaData })
    $teaDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
      if ($teaStarted.HasExited) { throw ('Hosted service exited during startup. Check ' + $teaLogs) }
      if (Test-HostedReady $teaStarted) {
        $teaVerified = Get-HostedProcess; if ($teaVerified) { $teaVerified.Dispose() }
        Write-Host ('Running independently: ' + $Origin + ' | local admin http://127.0.0.1:' + $AdminPort + ' | gateway http://127.0.0.1:' + $GatewayPort)
        Write-Host 'Use this script with -Action Status or -Action Stop. The HTTPS tunnel is managed separately.'
        exit 0
      }
      Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $teaDeadline)
    throw ('Hosted service did not become healthy. Check ' + $teaLogs + ' before retrying.')
  } finally { $teaStarted.Dispose() }
} finally {
  foreach ($teaName in $teaPreviousEnv.Keys) { [Environment]::SetEnvironmentVariable($teaName, $teaPreviousEnv[$teaName], 'Process') }
  if ($teaClient) { $teaClient.Dispose() }; if ($teaHandler) { $teaHandler.Dispose() }
  if ($teaLockHeld) { $teaMutex.ReleaseMutex() }; if ($teaMutex) { $teaMutex.Dispose() }
}
