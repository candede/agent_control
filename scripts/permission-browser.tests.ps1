#requires -Version 7.0
[CmdletBinding()]
param([string]$Project = 'agent-control-phase01')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
$context = New-LocalContext $root (Join-Path $root '.local') $Project 3001
$database = "agentcontrol_test_$([guid]::NewGuid().ToString('N'))"
$container = "$Project-permission-browser-$([guid]::NewGuid().ToString('N'))"
$evidence = Join-Path $root 'artifacts/phase03'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
Invoke-DockerCommand @('build', '--target', 'permission-browser-test', '-t', "$Project-permission-browser:local", $root)
Invoke-DockerCommand ($context.Compose + @('exec', '-T', 'postgres', 'psql', '-U', 'agentcontrol_admin', '-d', 'agentcontrol', '-v', 'ON_ERROR_STOP=1', '-c', "CREATE DATABASE `"$database`""))
try {
    Invoke-DockerCommand @('run', '--rm', '--name', $container, '--network', $context.Network,
        '--mount', "type=bind,source=$($context.State)/secrets,target=/run/secrets,readonly",
        '--mount', "type=bind,source=$evidence,target=/evidence", '-e', 'PGHOST=postgres', '-e', 'PGUSER=agentcontrol_admin',
        '-e', "PGDATABASE=$database", '-e', 'PGPASSWORD_FILE=/run/secrets/postgres-admin', '-e', 'APP_PGPASSWORD_FILE=/run/secrets/postgres-app',
        "$Project-permission-browser:local")
} finally {
    Invoke-DockerCommand ($context.Compose + @('exec', '-T', 'postgres', 'psql', '-U', 'agentcontrol_admin', '-d', 'agentcontrol', '-v', 'ON_ERROR_STOP=1', '-c', "DROP DATABASE `"$database`" WITH (FORCE)"))
}