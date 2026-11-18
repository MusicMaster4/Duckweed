param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [string]$GoExecutable = 'go.exe',
    [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $SourcePath).Path
$patchPaths = @('codex-response-interrupt.patch', 'codex-websocket-fallback.patch', 'codex-tool-audio-fallback.patch', 'codex-startup-models.patch') | ForEach-Object { Join-Path $PSScriptRoot $_ }
$expectedCommit = '6fecc6e5567912661654a4eaf9b8f5436facd1c2'
$commit = & git -C $sourceRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $commit -ne $expectedCommit) { throw 'This patch requires the tested CLIProxyAPI source commit.' }
foreach ($patchPath in $patchPaths) {
    $ErrorActionPreference = 'Continue'
    & git -C $sourceRoot apply --check $patchPath 2>$null
    $applyCheck = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($applyCheck -eq 0) {
        & git -C $sourceRoot apply $patchPath
        if ($LASTEXITCODE -ne 0) { throw 'Could not apply the Codex compatibility patch.' }
    } else {
        & git -C $sourceRoot apply --reverse --check $patchPath
        if ($LASTEXITCODE -ne 0) { throw 'The source differs from the tested patch.' }
    }
}
$gofmt = Join-Path (Split-Path (Get-Command $GoExecutable).Source -Parent) 'gofmt.exe'
& $gofmt -w (Join-Path $sourceRoot 'internal/runtime/executor/codex_websockets_duplex.go') (Join-Path $sourceRoot 'sdk/api/handlers/openai/openai_responses_interrupt_integration_test.go') (Join-Path $sourceRoot 'sdk/api/handlers/openai/openai_responses_websocket_forward.go') (Join-Path $sourceRoot 'sdk/api/handlers/openai/openai_responses_websocket.go') (Join-Path $sourceRoot 'sdk/api/handlers/openai/openai_responses_fallback_test.go')
if ($LASTEXITCODE -ne 0) { throw 'Go formatting failed.' }
& $GoExecutable -C $sourceRoot test -p 4 -run 'TestResponsesInterruptFullDuplexIntegration|TestResponsesSteering|TestResponsesWebsocketPreservesErrorAfterDataClose|TestResponsesWebsocketTooBigFullDuplexIntegration|TestResponsesWebsocketNativeHTTPPolicyHandshake|TestResponsesWebsocketHTTPPolicyRecognizesAppServerMetadata|TestForwardResponsesWebsocket|TestCodexDuplex|TestCodexHTTPToolAudioFallback|TestCodexToolAudioFallbackKeepsToolResultShape' ./sdk/api/handlers/openai ./internal/runtime/executor -count=1
if ($LASTEXITCODE -ne 0) { throw 'The Codex compatibility regression checks failed.' }
& $GoExecutable -C $sourceRoot test -p 4 -run 'TestCodex62RoutesBeforeCatalogRefresh|TestRegisterModelsForAuthCodex' ./sdk/cliproxy -count=1
if ($LASTEXITCODE -ne 0) { throw 'The Codex startup catalog regression checks failed.' }
$outputFile = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path (Split-Path $outputFile -Parent) -Force | Out-Null
& $GoExecutable -C $sourceRoot build -p 4 -trimpath -ldflags '-s -w -X main.Version=8.0.10-duckweed-interrupt.4' -o $outputFile ./cmd/server
if ($LASTEXITCODE -ne 0) { throw 'The patched proxy did not compile.' }
@{
    sourceCommit = $commit
    patchSha256 = (Get-FileHash -LiteralPath $patchPaths[0] -Algorithm SHA256).Hash
    fallbackPatchSha256 = (Get-FileHash -LiteralPath $patchPaths[1] -Algorithm SHA256).Hash
    toolAudioPatchSha256 = (Get-FileHash -LiteralPath $patchPaths[2] -Algorithm SHA256).Hash
    supportsHTTPToolAudioFallback = $true
    startupModelsPatchSha256 = (Get-FileHash -LiteralPath $patchPaths[3] -Algorithm SHA256).Hash
    supportsCodex62AtStartup = $true
    preservesWebsocketFallback = $true
    supportsNativeHttpFallback = $true
    binarySha256 = (Get-FileHash -LiteralPath $outputFile -Algorithm SHA256).Hash
    supportsResponseInterrupt = $true
} | ConvertTo-Json | Set-Content -LiteralPath ($outputFile + '.compatibility.json') -Encoding UTF8
Write-Output ('Patched proxy and regression checks completed: ' + $outputFile)
