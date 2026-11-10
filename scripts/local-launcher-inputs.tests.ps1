#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
$repository = Split-Path $PSScriptRoot -Parent
$launcher = Join-Path $PSScriptRoot 'local-launcher-inputs.ps1'
$root = Join-Path $repository "artifacts/test-scratch/launcher-inputs-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($root) | Out-Null
$script:checks = 0
function Assert($Condition,[string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Fails([scriptblock]$Action,[string]$Pattern) {
    try { & $Action; throw 'Expected failure did not occur.' }
    catch { Assert ($_.Exception.Message -match $Pattern) "Unexpected failure: $($_.Exception.Message)" }
}
try {
    $config = Join-Path $root 'metadata.json'
    $settings = [IO.File]::ReadAllText((Join-Path $repository 'mcp/examples/local-settings.example.json')) | ConvertFrom-Json -AsHashtable
    Assert-LocalMcpSettings $settings 14391
    [IO.File]::WriteAllText($config,($settings | ConvertTo-Json -Depth 4))
    if (-not $IsWindows) {
        [IO.File]::SetUnixFileMode($config,[IO.UnixFileMode]420)
        Fails { Assert-LocalMcpSecretFile $config } '0600 permissions'
    }
    Assert (@(& $launcher -McpConfig $config).Count -eq 0) 'Metadata without explicit credential paths must not emit mounts or require secret-file permissions.'

    $settings.redirectUris = @(0..31 | ForEach-Object { 'https://client.example.test/' + ('a'*300) + $_ })
    Assert-LocalMcpSettings $settings 14391
    [IO.File]::WriteAllText($config,($settings | ConvertTo-Json -Depth 4))
    Assert ((Get-Item -LiteralPath $config).Length -gt 8192) 'The metadata fixture must exceed the credential-file limit.'
    Fails { Assert-LocalMcpSecretFile $config } '1-8192 bytes'
    Assert (@(& $launcher -McpConfig $config).Count -eq 0) 'Schema-valid metadata must not inherit the 8192-byte credential limit.'

    $expected = @('client input','signing input','encryption input') | ForEach-Object { Join-Path $root $_ }
    $settings.clientSecretFile = $expected[0]
    $settings.signingKeyFile = $expected[1]
    $settings.encryptionKeyFile = $expected[2]
    [IO.File]::WriteAllText($config,($settings | ConvertTo-Json -Depth 4))
    $paths = @(& $launcher -McpConfig $config)
    Assert ($paths.Count -eq 3 -and ($paths -join "`n") -ceq ($expected -join "`n")) 'Explicit paths must be emitted unchanged, before external credentials are mounted.'

    foreach ($value in @('relative-key',"${root}/line`nkey","${root}/line`rkey","${root}/comma,key",42,$null)) {
        $settings.clientSecretFile = $value
        [IO.File]::WriteAllText($config,($settings | ConvertTo-Json -Depth 4))
        Fails { & $launcher -McpConfig $config } 'absolute, without newlines or commas'
    }
    foreach ($json in @('null','[]','[{},{}]','"metadata"','42')) {
        [IO.File]::WriteAllText($config,$json)
        Fails { & $launcher -McpConfig $config } 'JSON object'
    }
    [IO.File]::WriteAllText($config,'{')
    Fails { & $launcher -McpConfig $config } 'valid JSON'
    Fails { & $launcher -McpConfig 'relative.json' } 'existing absolute non-linked'
    Fails { & $launcher -McpConfig (Join-Path $root 'absent.json') } 'existing absolute non-linked'
    Fails { & $launcher -McpConfig $root } 'existing absolute non-linked'
    if (-not $IsWindows) {
        $link = Join-Path $root 'linked.json'
        [IO.File]::CreateSymbolicLink($link,$config) | Out-Null
        Fails { & $launcher -McpConfig $link } 'existing absolute non-linked'
    }
    Write-Host "Passed $script:checks launcher input assertions (local metadata fixtures; no Docker or service calls)."
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}
