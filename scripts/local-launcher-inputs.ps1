#requires -Version 7.0
param([Parameter(Mandatory)][string]$McpConfig)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($McpConfig) -or -not (Test-Path -LiteralPath $McpConfig -PathType Leaf) -or
    (Get-Item -LiteralPath $McpConfig -Force).LinkType) {
    throw 'MCP configuration must be an existing absolute non-linked file.'
}
try { $inputSettings = [IO.File]::ReadAllText($McpConfig) | ConvertFrom-Json -AsHashtable }
catch { throw 'MCP configuration must be valid JSON.' }
if ($inputSettings -isnot [Collections.IDictionary]) { throw 'MCP configuration must be a JSON object.' }
foreach ($key in @('clientSecretFile','signingKeyFile','encryptionKeyFile')) {
    if ($inputSettings.Contains($key)) {
        $path = $inputSettings[$key]
        if ($path -isnot [string] -or -not [IO.Path]::IsPathRooted($path) -or $path -match '[\r\n,]') {
            throw 'MCP secret input paths must be absolute, without newlines or commas.'
        }
        Write-Output $path
    }
}
