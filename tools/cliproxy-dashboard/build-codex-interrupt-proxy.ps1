param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [string]$GoExecutable = 'go.exe',
    [Parameter(Mandatory = $true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $SourcePath).Path
$patchPath = Join-Path $PSScriptRoot 'codex-response-interrupt.patch'
$expectedCommit = '6fecc6e5567912661654a4eaf9b8f5436facd1c2'
$commit = & git -C $sourceRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $commit -ne $expectedCommit) { throw 'This patch requires the tested CLIProxyAPI source commit.' }
$ErrorActionPreference = 'Continue'
& git -C $sourceRoot apply --check $patchPath 2>$null
$applyCheck = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($applyCheck -eq 0) {
    & git -C $sourceRoot apply $patchPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not apply the Codex interruption patch.' }
} else {
    & git -C $sourceRoot apply --reverse --check $patchPath
    if ($LASTEXITCODE -ne 0) { throw 'The source differs from the tested patch.' }
}
$gofmt = Join-Path (Split-Path (Get-Command $GoExecutable).Source -Parent) 'gofmt.exe'
& $gofmt -w (Join-Path $sourceRoot 'internal/runtime/executor/codex_websockets_duplex.go') (Join-Path $sourceRoot 'sdk/api/handlers/openai/openai_responses_interrupt_integration_test.go')
if ($LASTEXITCODE -ne 0) { throw 'Go formatting failed.' }
& $GoExecutable -C $sourceRoot test -p 4 -run 'TestResponsesInterruptFullDuplexIntegration|TestResponsesSteering|TestCodexDuplex' ./sdk/api/handlers/openai ./internal/runtime/executor -count=1
if ($LASTEXITCODE -ne 0) { throw 'The Codex WebSocket regression checks failed.' }
$outputFile = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path (Split-Path $outputFile -Parent) -Force | Out-Null
& $GoExecutable -C $sourceRoot build -p 4 -trimpath -ldflags '-s -w -X main.Version=8.0.10-duckweed-interrupt.1' -o $outputFile ./cmd/server
if ($LASTEXITCODE -ne 0) { throw 'The patched proxy did not compile.' }
@{
    sourceCommit = $commit
    patchSha256 = (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash
    binarySha256 = (Get-FileHash -LiteralPath $outputFile -Algorithm SHA256).Hash
    supportsResponseInterrupt = $true
} | ConvertTo-Json | Set-Content -LiteralPath ($outputFile + '.compatibility.json') -Encoding UTF8
Write-Output ('Patched proxy and regression checks completed: ' + $outputFile)
