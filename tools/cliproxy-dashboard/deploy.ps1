param([switch]$RestartProxy)

$ErrorActionPreference = 'Stop'
& node.exe (Join-Path $PSScriptRoot 'configure-codex-transport.cjs')
if ($LASTEXITCODE -ne 0) { throw 'The Codex CLIProxy transport could not be configured.' }
$destination = Join-Path $env:USERPROFILE '.cli-proxy-api\dashboard'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$files = @(Get-Item -LiteralPath (Join-Path $PSScriptRoot 'index.html')) + @(Get-Item -LiteralPath (Join-Path $PSScriptRoot 'management-quota-bridge.js')) + @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.cjs' | Where-Object { $_.Name -notlike '*.test.cjs' })
foreach ($file in $files) {
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
