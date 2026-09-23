#requires -Version 7.0
[CmdletBinding(PositionalBinding=$false)]
param(
    [Parameter(Position=0)]
    [Alias('Action')]
    [ValidateSet('start','stop','edit-config')]
    [string]$Command = 'start',
    [string]$Project = 'agent-control',
    [Alias('db-reset')]
    [switch]$DbReset
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/local-deployment.ps1')
$context = $null
try {
    if ($DbReset -and $Command -ne 'start') { throw '-DbReset is supported only with start.' }
    $context = New-LocalContext -Root $PSScriptRoot -Project $Project
    $operation = switch ($Command) {
        'start' { 'Deploy' }
        'stop' { 'Stop' }
        'edit-config' { 'EditConfig' }
    }
    Invoke-LocalDeployment -Context $context -Action $operation -DbReset:$DbReset
} catch {
    $resetStatus = if ($context -and $context.DbResetStarted) {
        'The explicit database reset began; data may already have been deleted. Reset and migration failures leave the app in maintenance.'
    } else { 'The application database was not reset.' }
    Write-Error "Local operation failed: $($_.Exception.Message) Review the failed phase above. $resetStatus"
    exit 1
}