param([switch]$RestartProxy)

$ErrorActionPreference = 'Stop'
$destination = Join-Path $env:USERPROFILE '.cli-proxy-api\dashboard'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$files = @(Get-Item -LiteralPath (Join-Path $PSScriptRoot 'index.html')) + @(Get-Item -LiteralPath (Join-Path $PSScriptRoot 'management-quota-bridge.js')) + @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.cjs' | Where-Object { $_.Name -notlike '*.test.cjs' })
$files += @('management-quota-ledger.js', 'management-quota-ledger.css', 'management-polish.js', 'management-polish.css') | ForEach-Object { Get-Item -LiteralPath (Join-Path $PSScriptRoot $_) }
$backup = Join-Path $env:USERPROFILE ('.cli-proxy-api\backups\ledger-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($file in $files) {
    $installed = Join-Path $destination $file.Name
    if (Test-Path -LiteralPath $installed) { Copy-Item -LiteralPath $installed -Destination $backup }

    Copy-Item -LiteralPath $file.FullName -Destination $destination
}
$helper = Join-Path $env:USERPROFILE '.cli-proxy-api\cliproxy.ps1'
if ($RestartProxy) {
    & $helper restart
} else {
    $serverScript = Join-Path $destination 'server.cjs'
    $running = @(Get-CimInstance Win32_Process -Filter "name = 'node.exe'" | Where-Object { $_.CommandLine -like ('*' + $serverScript + '*') })
    foreach ($process in $running) { Stop-Process -Id $process.ProcessId }
    & $helper start
}
