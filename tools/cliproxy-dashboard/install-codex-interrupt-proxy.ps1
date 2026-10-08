param([Parameter(Mandatory = $true)][string]$PatchedBinary)
$ErrorActionPreference = 'Stop'
$binary = (Resolve-Path -LiteralPath $PatchedBinary).Path
$manifest = Get-Content -LiteralPath ($binary + '.compatibility.json') -Raw | ConvertFrom-Json
if (-not $manifest.supportsResponseInterrupt -or (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $manifest.binarySha256 -or (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'codex-response-interrupt.patch') -Algorithm SHA256).Hash -ne $manifest.patchSha256) {
    throw 'The supplied proxy does not match the verified compatibility build.'
}
$proxyRoot = Join-Path $env:USERPROFILE '.cli-proxy-api'
$target = Join-Path $env:LOCALAPPDATA 'Programs/CLIProxyAPI/cli-proxy-api.exe'
$config = Join-Path $proxyRoot 'config.yaml'
$backup = Join-Path $proxyRoot ('backups/response-interrupt-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
Copy-Item -LiteralPath $target -Destination (Join-Path $backup 'cli-proxy-api.exe')
Copy-Item -LiteralPath $config -Destination (Join-Path $backup 'config.yaml')
$nextConfig = Join-Path $backup 'config.patched.yaml'
# Keep credentials in their existing local files and never print their contents.
$prepareConfig = @'
from pathlib import Path
import sys, yaml
source, destination = map(Path, sys.argv[1:])
config = yaml.safe_load(source.read_text(encoding='utf-8-sig'))
config.setdefault('oauth', {}).setdefault('providers', {}).setdefault('codex', {})['response-steering'] = True
destination.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding='utf-8')
'@
& python -c $prepareConfig $config $nextConfig
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the proxy WebSocket configuration.' }
$running = @(Get-CimInstance Win32_Process -Filter "name = 'cli-proxy-api.exe'" | Where-Object { $_.ExecutablePath -eq $target -and $_.CommandLine -like ('*' + $config + '*') })
function Start-ConfiguredProxy {
    Start-Process -FilePath $target -ArgumentList @('-config', ('"' + $config + '"')) -WorkingDirectory (Split-Path $target -Parent) -WindowStyle Hidden | Out-Null
}
try {
    foreach ($process in $running) {
        $nativeProcess = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        if ($nativeProcess) {
            Stop-Process -InputObject $nativeProcess
            if (-not $nativeProcess.WaitForExit(10000)) { throw 'The proxy did not stop before replacement.' }
            $nativeProcess.Dispose()
        }
    }
    Copy-Item -LiteralPath $binary -Destination $target -Force
    Copy-Item -LiteralPath $nextConfig -Destination $config -Force
    Start-ConfiguredProxy
    $key = (Get-Content -LiteralPath (Join-Path $proxyRoot '.api-key') -Raw).Trim()
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $models = Invoke-RestMethod 'http://127.0.0.1:8317/v1/models' -Headers @{ Authorization = 'Bearer ' + $key } -TimeoutSec 2
            if ($models.data) { $ready = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 200
    }
    if (-not $ready) { throw 'The patched proxy did not become ready.' }
    Copy-Item -LiteralPath ($binary + '.compatibility.json') -Destination (Join-Path $proxyRoot 'response-interrupt-compatibility.json')
} catch {
    $failed = @(Get-CimInstance Win32_Process -Filter "name = 'cli-proxy-api.exe'" | Where-Object { $_.ExecutablePath -eq $target -and $_.CommandLine -like ('*' + $config + '*') })
    foreach ($process in $failed) {
        $nativeProcess = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        if ($nativeProcess) {
            Stop-Process -InputObject $nativeProcess
            if (-not $nativeProcess.WaitForExit(10000)) { throw 'The proxy did not stop before replacement.' }
            $nativeProcess.Dispose()
        }
    }
    Copy-Item -LiteralPath (Join-Path $backup 'cli-proxy-api.exe') -Destination $target -Force
    Copy-Item -LiteralPath (Join-Path $backup 'config.yaml') -Destination $config -Force
    if ($running.Count -gt 0) { Start-ConfiguredProxy }
    throw
}
& node.exe (Join-Path $PSScriptRoot 'configure-codex-transport.cjs') --websocket
if ($LASTEXITCODE -ne 0) { throw 'The proxy is installed, but the Codex transport configuration could not be updated.' }
Write-Output ('Codex WebSocket interruption compatibility installed. Backup: ' + $backup)
