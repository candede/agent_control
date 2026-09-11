#requires -Version 7.0
[CmdletBinding()]
param([string]$Project='agent-control-phase01')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
$context=New-LocalContext $root (Join-Path $root '.local') $Project 3001
$container="$Project-restart-proof"
$receipt=Join-Path $context.State 'runtime-fixture.json'
$controlDatabase="agentcontrol_test_$([guid]::NewGuid().ToString('N'))"
$seed=@('run','--rm','--network',$context.Network,'--mount',"type=bind,source=$($context.State)/secrets,target=/run/secrets,readonly",'--mount',"type=bind,source=$($context.State),target=/evidence",'-e','PGHOST=postgres','-e','PGUSER=agentcontrol_admin','-e',"PGDATABASE=$controlDatabase",'-e','PGPASSWORD_FILE=/run/secrets/postgres-admin','-e','APP_PGPASSWORD_FILE=/run/secrets/postgres-app',$context.Operator,'backend/scripts/restart-fixture.ts')
if (Test-Path -LiteralPath $receipt) { throw 'Prior runtime fixture receipt exists; review its guarded database before retrying.' }
Invoke-DockerCommand ($context.Compose + @('exec','-T','postgres','psql','-U','agentcontrol_admin','-d','agentcontrol','-v','ON_ERROR_STOP=1','-c',"CREATE DATABASE `"$controlDatabase`""))
try {
    Invoke-DockerCommand ($seed + @('seed','/evidence/runtime-fixture.json'))
    $runtime=@('run','--name',$container,'--network',$context.Network,'--read-only','--mount',"type=bind,source=$($context.State)/secrets/postgres-app,target=/run/secrets/postgres-app,readonly",'--mount',"type=bind,source=$($context.State)/secrets/session,target=/run/secrets/session,readonly",'--mount',"type=bind,source=$receipt,target=/evidence/restart-fixture.json,readonly",'--mount',"type=bind,source=$root/backend/scripts/restart-runtime.mjs,target=/fixture.mjs,readonly",'--user',"$((& id -u).Trim()):$((& id -g).Trim())",'-e','PGHOST=postgres','-e','PGUSER=agentcontrol_app','-e','PGPASSWORD_FILE=/run/secrets/postgres-app','-e','SESSION_SECRET_FILE=/run/secrets/session','-e','TENANT_ID=11111111-1111-4111-8111-111111111111','--entrypoint','node',$context.Image,'/fixture.mjs')
    & docker @runtime crash
    if ($LASTEXITCODE -ne 17) { throw 'Fixture must exit exactly after persisting the second dispatch.' }
    Invoke-DockerCommand @('rm',$container)
    Invoke-DockerCommand ($seed + @('expire','/evidence/runtime-fixture.json'))
    Invoke-DockerCommand ($runtime + @('recover'))
} finally {
    & docker rm -f $container 2>$null | Out-Null
    if (Test-Path -LiteralPath $receipt) {
        $database=(Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json).database
        if ($database -notmatch '^agentcontrol_test_[a-z0-9_]+$') { throw 'Cleanup refused unsafe fixture database.' }
        Invoke-DockerCommand ($context.Compose + @('exec','-T','postgres','psql','-U','agentcontrol_admin','-d','agentcontrol','-v','ON_ERROR_STOP=1','-c',"DROP DATABASE `"$database`" WITH (FORCE)"))
        Remove-Item -LiteralPath $receipt
    }
    Invoke-DockerCommand ($context.Compose + @('exec','-T','postgres','psql','-U','agentcontrol_admin','-d','agentcontrol','-v','ON_ERROR_STOP=1','-c',"DROP DATABASE `"$controlDatabase`" WITH (FORCE)"))
}