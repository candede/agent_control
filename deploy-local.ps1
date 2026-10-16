#requires -Version 7.0
[CmdletBinding(PositionalBinding=$false)]
param(
    [Parameter(Position=0)]
    [ValidateSet('start','stop','edit-config','check')]
    [string]$Command = 'start',
    [string]$Project = 'agent-control',
    [switch]$DbReset,
    [switch]$ForceChecks,
    [switch]$AgentSharingDiagnostics,
    [string]$Candidate,
    [string]$CandidateSha256,
    [string]$ExpectedPreflight,
    [switch]$ReadOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/local-deployment.ps1')
$context = $null
try {
    if ($DbReset -and $Command -ne 'start') { throw '-DbReset is supported only with start.' }
    if ($ForceChecks -and $Command -ne 'start') { throw '-ForceChecks is supported only with start.' }
    if ($AgentSharingDiagnostics -and $Command -ne 'start') { throw '-AgentSharingDiagnostics is supported only with start.' }
    if (($Candidate -or $CandidateSha256 -or $ExpectedPreflight -or $ReadOnly) -and $Command -ne 'start') { throw 'Release parameters are supported only with start.' }
    $context = New-LocalContext -Root $PSScriptRoot -Project $Project -SkipSettings:($Command -in @('stop','check'))
    $context.AgentSharingDiagnostics = [bool]$AgentSharingDiagnostics
    $context.Candidate = $Candidate
    $context.CandidateSha256 = $CandidateSha256
    $context.ExpectedPreflight = $ExpectedPreflight
    $context.ReadOnly = [bool]$ReadOnly
    $operation = switch ($Command) {
        'start' { 'Deploy' }
        'stop' { 'Stop' }
        'edit-config' { 'EditConfig' }
        'check' { 'Test' }
    }
    Invoke-LocalDeployment -Context $context -Action $operation -DbReset:$DbReset -ForceChecks:$ForceChecks
} catch {
    $resetStatus = if ($context -and $context.DbResetStarted) {
        'The explicit database reset began; data may already have been deleted. Reset and initialization failures leave the app in maintenance.'
    } else { 'The application database was not reset.' }
    Write-Error "Local operation failed: $($_.Exception.Message) Review the failed phase above. $resetStatus"
    exit 1
}