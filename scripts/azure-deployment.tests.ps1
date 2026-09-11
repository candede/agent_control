#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'azure-deployment.ps1')
$scratchRoot = Join-Path $root 'artifacts/test-scratch'
$scratch = Join-Path $scratchRoot "azure-deployment-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($scratch) | Out-Null
$script:Checks = 0
$script:Contexts = [Collections.Generic.List[object]]::new()

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
    $script:Checks++
}
function Assert-Fails {
    param([scriptblock]$Command, [string]$Pattern)
    try { & $Command; throw 'Expected failure did not occur.' }
    catch { Assert-True ($_.Exception.Message -match $Pattern) "Unexpected failure: $($_.Exception.Message)" }
}
function Copy-Object {
    param($Value)
    return ($Value | ConvertTo-Json -Depth 40 | ConvertFrom-Json -Depth 40)
}
function Save-Json {
    param($Value, [string]$Name)
    $path = Join-Path $scratch $Name
    [IO.File]::WriteAllText($path, ($Value | ConvertTo-Json -Depth 40))
    return $path
}

function New-Target {
    param([ValidateSet('fresh', 'upgrade', 'legacy_import')][string]$Mode = 'upgrade')
    $tenant = '11111111-1111-4111-8111-111111111111'
    $subscription = '22222222-2222-4222-8222-222222222222'
    $group = 'fixture-agent-control'
    $plan = 'fixture-agent-control-plan'
    $app = 'fixture-agent-control-app'
    $postgres = 'fixture-agent-control-postgres'
    $versions = @($script:RequiredSecretNames | ForEach-Object { [PSCustomObject]@{ name = $_; version = 'fixtureversion1' } })
    return [PSCustomObject]@{
        contractVersion = 2
        isApproval = $true
        tenantId = $tenant
        subscriptionId = $subscription
        resourceGroup = $group
        region = 'fixtureregion'
        entraApplicationId = '33333333-3333-4333-8333-333333333333'
        canonicalOrigin = "https://$app.azurewebsites.net"
        callbackUri = "https://$app.azurewebsites.net/api/auth/callback"
        existingVaultResourceId = "/subscriptions/$subscription/resourceGroups/fixture-security/providers/Microsoft.KeyVault/vaults/fixture-vault"
        installationMode = $Mode
        firstInstallApproved = $Mode -eq 'fresh'
        expectedResourceIds = [PSCustomObject]@{
            appServicePlan = "/subscriptions/$subscription/resourceGroups/$group/providers/Microsoft.Web/serverfarms/$plan"
            appService = "/subscriptions/$subscription/resourceGroups/$group/providers/Microsoft.Web/sites/$app"
            postgresFlexibleServer = "/subscriptions/$subscription/resourceGroups/$group/providers/Microsoft.DBforPostgreSQL/flexibleServers/$postgres"
        }
        expectedDatabaseName = 'agentcontrol'
        expectedSchemaVersion = 26
        runnerIpv4Address = '192.0.2.10'
        legacyAuditBackupPath = $(if ($Mode -eq 'legacy_import') { (Join-Path $scratch 'fixture-legacy.sqlite') } else { $null })
        legacyAuditBackupSha256 = $(if ($Mode -eq 'legacy_import') { 'a' * 64 } else { $null })
        resources = [PSCustomObject]@{
            appServicePlan = [PSCustomObject]@{ name = $plan; sku = 'B1'; linux = $true; instanceCount = 1 }
            appService = [PSCustomObject]@{ name = $app; nodeMajor = 24; remoteBuildEnabled = $false }
            postgresFlexibleServer = [PSCustomObject]@{
                name = $postgres; database = 'agentcontrol'; sku = 'Standard_B1ms'; tier = 'Burstable'; version = 17
                storageGiB = 32; backupRetentionDays = 7; highAvailability = $false; replicas = 0; applicationPoolMaximum = 4
            }
            approvedAppOutboundIpv4Addresses = @('192.0.2.20')
            monitoring = [PSCustomObject]@{
                retentionDays = 30
                dailyIngestionLimitGiB = 0.1
                actionGroupResourceId = "/subscriptions/$subscription/resourceGroups/fixture-monitoring/providers/Microsoft.Insights/actionGroups/fixture-operators"
                budgetStartDate = [DateTime]::UtcNow.ToString('yyyy-MM-01')
                budgetEndDate = [DateTime]::UtcNow.AddYears(1).ToString('yyyy-MM-01')
            }
        }
        estimate = [PSCustomObject]@{
            currency = 'USD'
            asOfDate = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
            source = 'Synthetic fixture estimate; not a quote'
            items = [PSCustomObject]@{
                appService = 1; postgresCompute = 1; postgresStorage = 1; postgresBackup = 1
                monitoring = 1; keyVault = 1; networking = 1; restoreDrill = 1
            }
            monthlyTotal = 8
        }
        approvedMonthlyBudget = 10
        operatorApproval = [PSCustomObject]@{
            approvedBy = 'fixture-budget-role'
            approvedAt = [DateTimeOffset]::UtcNow.ToString('o')
            changeReference = 'fixture-change-1'
        }
        maintenanceApproval = [PSCustomObject]@{
            approvedBy = 'fixture-release-role'
            windowStartsAt = [DateTimeOffset]::UtcNow.AddMinutes(-5).ToString('o')
            windowEndsAt = [DateTimeOffset]::UtcNow.AddHours(2).ToString('o')
        }
        riskAcceptance = [PSCustomObject]@{
            burstablePocLimitationsAccepted = $true
            reference = 'fixture-risk-acceptance-1'
        }
        legacyStaticWebApp = [PSCustomObject]@{ resourceId = $null; retirementApproved = $false; approvalReference = $null }
        preparedVaultContract = [PSCustomObject]@{
            secretNames = @($script:RequiredSecretNames)
            runtimeConsumers = @($script:RuntimeSecretNames)
            administratorPasswordRuntimeAccessible = $false
            bootstrapSecretCleanupRequired = $true
            versions = @($versions)
            existingVersions = $(if ($Mode -eq 'fresh') { @() } else { @($versions | ForEach-Object { [PSCustomObject]@{ name = $_.name; version = $_.version } }) })
        }
    }
}

$script:OperationNames = @(
    'prerequisites', 'operator_identity', 'bicep_build', 'sku_pricing_preflight', 'vault_preflight',
    'registration_verify', 'qualification_preflight', 'target_inventory', 'release_inspection', 'bicep_what_if',
    'approval_checkpoint', 'resume_verify', 'resource_deploy', 'network_reconcile', 'enter_maintenance',
    'drain_verify', 'managed_backup', 'backup_health_verify', 'database_preflight', 'database_migrate', 'legacy_import',
    'package_deploy', 'runtime_access_verify', 'monitoring_verify', 'start_contained', 'contained_smoke',
    'authentication_smoke_verify', 'database_reopen', 'open_and_verify', 'retire_legacy_swa',
    'pitr_restore', 'pitr_validate_review', 'recovery_switch', 'contain_runtime', 'cleanup'
)

function Add-Command {
    param($Fixture, [string]$Operation, [string]$Executable, [string[]]$Arguments, $Json, [string]$Output = '', [int]$ExitCode = 0)
    $command = [ordered]@{ executable = $Executable; arguments = @($Arguments); exitCode = $ExitCode }
    if ($PSBoundParameters.ContainsKey('Json')) { $command.json = $Json } else { $command.output = $Output }
    $Fixture.commands[$Operation] = @($Fixture.commands[$Operation]) + @([PSCustomObject]$command)
}
function Add-Az {
    param($Fixture, [string]$Operation, [string[]]$Arguments, $Json, [int]$ExitCode = 0)
    Add-Command $Fixture $Operation az (@($Arguments) + @('--only-show-errors', '-o', 'json')) -Json $Json -ExitCode $ExitCode
}
function Add-DatabaseCommand {
    param($Fixture, [string]$Operation, $Target, [string[]]$Command, [string]$Server = '', [string]$CurrentServer = '', [switch]$RuntimeRole, [switch]$Legacy)
    $databaseServer = if ($Server) { $Server } else { $Target.resources.postgresFlexibleServer.name }
    $args = @('run', '--rm', '--platform', 'linux/amd64',
        '--mount', 'type=bind,source={{ROOT}}/artifacts/azure-bootstrap/{{RUN_ID}},target=/run/secrets,readonly',
        '-e', "PGHOST=$databaseServer.postgres.database.azure.com", '-e', 'PGPORT=5432', '-e', 'PGDATABASE=agentcontrol',
        '-e', "PGUSER=$(if ($RuntimeRole) { 'agentcontrol_app' } else { 'agentcontrol_admin' })",
        '-e', "PGPASSWORD_FILE=/run/secrets/$(if ($RuntimeRole) { 'postgres-app' } else { 'postgres-admin' })",
        '-e', 'APP_PGPASSWORD_FILE=/run/secrets/postgres-app', '-e', 'PGSSLMODE=verify-full')
    if ($CurrentServer) { $args += @('-e', "CURRENT_PGHOST=$CurrentServer.postgres.database.azure.com") }
    if ($Legacy) {
        $args += @('--mount', "type=bind,source=$($Target.legacyAuditBackupPath),target=/legacy/audit.sqlite,readonly")
        $Command = @($Command[0], '/legacy/audit.sqlite', $Command[2])
    }
    $args += @('agent-control-azure-operator:local') + $Command
    Add-Command $Fixture $Operation docker $args -Output '{"outcome":"succeeded"}'
}
function ReferenceStatus {
    param($Target, [string]$Status = 'Resolved', [string]$MismatchSetting)
    $properties = [ordered]@{}
    $map = [ordered]@{}
    $map['TENANT_ID'] = 'agent-control-tenant-id'
    $map['CLIENT_ID'] = 'agent-control-client-id'
    $map['CLIENT_SECRET'] = 'agent-control-client-secret'
    $map['SESSION_SECRET'] = 'agent-control-session-secret'
    $map['PGPASSWORD'] = 'agent-control-postgres-app-password'
    foreach ($setting in $map.Keys) {
        $secret = if ($setting -ceq $MismatchSetting) { 'wrong-secret' } else { $map[$setting] }
        $properties[$setting] = [PSCustomObject]@{
            status = $Status; vaultName = 'fixture-vault'; secretName = $secret; secretVersion = 'fixtureversion1'
        }
    }
    return [PSCustomObject]@{ properties = [PSCustomObject]$properties }
}
function Add-RuntimeCommands {
    param($Fixture, $Target, [object[]]$ReferenceResponses = @((ReferenceStatus $Target)))
    $Fixture.commands.runtime_access_verify = @()
    Add-Az $Fixture runtime_access_verify @('webapp', 'show', '--ids', $Target.expectedResourceIds.appService) -Json @{
        identity = @{ principalId = '44444444-4444-4444-8444-444444444444' }
    }
    foreach ($response in $ReferenceResponses) {
        if ($response -is [int]) {
            Add-Az $Fixture runtime_access_verify @('rest', '--method', 'post', '--url',
                "https://management.azure.com$($Target.expectedResourceIds.appService)/config/configreferences/appsettings/list?api-version=2022-03-01") -Json @{} -ExitCode $response
        } else {
            Add-Az $Fixture runtime_access_verify @('rest', '--method', 'post', '--url',
                "https://management.azure.com$($Target.expectedResourceIds.appService)/config/configreferences/appsettings/list?api-version=2022-03-01") -Json $response
        }
    }
    Add-Az $Fixture runtime_access_verify @('role', 'assignment', 'list', '--assignee-object-id',
        '44444444-4444-4444-8444-444444444444', '--scope',
        "$($Target.existingVaultResourceId)/secrets/agent-control-postgres-admin-password", '--include-inherited') -Json @()
    Add-DatabaseCommand $Fixture runtime_access_verify $Target @('backend/scripts/azure-database.ts', 'runtime') -RuntimeRole
}

function New-Fixture {
    param($Target, [switch]$FreshResourcesExist, [switch]$ResumeDatabaseInitialized, [switch]$Pitr, [switch]$Recovery)
    $commands = [ordered]@{}
    foreach ($name in $script:OperationNames) { $commands[$name] = @() }
    $fixture = [ordered]@{ fixtureVersion = 2; rejectUnexpected = $true; commands = $commands }
    Add-Command $fixture prerequisites docker @('info')
    Add-Az $fixture operator_identity @('account', 'show', '--subscription', $Target.subscriptionId) -Json @{
        id = $Target.subscriptionId; tenantId = $Target.tenantId; user = @{ type = 'user' }
    }
    Add-Command $fixture bicep_build docker @('run', '--rm', '-v', '{{ROOT}}:/workspace:ro', '-w', '/workspace',
        'mcr.microsoft.com/azure-cli:2.77.0', 'az', 'bicep', 'build', '--file', 'infra/main.bicep', '--stdout')
    Add-Az $fixture sku_pricing_preflight @('postgres', 'flexible-server', 'list-skus', '--location', $Target.region,
        '--subscription', $Target.subscriptionId) -Json @{
        supportedServerEditions = @(@{ name = 'Burstable'; supportedServerSkus = @(@{
            name = 'Standard_B1ms'; supportedServerVersions = @(@{ name = '16' }, @{ name = '17' })
        }) })
    }
    Add-Az $fixture sku_pricing_preflight @('appservice', 'list-locations', '--sku', 'B1', '--linux-workers-enabled',
        '--subscription', $Target.subscriptionId) -Json @(@{ name = $Target.region })
    Add-Az $fixture sku_pricing_preflight @('webapp', 'list-runtimes', '--os-type', 'linux') -Json @('NODE:24-lts')
    Add-Az $fixture sku_pricing_preflight @('rest', '--method', 'get', '--url',
        "https://management.azure.com/subscriptions/$($Target.subscriptionId)/providers/Microsoft.Web/locations/$($Target.region)/usages?api-version=2023-12-01") -Json @{
        value = @(@{ name = @{ value = 'Basic' }; currentValue = 0; limit = 1 })
    }
    Add-Az $fixture vault_preflight @('keyvault', 'show', '--id', $Target.existingVaultResourceId) -Json @{
        name = 'fixture-vault'; properties = @{ tenantId = $Target.tenantId; enableRbacAuthorization = $true; enabledForTemplateDeployment = $true }
    }
    foreach ($name in $script:RequiredSecretNames) {
        $value = "synthetic-fixture-$name-value-that-is-long-enough-0001"
        if ($name -eq 'agent-control-tenant-id') { $value = $Target.tenantId }
        if ($name -eq 'agent-control-client-id') { $value = $Target.entraApplicationId }
        Add-Az $fixture vault_preflight @('keyvault', 'secret', 'show', '--vault-name', 'fixture-vault', '--name', $name,
            '--version', 'fixtureversion1') -Json @{ value = $value; attributes = @{ enabled = $true; expires = [DateTimeOffset]::UtcNow.AddDays(30).ToString('o') } }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $root 'infra/entra-app-manifest.json') -Raw | ConvertFrom-Json
    Add-Az $fixture registration_verify @('ad', 'app', 'show', '--id', $Target.entraApplicationId) -Json @{
        appRoles = @($manifest.appRoles); web = @{ redirectUris = @($Target.callbackUri) }
    }
    Add-Az $fixture registration_verify @('ad', 'sp', 'list', '--filter', "appId eq '$($Target.entraApplicationId)'") -Json @(@{ id = '55555555-5555-4555-8555-555555555555' })
    $administratorRole = @($manifest.appRoles | Where-Object value -eq 'AgentControl.Administrator')[0]
    Add-Az $fixture registration_verify @('rest', '--method', 'get', '--url',
        "https://graph.microsoft.com/v1.0/servicePrincipals/55555555-5555-4555-8555-555555555555/appRoleAssignedTo?`$filter=appRoleId%20eq%20$($administratorRole.id)&`$select=id,principalType") -Json @{
        value = @(@{ id = '66666666-6666-4666-8666-666666666666'; principalType = 'User' })
    }
    $resources = @(
        @{ id = $Target.expectedResourceIds.appServicePlan; type = 'Microsoft.Web/serverfarms' },
        @{ id = $Target.expectedResourceIds.appService; type = 'Microsoft.Web/sites' },
        @{ id = $Target.expectedResourceIds.postgresFlexibleServer; type = 'Microsoft.DBforPostgreSQL/flexibleServers' }
    )
    foreach ($resource in $resources) {
        if ($Target.installationMode -eq 'fresh' -and -not $FreshResourcesExist) {
            Add-Az $fixture target_inventory @('resource', 'show', '--ids', $resource.id) -Json @{} -ExitCode 3
        } else {
            Add-Az $fixture target_inventory @('resource', 'show', '--ids', $resource.id) -Json @{
                id = $resource.id; type = $resource.type
                tags = @{ app = 'agent-control'; topology = 'single-app-managed-postgresql'; wizardRunId = '{{RUN_ID}}' }
            }
        }
    }
    if ($FreshResourcesExist) {
        Add-DatabaseCommand $fixture resume_verify $Target @('backend/scripts/azure-database.ts', 'preflight',
            $(if ($ResumeDatabaseInitialized) { 'upgrade' } else { 'fresh' }),
            $(if ($ResumeDatabaseInitialized) { '26' } else { '0' }))
        Add-Az $fixture resume_verify @('webapp', 'config', 'appsettings', 'list', '--ids', $Target.expectedResourceIds.appService) -Json @(
            @{ name = 'MAINTENANCE_MODE'; value = 'true' }
        )
        Add-Az $fixture resume_verify @('webapp', 'show', '--ids', $Target.expectedResourceIds.appService) -Json @{ state = 'Stopped' }
    }
    Add-Command $fixture release_inspection docker @('build', '--target', 'operator', '-t', 'agent-control-azure-operator:local', '{{ROOT}}')
    Add-Command $fixture release_inspection docker @('run', '--rm', '--mount',
        'type=bind,source={{ROOT}}/artifacts/release,target=/export,readonly', '--entrypoint', 'node',
        'agent-control-azure-operator:local', 'backend/scripts/release-inspect.mjs', '/export/agent-control-linux-x64.zip') `
        -Output '{"revision":"fixture-revision","platform":"linux","architecture":"x64","nodeMajor":24}'
    Add-Command $fixture bicep_what_if az @('deployment', 'group', 'what-if', '--subscription', $Target.subscriptionId,
        '--resource-group', $Target.resourceGroup, '--template-file', '{{ROOT}}/infra/main.bicep',
        '--parameters', '@{{PARAMETER_FILE}}', '--only-show-errors', '--no-pretty-print') -Output 'fixture what-if'
    Add-Az $fixture resource_deploy @('deployment', 'group', 'create', '--subscription', $Target.subscriptionId,
        '--resource-group', $Target.resourceGroup, '--name', 'agent-control-{{RUN_ID}}', '--template-file',
        '{{ROOT}}/infra/main.bicep', '--parameters', '@{{PARAMETER_FILE}}') -Json @{ name = 'agent-control-{{RUN_ID}}'; properties = @{ outputs = @{} } }
    Add-Az $fixture resource_deploy @('webapp', 'config', 'appsettings', 'set', '--ids', $Target.expectedResourceIds.appService,
        '--settings', 'MAINTENANCE_MODE=true') -Json @{}
    Add-Az $fixture resource_deploy @('webapp', 'stop', '--ids', $Target.expectedResourceIds.appService) -Json @{}
    Add-Az $fixture network_reconcile @('webapp', 'show', '--ids', $Target.expectedResourceIds.appService) -Json @{ outboundIpAddresses = '192.0.2.20' }
    Add-Az $fixture network_reconcile @('postgres', 'flexible-server', 'firewall-rule', 'create', '--subscription',
        $Target.subscriptionId, '--resource-group', $Target.resourceGroup, '--name', $Target.resources.postgresFlexibleServer.name,
        '--rule-name', 'wizard-{{RUN_ID}}', '--start-ip-address', $Target.runnerIpv4Address, '--end-ip-address', $Target.runnerIpv4Address) -Json @{}
    if ($Target.installationMode -ne 'fresh') {
        Add-Az $fixture enter_maintenance @('webapp', 'config', 'appsettings', 'set', '--ids', $Target.expectedResourceIds.appService,
            '--settings', 'MAINTENANCE_MODE=true') -Json @{}
        Add-Az $fixture enter_maintenance @('webapp', 'stop', '--ids', $Target.expectedResourceIds.appService) -Json @{}
    }
    Add-DatabaseCommand $fixture enter_maintenance $Target @('backend/scripts/azure-database.ts', 'maintenance')
    Add-DatabaseCommand $fixture drain_verify $Target @('backend/scripts/azure-database.ts', 'drain')
    Add-Az $fixture managed_backup @('postgres', 'flexible-server', 'backup', 'create', '--subscription',
        $Target.subscriptionId, '--resource-group', $Target.resourceGroup, '--name', $Target.resources.postgresFlexibleServer.name,
        '--backup-name', 'release-{{RUN_ID}}') -Json @{}
    Add-Az $fixture backup_health_verify @('postgres', 'flexible-server', 'backup', 'show', '--subscription',
        $Target.subscriptionId, '--resource-group', $Target.resourceGroup, '--name', $Target.resources.postgresFlexibleServer.name,
        '--backup-name', 'release-{{RUN_ID}}') -Json @{
        backupName = 'release-{{RUN_ID}}'
        source = $Target.expectedResourceIds.postgresFlexibleServer
        completedTime = '{{BACKUP_COMPLETED_AT}}'
        status = 'Completed'
    }
    Add-DatabaseCommand $fixture database_preflight $Target @('backend/scripts/azure-database.ts', 'preflight',
        $Target.installationMode, $(if ($Target.installationMode -eq 'fresh') { '0' } else { '26' }))
    Add-DatabaseCommand $fixture database_migrate $Target @('backend/scripts/database.ts')
    if ($Target.installationMode -eq 'legacy_import') {
        Add-DatabaseCommand $fixture legacy_import $Target @('backend/scripts/import-legacy-audit.ts', $Target.legacyAuditBackupPath,
            $Target.legacyAuditBackupSha256) -Legacy
    }
    Add-Az $fixture package_deploy @('webapp', 'deploy', '--ids', $Target.expectedResourceIds.appService, '--src-path',
        '{{ARTIFACT}}', '--type', 'zip', '--clean', 'false', '--restart', 'false') -Json @{}
    Add-RuntimeCommands $fixture $Target
    Add-Az $fixture monitoring_verify @('monitor', 'diagnostic-settings', 'show', '--resource',
        $Target.expectedResourceIds.appService, '--name', 'agent-control-app') -Json @{
        workspaceId = "/subscriptions/$($Target.subscriptionId)/resourceGroups/$($Target.resourceGroup)/providers/Microsoft.OperationalInsights/workspaces/$($Target.resources.appService.name)-logs"
        logAnalyticsDestinationType = 'Dedicated'
        logs = @(@{ category = 'AppServiceConsoleLogs'; enabled = $true })
        metrics = @(@{ category = 'AllMetrics'; enabled = $true })
    }
    Add-Az $fixture monitoring_verify @('monitor', 'diagnostic-settings', 'show', '--resource',
        $Target.expectedResourceIds.postgresFlexibleServer, '--name', 'agent-control-postgresql') -Json @{
        workspaceId = "/subscriptions/$($Target.subscriptionId)/resourceGroups/$($Target.resourceGroup)/providers/Microsoft.OperationalInsights/workspaces/$($Target.resources.appService.name)-logs"
        logs = @()
        metrics = @(@{ category = 'AllMetrics'; enabled = $true })
    }
    $metricAlerts = @(
        @{ name = "$($Target.resources.appService.name)-health-check"; metric = 'HealthCheckStatus'; operator = 'LessThan'; threshold = 100; aggregation = 'Average' },
        @{ name = "$($Target.resources.appService.name)-http-5xx"; metric = 'Http5xx'; operator = 'GreaterThanOrEqual'; threshold = 5; aggregation = 'Total' },
        @{ name = "$($Target.resources.appService.name)-latency"; metric = 'AverageResponseTime'; operator = 'GreaterThan'; threshold = 2; aggregation = 'Average' },
        @{ name = "$($Target.resources.postgresFlexibleServer.name)-storage"; metric = 'storage_percent'; operator = 'GreaterThan'; threshold = 80; aggregation = 'Average' },
        @{ name = "$($Target.resources.postgresFlexibleServer.name)-cpu-credits"; metric = 'cpu_credits_remaining'; operator = 'LessThan'; threshold = 20; aggregation = 'Average' },
        @{ name = "$($Target.resources.postgresFlexibleServer.name)-backup-storage-cost"; metric = 'backup_storage_used'; operator = 'GreaterThan'; threshold = 34359738368; aggregation = 'Maximum' }
    ) | ForEach-Object {
        @{ name = $_.name; enabled = $true; criteria = @{ allOf = @(@{
            metricName = $_.metric; operator = $_.operator; threshold = $_.threshold; timeAggregation = $_.aggregation
        }) } }
    }
    Add-Az $fixture monitoring_verify @('monitor', 'metrics', 'alert', 'list', '--resource-group', $Target.resourceGroup,
        '--subscription', $Target.subscriptionId) -Json $metricAlerts
    $eventPrefix = 'AppServiceConsoleLogs | extend AgentControlEvent = tostring(parse_json(ResultDescription).event) | where AgentControlEvent '
    Add-Az $fixture monitoring_verify @('monitor', 'scheduled-query', 'list', '--resource-group', $Target.resourceGroup,
        '--subscription', $Target.subscriptionId) -Json @(
        @{ name = "$($Target.resources.appService.name)-restarts"; enabled = $true; criteria = @{ allOf = @(@{
            query = "${eventPrefix}== `"listening`""; timeAggregation = 'Count'; operator = 'GreaterThan'; threshold = 2
        }) } },
        @{ name = "$($Target.resources.appService.name)-provider-failures"; enabled = $true; criteria = @{ allOf = @(@{
            query = "${eventPrefix}in (`"provider_throttled`", `"provider_schema_omission`", `"request_error`")"
            timeAggregation = 'Count'; operator = 'GreaterThanOrEqual'; threshold = 5
        }) } },
        @{ name = "$($Target.resources.appService.name)-safety-incidents"; enabled = $true; criteria = @{ allOf = @(@{
            query = "${eventPrefix}in (`"job_execution_stopped`", `"quarantine_job_stopped`", `"job_write_uncertain`", `"quarantine_write_uncertain`", `"official_usage_upload_cleanup_failed`", `"database_pool_error`", `"database_pool_saturated`", `"session_store_error`")"
            timeAggregation = 'Count'; operator = 'GreaterThan'; threshold = 0
        }) } }
    )
    Add-Az $fixture monitoring_verify @('monitor', 'action-group', 'test-notifications', 'create', '--resource-group',
        'fixture-monitoring', '--action-group', 'fixture-operators', '--alert-type', 'budget') -Json @{}
    Add-Az $fixture start_contained @('webapp', 'config', 'appsettings', 'set', '--ids', $Target.expectedResourceIds.appService,
        '--settings', 'MAINTENANCE_MODE=true') -Json @{}
    Add-Az $fixture start_contained @('webapp', 'start', '--ids', $Target.expectedResourceIds.appService) -Json @{}
    foreach ($http in @(
        @{ path = '/api/health'; code = 200; body = '{"ok":true}' },
        @{ path = '/api/ready'; code = 503; body = '{"ok":false}' },
        @{ path = '/'; code = 200; body = '<html>fixture</html>' },
        @{ path = '/agents'; code = 200; body = '<html>fixture</html>' },
        @{ path = '/api/agents'; code = 401; body = '{"code":"authentication_required"}' },
        @{ path = '/api/auth/status'; code = 200; body = "{`"authConfigured`":true,`"callback`":`"$($Target.callbackUri)`"}" }
    )) {
        Add-Command $fixture contained_smoke __http_get__ @("$($Target.canonicalOrigin)$($http.path)") -Output $http.body -ExitCode $http.code
    }
    Add-DatabaseCommand $fixture database_reopen $Target @('backend/scripts/azure-database.ts', 'reopen') `
        -Server $(if ($Recovery) { "$($Target.resources.postgresFlexibleServer.name)-restore-{{RUN_ID_8}}" } else { $Target.resources.postgresFlexibleServer.name })
    Add-Az $fixture open_and_verify @('webapp', 'config', 'appsettings', 'delete', '--ids', $Target.expectedResourceIds.appService,
        '--setting-names', 'MAINTENANCE_MODE') -Json @{}
    Add-Command $fixture open_and_verify __http_get__ @("$($Target.canonicalOrigin)/api/ready") -Output '{"ok":true}' -ExitCode 200
    Add-Command $fixture open_and_verify __http_get__ @("$($Target.canonicalOrigin)/api/auth/status") `
        -Output "{`"authConfigured`":true,`"callback`":`"$($Target.callbackUri)`"}" -ExitCode 200
    if ($Target.legacyStaticWebApp.resourceId) {
        Add-Az $fixture retire_legacy_swa @('resource', 'show', '--ids', $Target.legacyStaticWebApp.resourceId) -Json @{
            id = $Target.legacyStaticWebApp.resourceId; type = 'Microsoft.Web/staticSites'; tags = @{ app = 'agent-control' }
        }
        Add-Az $fixture retire_legacy_swa @('resource', 'delete', '--ids', $Target.legacyStaticWebApp.resourceId) -Json @{}
    }
    if ($Pitr -or $Recovery) {
        Add-Az $fixture pitr_restore @('postgres', 'flexible-server', 'restore', '--subscription', $Target.subscriptionId,
            '--resource-group', $Target.resourceGroup, '--name', "$($Target.resources.postgresFlexibleServer.name)-restore-{{RUN_ID_8}}",
            '--source-server', $Target.resources.postgresFlexibleServer.name, '--restore-time', '{{RESTORE_POINT}}') -Json @{}
        Add-DatabaseCommand $fixture pitr_validate_review $Target @('backend/scripts/azure-pitr.ts', '{{RESTORE_POINT}}') `
            -Server "$($Target.resources.postgresFlexibleServer.name)-restore-{{RUN_ID_8}}" -CurrentServer $Target.resources.postgresFlexibleServer.name
    }
    if ($Recovery) {
        Add-Az $fixture recovery_switch @('webapp', 'config', 'appsettings', 'set', '--ids', $Target.expectedResourceIds.appService,
            '--settings', "PGHOST=$($Target.resources.postgresFlexibleServer.name)-restore-{{RUN_ID_8}}.postgres.database.azure.com",
            'MAINTENANCE_MODE=true') -Json @{}
    }
    Add-Az $fixture contain_runtime @('webapp', 'config', 'appsettings', 'set', '--ids', $Target.expectedResourceIds.appService,
        '--settings', 'MAINTENANCE_MODE=true') -Json @{}
    Add-Az $fixture contain_runtime @('webapp', 'stop', '--ids', $Target.expectedResourceIds.appService) -Json @{}
    Add-DatabaseCommand $fixture contain_runtime $Target @('backend/scripts/azure-database.ts', 'maintenance') `
        -Server $(if ($Recovery) { "$($Target.resources.postgresFlexibleServer.name)-restore-{{RUN_ID_8}}" } else { $Target.resources.postgresFlexibleServer.name })
    Add-Az $fixture cleanup @('postgres', 'flexible-server', 'firewall-rule', 'delete', '--yes', '--subscription',
        $Target.subscriptionId, '--resource-group', $Target.resourceGroup, '--name', $Target.resources.postgresFlexibleServer.name,
        '--rule-name', 'wizard-{{RUN_ID}}') -Json @{}
    $fixture.commands.cleanup[-1] | Add-Member -NotePropertyName optional -NotePropertyValue $true
    if ($Pitr -and -not $Recovery) {
        Add-Az $fixture cleanup @('postgres', 'flexible-server', 'delete', '--yes', '--subscription', $Target.subscriptionId,
            '--resource-group', $Target.resourceGroup, '--name', "$($Target.resources.postgresFlexibleServer.name)-restore-{{RUN_ID_8}}") -Json @{}
        $fixture.commands.cleanup[-1] | Add-Member -NotePropertyName optional -NotePropertyValue $true
    }
    return $fixture
}

function New-SmokeReceipt {
    param($Context, [string]$Name = 'auth-smoke.json')
    $path = Join-Path $scratch $Name
    $artifact = Test-ReleaseArtifact $Context.ArtifactPath
    Save-Json ([ordered]@{
        receiptVersion = 1; isApproval = $true; evidenceType = 'synthetic_fixture'; deploymentRunId = $Context.RunId
        targetApprovalDigest = Get-TargetApprovalDigest $Context.Target; canonicalOrigin = $Context.Target.canonicalOrigin
        callbackUri = $Context.Target.callbackUri; artifactSha256 = $artifact.checksum
        loginCallbackSessionVerified = $true; performedAt = [DateTimeOffset]::UtcNow.ToString('o')
        approvedBy = 'fixture-auth-operator'; reference = 'fixture-auth-smoke'
    }) $Name | Out-Null
    $Context.AuthenticationSmokeReceiptPath = $path
    return $path
}
function Save-SmokeReceiptForRun {
    param($Target, [string]$RunId, [string]$Name)
    $path = Join-Path $scratch $Name
    $artifactPath = Join-Path $root 'artifacts/release/agent-control-linux-x64.zip'
    Save-Json ([ordered]@{
        receiptVersion = 1; isApproval = $true; evidenceType = 'synthetic_fixture'; deploymentRunId = $RunId
        targetApprovalDigest = Get-TargetApprovalDigest $Target; canonicalOrigin = $Target.canonicalOrigin
        callbackUri = $Target.callbackUri; artifactSha256 = (Test-ReleaseArtifact $artifactPath).checksum
        loginCallbackSessionVerified = $true; performedAt = [DateTimeOffset]::UtcNow.ToString('o')
        approvedBy = 'fixture-auth-operator'; reference = 'fixture-auth-smoke'
    }) $Name | Out-Null
    return $path
}
function Set-SyntheticBootstrapSecrets {
    param($Context)
    $Context.SecretValues = @{
        'agent-control-postgres-admin-password' = 'synthetic-admin-password-at-least-thirty-two-characters'
        'agent-control-postgres-app-password' = 'synthetic-runtime-password-at-least-thirty-two-characters'
    }
}
function New-Context {
    param($Target, $Fixture, [string]$Name, [string]$Action = 'Deploy', [string]$ResumeReceiptPath)
    $targetPath = Save-Json $Target "$Name-target.json"
    $fixturePath = Save-Json $Fixture "$Name-fixture.json"
    $validated = Read-ApprovedAzureTarget $targetPath Mock
    $context = New-AzureDeploymentContext -Root $root -Target $validated -ExecutionMode Mock -MockFixturePath $fixturePath `
        -ArtifactPath (Join-Path $root 'artifacts/release/agent-control-linux-x64.zip') `
        -ReceiptPath $(if ($ResumeReceiptPath) { $ResumeReceiptPath } else { Join-Path $scratch "$Name-receipt.json" }) `
        -ResumeReceiptPath $ResumeReceiptPath -RequestedAction $Action -QualificationTargets $null
    $script:Contexts.Add($context)
    if ($Action -in @('Deploy', 'Recover')) { New-SmokeReceipt $context "$Name-auth-smoke.json" | Out-Null }
    return $context
}

try {
    $parseErrors = $null
    foreach ($file in @((Join-Path $root 'deploy-azure.ps1'), (Join-Path $root 'scripts/azure-deployment.ps1'))) {
        [Management.Automation.Language.Parser]::ParseFile($file, [ref]$null, [ref]$parseErrors) | Out-Null
        Assert-True (@($parseErrors).Count -eq 0) "PowerShell syntax failed for $file"
    }
    $bicep = Get-Content -LiteralPath (Join-Path $root 'infra/main.bicep') -Raw
    Assert-True (-not $bicep.Contains("categoryGroup: 'allLogs'") -and
        $bicep.Contains("category: 'AppServiceConsoleLogs'") -and
        $bicep.Contains("logAnalyticsDestinationType: 'Dedicated'") -and
        -not $bicep.Contains("category: 'PostgreSQLLogs'") -and -not $bicep.Contains('PostgreSQLFlexQuery')) `
        'Diagnostics do not enforce the exact redacted Dedicated console/metrics-only contract.'
    Assert-True ($bicep.Contains("name: 'MAINTENANCE_MODE'") -and $bicep.Contains("value: 'true'") -and
        $bicep.Contains("metricName: 'HealthCheckStatus'") -and
        $bicep.Contains('parse_json(ResultDescription).event') -and -not $bicep.Contains('ResultDescription has_any')) `
        'Bicep containment, silent-availability, or structured-event monitoring contract is incomplete.'

    $target = New-Target
    Assert-True ((Test-ApprovedAzureTarget $target Mock).expectedSchemaVersion -eq 26) 'Valid target was rejected.'
    foreach ($case in @(
        @{ mutate = { param($t) $t.isApproval = $false }; error = 'isApproval' },
        @{ mutate = { param($t) $t.estimate.monthlyTotal = 9 }; error = 'total' },
        @{ mutate = { param($t) $t.resources.postgresFlexibleServer.sku = 'Standard_D2s_v3' }; error = 'renewed estimate' },
        @{ mutate = { param($t) $t.resources.approvedAppOutboundIpv4Addresses = @() }; error = 'outbound' }
    )) {
        $invalid = Copy-Object $target
        & $case.mutate $invalid
        Assert-Fails { Test-ApprovedAzureTarget $invalid Mock } $case.error
    }
    $changedVersion = Copy-Object $target
    $changedVersion.preparedVaultContract.versions[5].version = 'fixtureversion2'
    Assert-Fails { Test-ApprovedAzureTarget $changedVersion Mock } 'Phase 11 coordinated-rotation prerequisite'
    Assert-True (-not (Get-Content -LiteralPath (Join-Path $root 'deploy-azure.ps1') -Raw).Contains('CredentialRotation')) 'Wizard still exposes credential rotation.'

    $skuFixture = New-Fixture $target
    $skuContext = New-Context $target $skuFixture 'sku'
    Assert-True ((Invoke-DeploymentOperation $skuContext sku_pricing_preflight).regionalSkuChecked) 'Pinned CLI capability structure was rejected.'
    $badSkuFixture = New-Fixture $target
    $badSkuFixture.commands.sku_pricing_preflight[0].json = @(@{ name = 'Standard_B1ms'; tier = 'Burstable'; supportedServerVersions = @('17') })
    $badSku = New-Context $target $badSkuFixture 'sku-top-level'
    Assert-Fails { Invoke-DeploymentOperation $badSku sku_pricing_preflight } 'capability evidence is unavailable'
    foreach ($mutation in @('tier', 'sku', 'version')) {
        $fixture = New-Fixture $target
        if ($mutation -eq 'tier') { $fixture.commands.sku_pricing_preflight[0].json.supportedServerEditions[0].name = 'GeneralPurpose' }
        if ($mutation -eq 'sku') { $fixture.commands.sku_pricing_preflight[0].json.supportedServerEditions[0].supportedServerSkus[0].name = 'Standard_B2s' }
        if ($mutation -eq 'version') { $fixture.commands.sku_pricing_preflight[0].json.supportedServerEditions[0].supportedServerSkus[0].supportedServerVersions = @(@{ name = '16' }) }
        Assert-Fails { Invoke-DeploymentOperation (New-Context $target $fixture "sku-$mutation") sku_pricing_preflight } 'capability evidence is unavailable'
    }

    $runtimeDefault = New-Context $target (New-Fixture $target) 'runtime-default'
    Set-SyntheticBootstrapSecrets $runtimeDefault
    Assert-True ((Invoke-DeploymentOperation $runtimeDefault runtime_access_verify).runtimeSecretCount -eq 5) 'Default native-reference/admin exclusion failed.'
    Remove-AzureSensitiveDirectories $runtimeDefault

    $backupDefault = New-Context $target (New-Fixture $target) 'backup-default'
    Assert-True ((Invoke-DeploymentOperation $backupDefault backup_health_verify).status -eq 'completed') 'Default release-backup health proof failed.'

    $context = New-Context $target (New-Fixture $target) 'upgrade'
    Assert-True ((Test-AuthenticationSmokeReceipt $context '').authentication -eq 'human-approved-contract') 'Synthetic authentication receipt contract was rejected.'
    $receipt = Invoke-AzureDeployment $context Deploy
    Assert-True ($receipt.status -eq 'deployed') 'Command-level upgrade did not complete.'
    $calls = @($context.Calls)
    foreach ($required in @('enter_maintenance', 'managed_backup', 'backup_health_verify', 'resource_deploy', 'database_migrate', 'start_contained',
        'contained_smoke', 'authentication_smoke_verify', 'database_reopen', 'open_and_verify', 'cleanup')) {
        Assert-True ($required -in $calls) "Upgrade omitted $required."
    }
    Assert-True ($receipt.evidence.resource_deploy.admission -eq 'closed' -and $receipt.evidence.resource_deploy.app -eq 'stopped' -and
        $receipt.evidence.backup_health_verify.status -eq 'completed') 'Resource deployment or release backup was not proven contained.'
    Assert-True ([array]::IndexOf($calls, 'contained_smoke') -lt [array]::IndexOf($calls, 'database_reopen') -and
        [array]::IndexOf($calls, 'database_reopen') -lt [array]::IndexOf($calls, 'open_and_verify')) 'Public admission opened before contained/auth/database sequencing.'
    Assert-True ($receipt.evidence.open_and_verify.loginProof -eq 'human-approved-receipt') 'Liveness was mislabeled as login proof.'
    Assert-True (@($context.Owned).Count -eq 0) 'Upgrade left an owned resource.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root "artifacts/azure-bootstrap/$($context.RunId)"))) 'Bootstrap secrets were not cleaned.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root "artifacts/azure-parameters/$($context.RunId)"))) 'Parameter files were not cleaned.'

    $materialContext = New-Context $target (New-Fixture $target) 'materialization'
    $script:ActiveAzureContext = $materialContext
    $materialContext.ActiveOperation = 'database_preflight'
    try {
        New-AzureParameterFile $materialContext | Out-Null
        Assert-True (-not $materialContext.BootstrapSecretsMaterialized -and -not $materialContext.BootstrapDirectory) 'Parameter generation incorrectly claimed secret materialization.'
        $materialContext.SecretValues = @{
            'agent-control-postgres-admin-password' = 'synthetic-admin-password-at-least-thirty-two-characters'
            'agent-control-postgres-app-password' = 'synthetic-runtime-password-at-least-thirty-two-characters'
        }
        Invoke-AzureDatabaseContainer $materialContext @('backend/scripts/azure-database.ts', 'preflight', 'upgrade', '26') | Out-Null
        Assert-True ((Test-Path -LiteralPath (Join-Path $materialContext.BootstrapDirectory 'postgres-admin')) -and
            (Test-Path -LiteralPath (Join-Path $materialContext.BootstrapDirectory 'postgres-app'))) 'Database command did not receive actual secret files.'
    } finally {
        $script:ActiveAzureContext = $null
        Remove-AzureSensitiveDirectories $materialContext
    }
    Assert-True (-not $materialContext.BootstrapDirectory -and -not $materialContext.ParameterDirectory) 'Sensitive material cleanup did not converge.'

    $delayedFixture = New-Fixture $target
    Add-RuntimeCommands $delayedFixture $target @((ReferenceStatus $target 'Pending'), (ReferenceStatus $target 'Resolved'))
    $delayed = New-Context $target $delayedFixture 'runtime-delayed'
    Set-SyntheticBootstrapSecrets $delayed
    Assert-True ((Invoke-DeploymentOperation $delayed runtime_access_verify).propagationAttempts -eq 2) 'Bounded reference propagation was not retried.'
    $mismatchFixture = New-Fixture $target
    Add-RuntimeCommands $mismatchFixture $target @((ReferenceStatus $target 'Resolved' 'CLIENT_SECRET'), (ReferenceStatus $target 'Resolved' 'CLIENT_SECRET'),
        (ReferenceStatus $target 'Resolved' 'CLIENT_SECRET'), (ReferenceStatus $target 'Resolved' 'CLIENT_SECRET'), (ReferenceStatus $target 'Resolved' 'CLIENT_SECRET'))
    $mismatch = New-Context $target $mismatchFixture 'runtime-mismatch'
    Set-SyntheticBootstrapSecrets $mismatch
    Assert-Fails { Invoke-DeploymentOperation $mismatch runtime_access_verify } 'including CLIENT_SECRET'
    $deniedFixture = New-Fixture $target
    Add-RuntimeCommands $deniedFixture $target @(3, 3, 3, 3, 3)
    $denied = New-Context $target $deniedFixture 'runtime-denied'
    Set-SyntheticBootstrapSecrets $denied
    Assert-Fails { Invoke-DeploymentOperation $denied runtime_access_verify } 'including CLIENT_SECRET'
    $networkFixture = New-Fixture $target
    Add-RuntimeCommands $networkFixture $target @(7, 7, 7, 7, 7)
    $network = New-Context $target $networkFixture 'runtime-network'
    Set-SyntheticBootstrapSecrets $network
    Assert-Fails { Invoke-DeploymentOperation $network runtime_access_verify } 'including CLIENT_SECRET'
    $adminAccessFixture = New-Fixture $target
    $adminAccessFixture.commands.runtime_access_verify[-2].json = @(@{ roleDefinitionId = 'fixture-custom-secret-reader' })
    Add-Az $adminAccessFixture runtime_access_verify @('role', 'definition', 'list', '--name', 'fixture-custom-secret-reader') -Json @(@{
        permissions = @(@{ dataActions = @('Microsoft.KeyVault/vaults/secrets/getSecret/action'); notDataActions = @() })
    })
    $runtimeDatabaseCommand = $adminAccessFixture.commands.runtime_access_verify[-2]
    $roleDefinitionCommand = $adminAccessFixture.commands.runtime_access_verify[-1]
    $adminAccessFixture.commands.runtime_access_verify[-2] = $roleDefinitionCommand
    $adminAccessFixture.commands.runtime_access_verify[-1] = $runtimeDatabaseCommand
    $adminAccess = New-Context $target $adminAccessFixture 'runtime-admin-access'
    Set-SyntheticBootstrapSecrets $adminAccess
    Assert-Fails { Invoke-DeploymentOperation $adminAccess runtime_access_verify } 'inherited access'

    $unexpectedFixture = New-Fixture $target
    $unexpectedFixture.commands.operator_identity[0].executable = 'not-az'
    Assert-Fails { Invoke-DeploymentOperation (New-Context $target $unexpectedFixture 'unexpected-command') operator_identity } 'Mock rejected unexpected command'

    $delayedBackupFixture = New-Fixture $target
    $backupCommand = $delayedBackupFixture.commands.backup_health_verify[0]
    $delayedBackupFixture.commands.backup_health_verify = @()
    Add-Az $delayedBackupFixture backup_health_verify @($backupCommand.arguments[0..($backupCommand.arguments.Count - 4)]) -Json @{} -ExitCode 3
    $delayedBackupFixture.commands.backup_health_verify += $backupCommand
    $delayedBackup = New-Context $target $delayedBackupFixture 'backup-delayed'
    Assert-True ((Invoke-DeploymentOperation $delayedBackup backup_health_verify).attempts -eq 2) 'Backup health probe did not retry a delayed control-plane restore point.'
    $missingBackupFixture = New-Fixture $target
    $backupArguments = @($missingBackupFixture.commands.backup_health_verify[0].arguments[0..($missingBackupFixture.commands.backup_health_verify[0].arguments.Count - 4)])
    $missingBackupFixture.commands.backup_health_verify = @()
    foreach ($attempt in 1..20) { Add-Az $missingBackupFixture backup_health_verify $backupArguments -Json @{} -ExitCode 3 }
    Assert-Fails { Invoke-DeploymentOperation (New-Context $target $missingBackupFixture 'backup-missing') backup_health_verify } 'bounded probe'
    $wrongBackupFixture = New-Fixture $target
    $wrongBackupFixture.commands.backup_health_verify[0].json.source = "$($target.expectedResourceIds.postgresFlexibleServer)-other"
    $wrongBackupFixture.commands.backup_health_verify = @(1..20 | ForEach-Object { $wrongBackupFixture.commands.backup_health_verify[0] })
    Assert-Fails { Invoke-DeploymentOperation (New-Context $target $wrongBackupFixture 'backup-wrong-source') backup_health_verify } 'source=False'
    $failedBackupFixture = New-Fixture $target
    $failedBackupFixture.commands.backup_health_verify[0].json.status = 'Failed'
    $failedBackupFixture.commands.backup_health_verify = @(1..20 | ForEach-Object { $failedBackupFixture.commands.backup_health_verify[0] })
    Assert-Fails { Invoke-DeploymentOperation (New-Context $target $failedBackupFixture 'backup-failed-state') backup_health_verify } 'state=Failed'
    $monitoringMismatch = New-Fixture $target
    $monitoringMismatch.commands.monitoring_verify[2].json[0].criteria.allOf[0].threshold = 99
    Assert-Fails { Invoke-DeploymentOperation (New-Context $target $monitoringMismatch 'monitoring-mismatch') monitoring_verify } 'finite threshold'
    $rawLogFixture = New-Fixture $target
    $rawLogFixture.commands.monitoring_verify[0].json.logs[0].category = 'AppServiceHTTPLogs'
    Assert-Fails { Invoke-DeploymentOperation (New-Context $target $rawLogFixture 'monitoring-raw-log') monitoring_verify } 'redacted console'
    $logThresholdFixture = New-Fixture $target
    $logThresholdFixture.commands.monitoring_verify[3].json[2].criteria.allOf[0].threshold = 1
    Assert-Fails { Invoke-DeploymentOperation (New-Context $target $logThresholdFixture 'monitoring-log-threshold') monitoring_verify } 'finite threshold'

    $freshTarget = New-Target fresh
    $fresh = New-Context $freshTarget (New-Fixture $freshTarget) 'fresh'
    Assert-True ((Invoke-AzureDeployment $fresh Deploy).status -eq 'deployed') 'Fresh command-level workflow failed.'
    Assert-True ('managed_backup' -in @($fresh.Calls) -and 'backup_health_verify' -in @($fresh.Calls) -and
        [array]::IndexOf(@($fresh.Calls), 'database_migrate') -lt [array]::IndexOf(@($fresh.Calls), 'managed_backup') -and
        'enter_maintenance' -in @($fresh.Calls)) 'Fresh workflow did not contain and back up the initialized database before opening.'

    $containmentFixture = New-Fixture $freshTarget
    $containmentFixture.commands.resource_deploy[2].exitCode = 9
    $containmentReceiptPath = Join-Path $scratch 'resource-deploy-containment-receipt.json'
    $containmentContext = New-Context $freshTarget $containmentFixture 'resource-deploy-containment'
    $containmentContext.ReceiptPath = $containmentReceiptPath
    Assert-Fails { Invoke-AzureDeployment $containmentContext Deploy } 'stopped'
    $containmentReceipt = Get-Content -LiteralPath $containmentReceiptPath -Raw | ConvertFrom-Json
    Assert-True ($containmentReceipt.failedStep -eq 'resource_deploy' -and
        $containmentReceipt.evidence.containment.admission -eq 'closed' -and
        $containmentReceipt.evidence.containment.app -eq 'stopped') `
        'Post-resource-write containment failure did not explicitly reclose and stop the app.'

    $pitrContext = New-Context $target (New-Fixture $target -Pitr) 'pitr' 'PointInTimeRestore'
    $restorePoint = [DateTimeOffset]::UtcNow.AddMinutes(-10).ToString('o')
    foreach ($command in @($pitrContext.MockFixture.commands.pitr_restore) + @($pitrContext.MockFixture.commands.pitr_validate_review)) {
        $command.arguments = @($command.arguments | ForEach-Object { ([string]$_).Replace('{{RESTORE_POINT}}', $restorePoint) })
    }
    Assert-True ((Invoke-AzureDeployment $pitrContext PointInTimeRestore -RestorePoint $restorePoint).status -eq 'pitr_rehearsal_succeeded') 'PITR command-level workflow failed.'

    $recoveryContext = New-Context $target (New-Fixture $target -Recovery) 'recovery' 'Recover'
    foreach ($command in @($recoveryContext.MockFixture.commands.pitr_restore) + @($recoveryContext.MockFixture.commands.pitr_validate_review)) {
        $command.arguments = @($command.arguments | ForEach-Object { ([string]$_).Replace('{{RESTORE_POINT}}', $restorePoint) })
    }
    $recoveryReceipt = Invoke-AzureDeployment $recoveryContext Recover -RestorePoint $restorePoint
    Assert-True ($recoveryReceipt.status -eq 'recovered') 'Recovery command-level workflow failed.'
    Assert-True ([array]::IndexOf(@($recoveryContext.Calls), 'recovery_switch') -lt [array]::IndexOf(@($recoveryContext.Calls), 'start_contained') -and
        [array]::IndexOf(@($recoveryContext.Calls), 'contained_smoke') -lt [array]::IndexOf(@($recoveryContext.Calls), 'database_reopen')) 'Recovery opened restored data before contained review.'

    $openFailureFixture = New-Fixture $target
    $openAz = $openFailureFixture.commands.open_and_verify[0]
    $failedReady = Copy-Object $openFailureFixture.commands.open_and_verify[1]
    $openAuth = Copy-Object $openFailureFixture.commands.open_and_verify[2]
    $failedReady.exitCode = 503
    $failedReady.output = '{"ok":false}'
    $openFailureFixture.commands.open_and_verify = @($openAz) + @(1..5 | ForEach-Object { Copy-Object $failedReady }) + @($openAuth)
    $openFailure = New-Context $target $openFailureFixture 'open-failure'
    Assert-Fails { Invoke-AzureDeployment $openFailure Deploy } 'stopped'
    $openFailureReceipt = Get-Content -LiteralPath $openFailure.ReceiptPath -Raw | ConvertFrom-Json
    Assert-True ($openFailureReceipt.failedStep -eq 'open_and_verify' -and $openFailureReceipt.evidence.containment.admission -eq 'closed' -and
        $openFailureReceipt.evidence.containment.app -eq 'stopped') 'Post-open failure did not truthfully contain and stop the app.'
    $recoveryFailureFixture = New-Fixture $target -Recovery
    foreach ($command in @($recoveryFailureFixture.commands.pitr_restore) + @($recoveryFailureFixture.commands.pitr_validate_review)) {
        $command.arguments = @($command.arguments | ForEach-Object { ([string]$_).Replace('{{RESTORE_POINT}}', $restorePoint) })
    }
    $recoveryOpenAz = $recoveryFailureFixture.commands.open_and_verify[0]
    $recoveryFailedReady = Copy-Object $recoveryFailureFixture.commands.open_and_verify[1]
    $recoveryOpenAuth = Copy-Object $recoveryFailureFixture.commands.open_and_verify[2]
    $recoveryFailedReady.exitCode = 503
    $recoveryFailedReady.output = '{"ok":false}'
    $recoveryFailureFixture.commands.open_and_verify = @($recoveryOpenAz) + @(1..5 | ForEach-Object { Copy-Object $recoveryFailedReady }) + @($recoveryOpenAuth)
    $recoveryFailure = New-Context $target $recoveryFailureFixture 'recovery-open-failure' 'Recover'
    Assert-Fails { Invoke-AzureDeployment $recoveryFailure Recover -RestorePoint $restorePoint } 'stopped'
    $recoveryFailureReceipt = Get-Content -LiteralPath $recoveryFailure.ReceiptPath -Raw | ConvertFrom-Json
    Assert-True ($recoveryFailureReceipt.failedStep -eq 'open_and_verify' -and $recoveryFailureReceipt.evidence.containment.admission -eq 'closed' -and
        $recoveryFailureReceipt.evidence.containment.app -eq 'stopped' -and $recoveryFailureReceipt.evidence.recovery_switch.oldServerRetained -eq $true) `
        'Recovery post-open failure did not retain the source and contain the restored target.'

    $freshFailureFixture = New-Fixture $freshTarget
    $freshFailureFixture.commands.database_preflight[0].exitCode = 9
    $firstReceiptPath = Join-Path $scratch 'fresh-resume-receipt.json'
    $firstContext = New-Context $freshTarget $freshFailureFixture 'fresh-before-bootstrap'
    $firstContext.ReceiptPath = $firstReceiptPath
    Assert-Fails { Invoke-AzureDeployment $firstContext Deploy } 'stopped'
    $firstReceipt = Get-Content -LiteralPath $firstReceiptPath -Raw | ConvertFrom-Json
    Assert-True ('resource_deploy' -in @($firstReceipt.completedSteps) -and 'database_migrate' -notin @($firstReceipt.completedSteps)) 'Fresh pre-bootstrap interruption receipt is incomplete.'
    $uncontainedReceiptPath = Join-Path $scratch 'fresh-uncontained-resume-receipt.json'
    Copy-Item -LiteralPath $firstReceiptPath -Destination $uncontainedReceiptPath
    $uncontainedFixture = New-Fixture $freshTarget -FreshResourcesExist
    $uncontainedFixture.commands.resume_verify[-1].json.state = 'Running'
    $uncontained = New-Context $freshTarget $uncontainedFixture 'fresh-uncontained-resume' 'Deploy' $uncontainedReceiptPath
    Assert-Fails { Invoke-AzureDeployment $uncontained Deploy } 'stopped'
    $uncontainedReceipt = Get-Content -LiteralPath $uncontainedReceiptPath -Raw | ConvertFrom-Json
    Assert-True ($uncontainedReceipt.failedStep -eq 'resume_verify' -and
        $uncontainedReceipt.evidence.containment.admission -eq 'closed' -and
        $uncontainedReceipt.evidence.containment.app -eq 'stopped') `
        "Fresh resume accepted an uncontained app or failed to restore containment: $($uncontainedReceipt.evidence | ConvertTo-Json -Depth 5 -Compress)"
    $resumeFixture = New-Fixture $freshTarget -FreshResourcesExist
    $resume = New-Context $freshTarget $resumeFixture 'fresh-resume-before-bootstrap' 'Deploy' $firstReceiptPath
    New-SmokeReceipt $resume 'fresh-resume-before-bootstrap-auth.json' | Out-Null
    Assert-True ((Invoke-AzureDeployment $resume Deploy).status -eq 'deployed') 'Receipt-bound fresh pre-bootstrap resume failed.'
    Assert-True ('resume-skip:resource_deploy' -in @($resume.Calls)) 'Fresh resume replayed resource deployment.'

    $postBootstrapFixture = New-Fixture $freshTarget
    $postBootstrapFixture.commands.runtime_access_verify[0].exitCode = 9
    $postBootstrapReceiptPath = Join-Path $scratch 'fresh-post-bootstrap-receipt.json'
    $postBootstrap = New-Context $freshTarget $postBootstrapFixture 'fresh-post-bootstrap'
    $postBootstrap.ReceiptPath = $postBootstrapReceiptPath
    Assert-Fails { Invoke-AzureDeployment $postBootstrap Deploy } 'stopped'
    $postReceipt = Get-Content -LiteralPath $postBootstrapReceiptPath -Raw | ConvertFrom-Json
    Assert-True ('database_migrate' -in @($postReceipt.completedSteps) -and 'package_deploy' -in @($postReceipt.completedSteps)) 'Post-bootstrap interruption lost completed write evidence.'
    $postResumeFixture = New-Fixture $freshTarget -FreshResourcesExist -ResumeDatabaseInitialized
    $postResume = New-Context $freshTarget $postResumeFixture 'fresh-post-bootstrap-resume' 'Deploy' $postBootstrapReceiptPath
    New-SmokeReceipt $postResume 'fresh-post-bootstrap-resume-auth.json' | Out-Null
    Assert-True ((Invoke-AzureDeployment $postResume Deploy).status -eq 'deployed') 'Receipt-bound post-bootstrap resume failed.'
    Assert-True ('resume-skip:database_migrate' -in @($postResume.Calls) -and 'resume-skip:package_deploy' -in @($postResume.Calls)) 'Post-bootstrap resume replayed completed writes.'

    foreach ($processCase in @(
        @{ name = 'process-before-bootstrap'; failureOperation = 'database_preflight'; initialized = $false },
        @{ name = 'process-after-bootstrap'; failureOperation = 'runtime_access_verify'; initialized = $true }
    )) {
        $processTargetPath = Save-Json $freshTarget "$($processCase.name)-target.json"
        $processReceiptPath = Join-Path $scratch "$($processCase.name)-receipt.json"
        $processFailureFixture = New-Fixture $freshTarget
        $processFailureFixture.commands.($processCase.failureOperation)[0].exitCode = 9
        $processFailurePath = Save-Json $processFailureFixture "$($processCase.name)-failure-fixture.json"
        & (Get-Command pwsh).Source -NoProfile -File (Join-Path $root 'deploy-azure.ps1') -Action Deploy -ExecutionMode Mock `
            -TargetFile $processTargetPath -MockFixturePath $processFailurePath `
            -ArtifactPath (Join-Path $root 'artifacts/release/agent-control-linux-x64.zip') -ReceiptPath $processReceiptPath 2>$null | Out-Null
        Assert-True ($LASTEXITCODE -eq 1) "$($processCase.name) did not stop at its injected process failure."
        $processFailureReceipt = Get-Content -LiteralPath $processReceiptPath -Raw | ConvertFrom-Json
        $processResumeFixture = New-Fixture $freshTarget -FreshResourcesExist -ResumeDatabaseInitialized:$processCase.initialized
        $processCommandLog = Join-Path $scratch "$($processCase.name)-commands.jsonl"
        $processResumeFixture.commandLogPath = $processCommandLog
        $processResumePath = Save-Json $processResumeFixture "$($processCase.name)-resume-fixture.json"
        $processValidatedTarget = Read-ApprovedAzureTarget $processTargetPath Mock
        $processAuthPath = Save-SmokeReceiptForRun $processValidatedTarget $processFailureReceipt.runId "$($processCase.name)-auth.json"
        & (Get-Command pwsh).Source -NoProfile -File (Join-Path $root 'deploy-azure.ps1') -Action Deploy -ExecutionMode Mock `
            -TargetFile $processTargetPath -MockFixturePath $processResumePath `
            -ArtifactPath (Join-Path $root 'artifacts/release/agent-control-linux-x64.zip') -ReceiptPath $processReceiptPath `
            -ResumeReceiptPath $processReceiptPath -AuthenticationSmokeReceiptPath $processAuthPath | Out-Null
        Assert-True ($LASTEXITCODE -eq 0 -and (Get-Content -LiteralPath $processReceiptPath -Raw | ConvertFrom-Json).status -eq 'deployed') `
            "$($processCase.name) did not resume across process invocations."
        $processLog = Get-Content -LiteralPath $processCommandLog -Raw
        Assert-True (-not $processLog.Contains('"operation":"resource_deploy"') -and
            (-not $processCase.initialized -or -not $processLog.Contains('"operation":"database_migrate"'))) `
            "$($processCase.name) replayed a completed external write across processes."
    }

    $cleanupFixture = New-Fixture $target
    $cleanupFixture.commands.runtime_access_verify[0].exitCode = 9
    $cleanupFixture.commands.cleanup[0].exitCode = 9
    $cleanupReceiptPath = Join-Path $scratch 'cleanup-resume-receipt.json'
    $cleanupFailure = New-Context $target $cleanupFixture 'cleanup-failure'
    $cleanupFailure.ReceiptPath = $cleanupReceiptPath
    Assert-Fails { Invoke-AzureDeployment $cleanupFailure Deploy } 'stopped'
    $failedCleanupReceipt = Get-Content -LiteralPath $cleanupReceiptPath -Raw | ConvertFrom-Json
    Assert-True ($failedCleanupReceipt.status -eq 'cleanup_failed' -and @($failedCleanupReceipt.ownedResourcesRemaining).Count -eq 1) 'Failed cleanup discarded unresolved ownership.'
    $cleanupOnly = [ordered]@{ fixtureVersion = 2; rejectUnexpected = $true; commands = [ordered]@{ cleanup = @() } }
    Add-Az $cleanupOnly cleanup @('postgres', 'flexible-server', 'firewall-rule', 'delete', '--yes', '--subscription',
        $target.subscriptionId, '--resource-group', $target.resourceGroup, '--name', $target.resources.postgresFlexibleServer.name,
        '--rule-name', 'wizard-{{RUN_ID}}') -Json @{}
    $cleanupContext = New-Context $target $cleanupOnly 'cleanup-resume' 'Cleanup' $cleanupReceiptPath
    Assert-True ((Invoke-AzureDeployment $cleanupContext Cleanup).status -eq 'cleanup_succeeded') 'Receipt-bound process cleanup failed.'
    Assert-True (@((Get-Content -LiteralPath $cleanupReceiptPath -Raw | ConvertFrom-Json).ownedResourcesRemaining).Count -eq 0) 'Cleanup receipt retained deleted ownership.'
    Assert-Fails {
        New-AzureDeploymentContext -Root $root -Target $target -ExecutionMode Mock -MockFixturePath (Save-Json $cleanupOnly 'empty-cleanup.json') `
            -ArtifactPath (Join-Path $root 'artifacts/release/agent-control-linux-x64.zip') -ReceiptPath (Join-Path $scratch 'empty.json') -RequestedAction Cleanup
    } 'requires -ResumeReceiptPath'

    $processCleanupTarget = Save-Json $target 'process-cleanup-target.json'
    $processCleanupReceipt = Join-Path $scratch 'process-cleanup-receipt.json'
    $processCleanupFailure = New-Fixture $target
    $processCleanupFailure.commands.runtime_access_verify[0].exitCode = 9
    $processCleanupFailure.commands.cleanup[0].exitCode = 9
    $processCleanupFailurePath = Save-Json $processCleanupFailure 'process-cleanup-failure-fixture.json'
    & (Get-Command pwsh).Source -NoProfile -File (Join-Path $root 'deploy-azure.ps1') -Action Deploy -ExecutionMode Mock `
        -TargetFile $processCleanupTarget -MockFixturePath $processCleanupFailurePath `
        -ArtifactPath (Join-Path $root 'artifacts/release/agent-control-linux-x64.zip') -ReceiptPath $processCleanupReceipt 2>$null | Out-Null
    Assert-True ($LASTEXITCODE -eq 1 -and (Get-Content -LiteralPath $processCleanupReceipt -Raw | ConvertFrom-Json).status -eq 'cleanup_failed') `
        'Process interruption did not preserve failed cleanup ownership.'
    $processCleanupOnly = [ordered]@{ fixtureVersion = 2; rejectUnexpected = $true; commands = [ordered]@{ cleanup = @() } }
    Add-Az $processCleanupOnly cleanup @('postgres', 'flexible-server', 'firewall-rule', 'delete', '--yes', '--subscription',
        $target.subscriptionId, '--resource-group', $target.resourceGroup, '--name', $target.resources.postgresFlexibleServer.name,
        '--rule-name', 'wizard-{{RUN_ID}}') -Json @{}
    $processCleanupOnlyPath = Save-Json $processCleanupOnly 'process-cleanup-resume-fixture.json'
    & (Get-Command pwsh).Source -NoProfile -File (Join-Path $root 'deploy-azure.ps1') -Action Cleanup -ExecutionMode Mock `
        -TargetFile $processCleanupTarget -MockFixturePath $processCleanupOnlyPath `
        -ArtifactPath (Join-Path $root 'artifacts/release/agent-control-linux-x64.zip') -ReceiptPath $processCleanupReceipt `
        -ResumeReceiptPath $processCleanupReceipt | Out-Null
    Assert-True ($LASTEXITCODE -eq 0 -and (Get-Content -LiteralPath $processCleanupReceipt -Raw | ConvertFrom-Json).status -eq 'cleanup_succeeded') `
        'Explicit cleanup did not rehydrate the exact receipt in a new process.'

    $parameterTarget = New-Target
    $parameterFixturePath = Save-Json (New-Fixture $parameterTarget) 'named-parameters-fixture.json'
    $namedReceipt = Join-Path $scratch 'named-parameters-receipt.json'
    $itemsJson = $parameterTarget.estimate.items | ConvertTo-Json -Compress
    $versionsJson = $parameterTarget.preparedVaultContract.versions | ConvertTo-Json -Compress
    $existingJson = $parameterTarget.preparedVaultContract.existingVersions | ConvertTo-Json -Compress
    & (Get-Command pwsh).Source -NoProfile -File (Join-Path $root 'deploy-azure.ps1') -Action Plan -ExecutionMode Mock `
        -MockFixturePath $parameterFixturePath -ArtifactPath (Join-Path $root 'artifacts/release/agent-control-linux-x64.zip') -ReceiptPath $namedReceipt `
        -TenantId $parameterTarget.tenantId -SubscriptionId $parameterTarget.subscriptionId -ResourceGroupName $parameterTarget.resourceGroup `
        -Region $parameterTarget.region -AppRegistrationClientId $parameterTarget.entraApplicationId `
        -AppServicePlanName $parameterTarget.resources.appServicePlan.name -AppServiceName $parameterTarget.resources.appService.name `
        -PostgresServerName $parameterTarget.resources.postgresFlexibleServer.name -ExistingVaultResourceId $parameterTarget.existingVaultResourceId `
        -CanonicalOrigin $parameterTarget.canonicalOrigin -InstallationMode upgrade -ExpectedSchemaVersion 26 `
        -AppOutboundIpv4Addresses $parameterTarget.resources.approvedAppOutboundIpv4Addresses -RunnerIpv4Address $parameterTarget.runnerIpv4Address `
        -ActionGroupResourceId $parameterTarget.resources.monitoring.actionGroupResourceId -EstimateAsOfDate $parameterTarget.estimate.asOfDate `
        -EstimateSource $parameterTarget.estimate.source -EstimateCurrency $parameterTarget.estimate.currency -EstimateItemsJson $itemsJson `
        -ApprovedMonthlyBudget 10 -BudgetStartDate $parameterTarget.resources.monitoring.budgetStartDate `
        -BudgetEndDate $parameterTarget.resources.monitoring.budgetEndDate -MaintenanceWindowStartsAt $parameterTarget.maintenanceApproval.windowStartsAt `
        -MaintenanceWindowEndsAt $parameterTarget.maintenanceApproval.windowEndsAt -ApprovedBy $parameterTarget.operatorApproval.approvedBy `
        -ApprovedAt $parameterTarget.operatorApproval.approvedAt -ApprovalReference $parameterTarget.operatorApproval.changeReference `
        -BurstableRiskAcceptanceReference $parameterTarget.riskAcceptance.reference -SecretVersionsJson $versionsJson -ExistingSecretVersionsJson $existingJson | Out-Null
    Assert-True ($LASTEXITCODE -eq 0 -and (Get-Content -LiteralPath $namedReceipt -Raw | ConvertFrom-Json).status -eq 'previewed_not_deployed') 'Complete named parameters prompted or diverged from target-file execution.'

    Write-Host "Passed $script:Checks Azure deployment command-level assertions."
} catch {
    Get-ChildItem -LiteralPath $scratch -Filter '*receipt.json' -ErrorAction SilentlyContinue | ForEach-Object {
        $failedReceipt = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
        if ($failedReceipt.status -in @('failed', 'cleanup_failed')) { Write-Host "$($_.Name): $($failedReceipt.evidence.errorCode)" }
    }
    Write-Host $_.ScriptStackTrace
    throw
} finally {
    $script:ActiveAzureContext = $null
    foreach ($context in $script:Contexts) { Remove-AzureSensitiveDirectories $context }
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
    if ((Test-Path -LiteralPath $scratchRoot) -and -not (Get-ChildItem -LiteralPath $scratchRoot -Force)) {
        Remove-Item -LiteralPath $scratchRoot
    }
}
