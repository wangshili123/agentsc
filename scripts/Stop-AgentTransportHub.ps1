$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PidFile = Join-Path $Root '.runtime\hub.pid'
$Entry = Join-Path $Root 'apps\hub\dist\index.js'
$Listener = Get-NetTCPConnection -State Listen -LocalPort 47420 -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not (Test-Path $PidFile) -and $null -eq $Listener) {
  Write-Output 'hub not running'
  exit 0
}
$HubPid = if (Test-Path $PidFile) { [int](Get-Content -Raw $PidFile) } else { [int]$Listener.OwningProcess }
$Process = Get-CimInstance Win32_Process -Filter "ProcessId=$HubPid" -ErrorAction SilentlyContinue
if ($null -eq $Process) {
  Remove-Item -Force $PidFile -ErrorAction SilentlyContinue
  Write-Output 'stale pid removed'
  exit 0
}
if ($Process.CommandLine -notlike "*$Entry*") {
  throw "PID $HubPid does not belong to this Hub"
}
Stop-Process -Id $HubPid -Force
Remove-Item -Force $PidFile -ErrorAction SilentlyContinue
Write-Output "hub stopped pid=$HubPid"
