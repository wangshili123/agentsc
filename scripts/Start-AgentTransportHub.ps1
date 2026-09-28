param([switch]$Foreground)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Runtime = Join-Path $Root '.runtime'
$PidFile = Join-Path $Runtime 'hub.pid'
$OutLog = Join-Path $Runtime 'hub.out.log'
$ErrLog = Join-Path $Runtime 'hub.err.log'
$Entry = Join-Path $Root 'apps\hub\dist\index.js'
New-Item -ItemType Directory -Force $Runtime | Out-Null
if (-not (Test-Path $Entry)) { throw "Hub is not built: $Entry" }
if (Test-Path $PidFile) {
  $OldPid = [int](Get-Content -Raw $PidFile)
  $Existing = Get-CimInstance Win32_Process -Filter "ProcessId=$OldPid" -ErrorAction SilentlyContinue
  if ($null -ne $Existing -and $Existing.CommandLine -like "*$Entry*") {
    Write-Output "hub already running pid=$OldPid"
    exit 0
  }
  Remove-Item -Force $PidFile
}
if ($Foreground) {
  Set-Location $Root
  & node $Entry
  exit $LASTEXITCODE
}
$Command = 'cmd.exe /d /s /c "node ' + $Entry + ' 1>>' + $OutLog + ' 2>>' + $ErrLog + '"'
$Created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $Command }
if ($Created.ReturnValue -ne 0) { throw "Hub process creation failed: $($Created.ReturnValue)" }
Set-Content -NoNewline -Encoding ASCII $PidFile ([string]$Created.ProcessId)
Start-Sleep -Milliseconds 700
$Existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($Created.ProcessId)" -ErrorAction SilentlyContinue
if ($null -eq $Existing) {
  $ErrorText = if (Test-Path $ErrLog) { Get-Content -Raw $ErrLog } else { 'no stderr' }
  Remove-Item -Force $PidFile -ErrorAction SilentlyContinue
  throw "Hub failed to start: $ErrorText"
}
Write-Output "hub started pid=$($Created.ProcessId)"
