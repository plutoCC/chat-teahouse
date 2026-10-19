# Configure only this server process. Never change Windows proxy settings or TLS.
# Dot-source before starting Node (Node >= 24).
function Get-TeaLoopbackProxy([string]$ProxyServer) {
  $teaCandidate = $ProxyServer.Trim()
  if ($teaCandidate.Contains('=')) {
    $teaEntry = @($teaCandidate -split ';' | Where-Object { $_.Trim() -match '^https=' })
    if ($teaEntry.Count -ne 1) { return $null }
    $teaCandidate = ($teaEntry[0].Trim() -replace '^https=', '').Trim()
  }
  if ($teaCandidate -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $teaCandidate = 'http://' + $teaCandidate }
  $teaUri = $null
  if (-not [Uri]::TryCreate($teaCandidate, [UriKind]::Absolute, [ref]$teaUri)) { return $null }
  if ($teaUri.Scheme -notin @('http', 'https') -or $teaUri.UserInfo -or $teaUri.Query -or $teaUri.Fragment -or $teaUri.AbsolutePath -ne '/' -or $teaUri.Port -lt 1) { return $null }
  $teaAddress = $null
  if ($teaUri.Host -eq 'localhost') { $teaProxyHost = 'localhost' }
  elseif ([Net.IPAddress]::TryParse($teaUri.DnsSafeHost, [ref]$teaAddress) -and [Net.IPAddress]::IsLoopback($teaAddress)) {
    $teaProxyHost = if ($teaAddress.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) { '[::1]' } else { $teaAddress.ToString() }
  } else { return $null }
  return $teaUri.Scheme + '://' + $teaProxyHost + ':' + $teaUri.Port
}

function Initialize-TeaNetwork {
  # Explicit process/user proxy variables take priority. Auto-import only an
  # already enabled loopback Windows proxy, without credentials or PAC scripts.
  if (-not $env:HTTPS_PROXY -and -not $env:HTTP_PROXY -and $env:CHAT_TEA_USE_SYSTEM_PROXY -ne '0') {
    try {
      $teaSettings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
      if ($teaSettings.ProxyEnable -eq 1 -and $teaSettings.ProxyServer) {
        $teaProxy = Get-TeaLoopbackProxy ([string]$teaSettings.ProxyServer)
        if ($teaProxy) { $env:HTTPS_PROXY = $teaProxy }
      }
    } catch { Write-Warning 'Could not read the existing Windows proxy. Using explicit environment settings only.' }
  }
  # Keep local APIs and Ollama off any upstream proxy, even with custom NO_PROXY.
  $teaExclusions = @($env:NO_PROXY -split ',' | Where-Object { $_ }) + @('localhost', '127.0.0.1', '::1', '[::1]')
  $env:NO_PROXY = ($teaExclusions | Select-Object -Unique) -join ','
  $env:NODE_USE_ENV_PROXY = '1'
}
