#requires -Version 7.0
[CmdletBinding(PositionalBinding=$false)]
param(
    [Parameter(Position=0)]
    [ValidateSet('start','stop','edit-config')]
    [string]$Command = 'start',
    [string]$Project = 'agent-control'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/local-deployment.ps1')
try {
    $context = New-LocalContext -Root $PSScriptRoot -Project $Project
    $operation = switch ($Command) {
        'start' { 'Deploy' }
        'stop' { 'Stop' }
        'edit-config' { 'EditConfig' }
    }
    Invoke-LocalDeployment -Context $context -Action $operation
} catch {
    Write-Error "Local operation failed: $($_.Exception.Message) Existing data has not been reset."
    exit 1
}