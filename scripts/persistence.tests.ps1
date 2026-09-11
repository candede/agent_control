#requires -Version 7.0
[CmdletBinding()]
param([string]$Project='agent-control-phase01')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
$context=New-LocalContext $root $Project
$receipt=Join-Path $context.State 'persistence-fixture.json'
$controlDatabase="agentcontrol_test_$([guid]::NewGuid().ToString('N'))"
$restoreDatabase="agentcontrol_restore_$([guid]::NewGuid().ToString('N'))"
$beforeFile=Join-Path $context.State "backups/proof-$([guid]::NewGuid().ToString('N')).dump"
$afterFile=Join-Path $context.State "backups/proof-$([guid]::NewGuid().ToString('N')).dump"
$operator=@('run','--rm','--network',$context.Network,'--mount',"type=bind,source=$($context.State)/secrets,target=/run/secrets,readonly",'--mount',"type=bind,source=$($context.State),target=/evidence",'-e','PGHOST=postgres','-e','PGUSER=agentcontrol_admin','-e',"PGDATABASE=$controlDatabase",'-e','PGPASSWORD_FILE=/run/secrets/postgres-admin','-e','APP_PGPASSWORD_FILE=/run/secrets/postgres-app',$context.Operator,'backend/scripts/restart-fixture.ts')
if (Test-Path -LiteralPath $receipt) { throw 'Previous persistence receipt requires review before another run.' }
$hashes=@{}
foreach ($name in @('postgres-admin','postgres-app','session','client-secret')) { $hashes[$name]=(Get-FileHash -LiteralPath (Join-Path $context.State "secrets/$name")).Hash }
$settings=Get-Content -LiteralPath (Join-Path $context.State 'settings.json') -Raw | ConvertFrom-Json
Invoke-DockerCommand ($context.Compose + @('exec','-T','postgres','psql','-U','agentcontrol_admin','-d','agentcontrol','-v','ON_ERROR_STOP=1','-c',"CREATE DATABASE `"$controlDatabase`""))
try {
    Invoke-DockerCommand ($operator + @('seed','/evidence/persistence-fixture.json'))
    Invoke-LocalDeployment $context 'Backup' -BackupFile $beforeFile
    Invoke-LocalDeployment $context 'Stop'
    Invoke-DockerCommand ($context.Compose + @('up','-d','--wait','--wait-timeout','90','postgres'))
    Invoke-LocalDeployment $context 'Start'
    Invoke-DockerCommand ($operator + @('verify','/evidence/persistence-fixture.json'))
    Invoke-LocalDeployment $context 'Deploy'
    Invoke-DockerCommand ($operator + @('verify','/evidence/persistence-fixture.json'))
    Invoke-LocalDeployment $context 'Backup' -BackupFile $afterFile
    $before=(Get-Content -LiteralPath "$beforeFile.json" -Raw | ConvertFrom-Json).tables | ConvertTo-Json -Depth 5 -Compress
    $after=(Get-Content -LiteralPath "$afterFile.json" -Raw | ConvertFrom-Json).tables | ConvertTo-Json -Depth 5 -Compress
    if ($before -cne $after) { throw 'Application database fingerprints changed during restart/redeploy.' }
    Invoke-LocalDeployment $context 'Restore' -BackupFile $beforeFile -RestoreDatabase $restoreDatabase
    foreach ($name in $hashes.Keys) { if ((Get-FileHash -LiteralPath (Join-Path $context.State "secrets/$name")).Hash -cne $hashes[$name]) { throw 'A runtime secret changed during redeploy.' } }
    $currentSettings=Get-Content -LiteralPath (Join-Path $context.State 'settings.json') -Raw | ConvertFrom-Json
    foreach ($key in @('port','tenantId','clientId')) { if ($currentSettings.$key -cne $settings.$key) { throw 'Origin/identity settings changed during redeploy.' } }
    $services=(Invoke-DockerCommand ($context.Compose + @('ps','--format','json')) -Capture) -split "`n" | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json }
    if (@($services).Count -ne 2 -or @($services | Where-Object { $_.Health -ne 'healthy' }).Count) { throw 'Expected exactly two healthy runtime services.' }
    Write-Host 'Persistence proof passed: data, credentials, origin, two-service health and isolated native restore.'
} finally {
    foreach ($database in @($restoreDatabase,$controlDatabase)) {
        Invoke-DockerCommand ($context.Compose + @('exec','-T','postgres','psql','-U','agentcontrol_admin','-d','agentcontrol','-v','ON_ERROR_STOP=1','-c',"DROP DATABASE IF EXISTS `"$database`" WITH (FORCE)"))
    }
    if (Test-Path -LiteralPath $receipt) {
        $database=(Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json).database
        if ($database -notmatch '^agentcontrol_test_[a-z0-9_]+$') { throw 'Cleanup refused unsafe fixture database.' }
        Invoke-DockerCommand ($context.Compose + @('exec','-T','postgres','psql','-U','agentcontrol_admin','-d','agentcontrol','-v','ON_ERROR_STOP=1','-c',"DROP DATABASE `"$database`" WITH (FORCE)"))
        Remove-Item -LiteralPath $receipt
    }
    foreach ($filename in @($beforeFile,"$beforeFile.json",$afterFile,"$afterFile.json")) { if (Test-Path -LiteralPath $filename) { Remove-Item -LiteralPath $filename } }
}