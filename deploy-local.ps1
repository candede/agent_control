#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('Deploy','Start','Stop','Test','Backup','Restore','Reopen','Retain','Reset')]
    [string]$Action = 'Deploy',
    [string]$Project = 'agent-control',
    [ValidateRange(1024,65535)][int]$Port = 3001,
    [string]$StateRoot = (Join-Path $PSScriptRoot '.local'),
    [string]$TenantId,
    [string]$ClientId,
    [string]$ClientSecretFile,
    [string]$BackupFile,
    [string]$RestoreDatabase,
    [string]$ConfirmCleanup,
    [ValidateRange(1,5000)][int]$CleanupBatchSize = 1000,
    [switch]$DryRun,
    [string]$ConfirmReset,
    [switch]$OpenBrowser
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/local-deployment.ps1')
try {
    $context = New-LocalContext -Root $PSScriptRoot -StateRoot $StateRoot -Project $Project -Port $Port
    Invoke-LocalDeployment -Context $context -Action $Action -TenantId $TenantId -ClientId $ClientId -ClientSecretFile $ClientSecretFile -BackupFile $BackupFile -RestoreDatabase $RestoreDatabase -ConfirmCleanup $ConfirmCleanup -CleanupBatchSize $CleanupBatchSize -DryRun:$DryRun -ConfirmReset $ConfirmReset
    if ($OpenBrowser -and $Action -in @('Deploy','Start')) { Start-Process $context.Url }
} catch {
    Write-Error "Local operation failed: $($_.Exception.Message) Existing data has not been reset."
    exit 1
}