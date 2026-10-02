$ErrorActionPreference = 'Stop'
$destination = Join-Path $env:USERPROFILE '.cli-proxy-api\dashboard'
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$files = @(Get-Item -LiteralPath (Join-Path $PSScriptRoot 'index.html')) + @(Get-Item -LiteralPath (Join-Path $PSScriptRoot 'management-quota-bridge.js')) + @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.cjs' | Where-Object { $_.Name -notlike '*.test.cjs' })
foreach ($file in $files) {
    Copy-Item -LiteralPath $file.FullName -Destination $destination
}
& (Join-Path $env:USERPROFILE '.cli-proxy-api\cliproxy.ps1') restart
