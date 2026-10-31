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
    param([ValidateSet('fresh', 'existing')][string]$Mode = 'existing')
    $tenant = '11111111-1111-4111-8111-111111111111'
    $subscription = '22222222-2222-4222-8222-222222222222'
    $group = 'fixture-agent-control'
    $plan = 'fixture-agent-control-plan'
    $app = 'fixture-agent-control-app'
    $postgres = 'fixture-agent-control-postgres'
    $secretNames = @($script:RequiredSecretNames)
    $versions = @($secretNames | ForEach-Object { [PSCustomObject]@{ name = $_; version = 'fixtureversion1' } })
    return [PSCustomObject]@{
        contractVersion = 2
        isApproval = $true
        tenantId = $tenant
        subscriptionId = $subscription
        resourceGroup = $group
        region = 'fixtureregion'
        entraApplicationId = '33333333-3333-4333-8333-333333333333'
        tenantRegistrySecretName = 'agent-control-tenants-json'
        tenantRegistryRegistrationApprovalReference = 'fixture-every-tenant-registration-approval'
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
        runnerIpv4Address = '192.0.2.10'
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
        preparedVaultContract = [PSCustomObject]@{
            secretNames = $secretNames
            runtimeConsumers = @($secretNames | Where-Object { $_ -cne 'agent-control-postgres-admin-password' })
            administratorPasswordRuntimeAccessible = $false
            bootstrapSecretCleanupRequired = $true
            versions = @($versions)
            existingVersions = $(if ($Mode -eq 'fresh') { @() } else { @($versions | ForEach-Object { [PSCustomObject]@{ name = $_.name; version = $_.version } }) })
        }
    }
}

function New-RegistryProfiles {
    param($Target)
    $profiles = @(
        @{
            tenantId = $Target.tenantId; clientId = $Target.entraApplicationId
            clientSecret = 'synthetic-fixture-agent-control-client-secret-value-that-is-long-enough-0001'
            domains = @('contoso.com'); displayName = 'Contoso'
        },
        @{
            tenantId = '88888888-8888-4888-8888-888888888888'; clientId = '99999999-9999-4999-8999-999999999999'
            clientSecret = 'synthetic-secondary-tenant-secret-never-log'; domains = @('fabrikam.com')
        }
    )
    if ($Target.mcp) { $profiles[0].integration = @{clientId=$Target.mcp.clientId;audience=$Target.mcp.apiClientId;scope='AgentControl.Access'} }
    return $profiles
}

function Add-McpTarget {
    param($Target, [string]$Mode = 'fresh')
    $prefix = "/subscriptions/$($Target.subscriptionId)/resourceGroups/$($Target.resourceGroup)/providers"
    $storage = "$prefix/Microsoft.Storage/storageAccounts/fixtureoauth"
    $mcp = [PSCustomObject]@{
        contractVersion=1; installationMode=$Mode; appServiceName='fixture-mcp'; planName='fixture-mcp-plan'; planSku='S1'
        appServiceResourceId="$prefix/Microsoft.Web/sites/fixture-mcp"; planResourceId="$prefix/Microsoft.Web/serverfarms/fixture-mcp-plan"
        identityResourceId="$prefix/Microsoft.ManagedIdentity/userAssignedIdentities/fixture-mcp"
        identityClientId='aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        registryResourceId="$prefix/Microsoft.ContainerRegistry/registries/fixtureacr"; registryLoginServer='fixtureacr.azurecr.io'
        repository='agent-control/mcp'; imageDigest=('sha256:' + ('a' * 64))
        existingImageDigest=$(if ($Mode -eq 'existing') { 'sha256:' + ('b' * 64) } else { '' })
        tenantId=$Target.tenantId; clientId='bbbb0000-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; apiClientId=$Target.entraApplicationId
        apiOrigin=$Target.canonicalOrigin; publicUrl='https://fixture-mcp.azurewebsites.net/mcp'
        callbackUri='https://fixture-mcp.azurewebsites.net/auth/callback'
        redirectUris=@('https://client.example.invalid/callback','http://localhost:53109/callback')
        storage=[PSCustomObject]@{
            accountResourceId=$storage; accountUrl='https://fixtureoauth.blob.core.windows.net'
            containerName='oauth'; containerResourceId="$storage/blobServices/default/containers/oauth"
            blobName='oauth-state.v1.fernet'
            privateEndpointResourceId="$prefix/Microsoft.Network/privateEndpoints/fixture-oauth"
            subnetResourceId="$prefix/Microsoft.Network/virtualNetworks/fixture/subnets/mcp"
            privateDnsZoneResourceId="$prefix/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net"
            privateDnsVnetLinkResourceId="$prefix/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net/virtualNetworkLinks/fixture"
            identity='https://fixtureoauth.blob.core.windows.net/oauth/oauth-state.v1.fernet'
            preparedReference='fixture-prepared-blob-dns-egress'
        }
        secrets=[PSCustomObject]@{}
        network=[PSCustomObject]@{
            inboundIpv4Cidrs=@('192.0.2.0/24'); outboundIpv4Addresses=@('192.0.2.30')
            apiReachabilityReference='fixture-authenticated-route-network-reference'; forwardedHeaders='ignored'
        }
        operationsOwner='fixture-mcp-operator'; registrationApprovalReference='fixture-exact-registration-grants'
        cost=[PSCustomObject]@{plan=1;storage=1;registry=1;network=1;monitoring=1;restoreDrill=1;monthlyTotal=6}
    }
    foreach ($key in @('client','signing','encryption')) {
        $mcp.secrets | Add-Member -NotePropertyName $key -NotePropertyValue ([PSCustomObject]@{
            name="agent-control-mcp-$key"; version='fixturemcp2'
            currentVersion=$(if ($Mode -eq 'existing') { 'fixturemcp1' } else { '' })
        })
    }
    $Target | Add-Member -NotePropertyName mcp -NotePropertyValue $mcp
    $Target.approvedMonthlyBudget=20
    return $Target
}

$script:OperationNames = @(
    'prerequisites', 'operator_identity', 'bicep_build', 'sku_pricing_preflight', 'vault_preflight',
    'registration_verify', 'qualification_preflight', 'target_inventory', 'release_inspection', 'bicep_what_if',
    'approval_checkpoint', 'resume_verify', 'resource_deploy', 'network_reconcile', 'enter_maintenance',
    'drain_verify', 'managed_backup', 'backup_health_verify', 'database_preflight', 'database_initialize',
    'package_deploy', 'runtime_access_verify', 'monitoring_verify', 'start_contained', 'contained_smoke',
    'database_reopen', 'open_and_verify',
    'pitr_restore', 'pitr_validate_review', 'recovery_switch', 'contain_runtime', 'cleanup',
    'mcp_preflight','mcp_what_if','mcp_stop','mcp_apply','mcp_start','mcp_verify','mcp_resume_verify'
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
    param($Fixture, [string]$Operation, $Target, [string[]]$Command, [string]$Server = '', [string]$CurrentServer = '', [switch]$RuntimeRole)
    $databaseServer = if ($Server) { $Server } else { $Target.resources.postgresFlexibleServer.name }
    $args = @('run', '--rm', '--platform', 'linux/amd64',
        '--mount', 'type=bind,source={{ROOT}}/artifacts/azure-bootstrap/{{RUN_ID}},target=/run/secrets,readonly',
        '-e', "PGHOST=$databaseServer.postgres.database.azure.com", '-e', 'PGPORT=5432', '-e', 'PGDATABASE=agentcontrol',
        '-e', "PGUSER=$(if ($RuntimeRole) { 'agentcontrol_app' } else { 'agentcontrol_admin' })",
        '-e', "PGPASSWORD_FILE=/run/secrets/$(if ($RuntimeRole) { 'postgres-app' } else { 'postgres-admin' })",
        '-e', 'APP_PGPASSWORD_FILE=/run/secrets/postgres-app', '-e', 'PGSSLMODE=verify-full')
    if ($CurrentServer) { $args += @('-e', "CURRENT_PGHOST=$CurrentServer.postgres.database.azure.com") }
    $args += @('agent-control-azure-operator:local') + $Command
    $evidence = if ($Command[0] -ceq 'backend/scripts/azure-database.ts' -and $Command[1] -ceq 'preflight') {
        @{mode=$Command[2];database=$Command[3];currentFingerprint=$(if ($Command[2] -ceq 'fresh') { $null } else { 'a'*64 });targetFingerprint=('a'*64);tableCount=$(if ($Command[2] -ceq 'fresh') { 0 } else { 1 })}
    } elseif ($RuntimeRole) {
        @{user='agentcontrol_app';database=$Target.expectedDatabaseName;ddlDenied=$true;auditMutationDenied=$true}
    } else { @{outcome='succeeded'} }
    Add-Command $Fixture $Operation docker $args -Json $evidence
}
function ReferenceStatus {
    param($Target, [string]$Status = 'Resolved', [string]$MismatchSetting)
    $properties = [ordered]@{}
    $map = Get-AzureRuntimeSecretReferences $Target
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
    $origin = $Target.canonicalOrigin.TrimEnd('/')
    $commands = [ordered]@{}
    foreach ($name in $script:OperationNames) { $commands[$name] = @() }
    $fixture = [ordered]@{ fixtureVersion = 2; rejectUnexpected = $true; commands = $commands }
    Add-Command $fixture prerequisites docker @('info')
    Add-Az $fixture operator_identity @('account', 'show', '--subscription', $Target.subscriptionId) -Json @{
        id = $Target.subscriptionId; tenantId = $Target.tenantId; user = @{ type = 'user' }
    }
    Add-Command $fixture bicep_build bicep @('build','{{ROOT}}/infra/main.bicep','--stdout')
    if ($Target.mcp) { Add-Command $fixture bicep_build bicep @('build','{{ROOT}}/infra/mcp.bicep','--stdout') }
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
    foreach ($name in (Get-AzureRequiredSecretNames $Target)) {
        $value = "synthetic-fixture-$name-value-that-is-long-enough-0001"
        if ($name -eq 'agent-control-tenants-json') { $value = ConvertTo-Json -InputObject @(New-RegistryProfiles $Target) -Depth 20 }
        Add-Az $fixture vault_preflight @('keyvault', 'secret', 'show', '--vault-name', 'fixture-vault', '--name', $name,
            '--version', 'fixtureversion1') -Json @{ value = $value; attributes = @{ enabled = $true; expires = [DateTimeOffset]::UtcNow.AddDays(30).ToString('o') } }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $root 'infra/entra-app-manifest.json') -Raw | ConvertFrom-Json
    $administratorRole = @($manifest.appRoles | Where-Object value -eq 'AgentControl.Admin')[0]
    $administratorRole.id = '77777777-7777-4777-8777-777777777777'
    Add-Az $fixture registration_verify @('ad', 'app', 'show', '--id', $Target.entraApplicationId) -Json @{
        appRoles = @($manifest.appRoles); web = @{ redirectUris = @($Target.callbackUri) }
    }
    Add-Az $fixture registration_verify @('ad', 'sp', 'list', '--filter', "appId eq '$($Target.entraApplicationId)'") -Json @(@{
        id = '55555555-5555-4555-8555-555555555555'; appRoleAssignmentRequired = $true
    })
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
            $(if ($Target.installationMode -ceq 'existing' -or $ResumeDatabaseInitialized) { 'existing' } else { 'fresh' }),
            $Target.expectedDatabaseName)
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
        $Target.installationMode, $Target.expectedDatabaseName)
    Add-DatabaseCommand $fixture database_initialize $Target @('backend/scripts/database.ts', 'initialize')
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
        Add-Command $fixture contained_smoke __http_get__ @("$origin$($http.path)") -Output $http.body -ExitCode $http.code
    }
    Add-DatabaseCommand $fixture database_reopen $Target @('backend/scripts/azure-database.ts', 'reopen') `
        -Server $(if ($Recovery) { "$($Target.resources.postgresFlexibleServer.name)-restore-{{RUN_ID_8}}" } else { $Target.resources.postgresFlexibleServer.name })
    Add-Az $fixture open_and_verify @('webapp', 'config', 'appsettings', 'delete', '--ids', $Target.expectedResourceIds.appService,
        '--setting-names', 'MAINTENANCE_MODE') -Json @{}
    Add-Command $fixture open_and_verify __http_get__ @("$origin/api/ready") -Output '{"ok":true}' -ExitCode 200
    Add-Command $fixture open_and_verify __http_get__ @("$origin/api/auth/status") `
        -Output "{`"authConfigured`":true,`"callback`":`"$($Target.callbackUri)`"}" -ExitCode 200
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
    if ($Target.mcp) { Add-McpFixture $fixture $Target }
    return $fixture
}

function Add-McpFixture {
    param($Fixture, $Target)
    $m=$Target.mcp
    $s=$m.storage
    Add-Az $Fixture mcp_preflight @('appservice','list-locations','--sku','S1','--linux-workers-enabled','--subscription',$Target.subscriptionId) -Json @(@{name=$Target.region})
    Add-Az $Fixture mcp_preflight @('resource','show','--ids',$m.identityResourceId) -Json @{
        id=$m.identityResourceId; properties=@{clientId=$m.identityClientId;tenantId=$m.tenantId;principalId='dddddddd-dddd-4ddd-8ddd-dddddddddddd'}
    }
    $grants=@(@{roleDefinitionId='/roles/7f951dda-4ed3-4680-a7ca-43fe172d538d';scope=$m.registryResourceId},
        @{roleDefinitionId='/roles/ba92f5b4-2d11-453d-a403-e96b0029c9fe';scope=$s.containerResourceId
            conditionVersion='2.0';condition="@Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringEquals '$($s.blobName)'"})
    if ($m.installationMode -ceq 'existing') {
        foreach ($key in @('client','signing','encryption')) {
            $grants+=@{roleDefinitionId='/roles/4633458b-17de-408a-b874-0445c86b69e6';scope="$($Target.existingVaultResourceId)/secrets/$($m.secrets.$key.name)"}
        }
    }
    Add-Az $Fixture mcp_preflight @('role','assignment','list','--assignee-object-id','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        '--subscription',$Target.subscriptionId,'--all','--include-groups',
        '--fill-principal-name','false','--fill-role-definition-name','false') -Json $grants
    Add-Az $Fixture mcp_preflight @('role','assignment','list','--assignee-object-id','dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        '--scope',"/subscriptions/$($Target.subscriptionId)",'--include-inherited','--include-groups',
        '--fill-principal-name','false','--fill-role-definition-name','false') -Json @()
    Add-Az $Fixture mcp_preflight @('resource','show','--ids',$m.registryResourceId) -Json @{
        id=$m.registryResourceId; properties=@{loginServer=$m.registryLoginServer;adminUserEnabled=$false}
    }
    Add-Az $Fixture mcp_preflight @('acr','manifest','show-metadata','--registry','fixtureacr','--name',"$($m.repository)@$($m.imageDigest)") -Json @{digest=$m.imageDigest}
    Add-Az $Fixture mcp_preflight @('resource','show','--ids',$s.accountResourceId) -Json @{
        id=$s.accountResourceId; location=$Target.region; kind='StorageV2';sku=@{name='Standard_LRS'}
        properties=@{supportsHttpsTrafficOnly=$true;minimumTlsVersion='TLS1_2';publicNetworkAccess='Disabled'
            allowSharedKeyAccess=$false;allowBlobPublicAccess=$false}
    }
    Add-Az $Fixture mcp_preflight @('resource','show','--ids',$s.containerResourceId) -Json @{
        id=$s.containerResourceId; properties=@{publicAccess='None'}
    }
    Add-Az $Fixture mcp_preflight @('resource','show','--ids',$s.subnetResourceId) -Json @{
        id=$s.subnetResourceId; properties=@{delegations=@(@{properties=@{serviceName='Microsoft.Web/serverFarms'}})}
    }
    Add-Az $Fixture mcp_preflight @('resource','show','--ids',$s.privateEndpointResourceId) -Json @{
        id=$s.privateEndpointResourceId;properties=@{
            subnet=@{id=($s.subnetResourceId -replace '/subnets/[^/]+$','/subnets/private-endpoints')}
            privateLinkServiceConnections=@(@{properties=@{privateLinkServiceId=$s.accountResourceId;groupIds=@('blob')
                privateLinkServiceConnectionState=@{status='Approved'}}})
        }
    }
    Add-Az $Fixture mcp_preflight @('resource','show','--ids',"$($s.privateEndpointResourceId)/privateDnsZoneGroups/default") -Json @{
        properties=@{privateDnsZoneConfigs=@(@{properties=@{privateDnsZoneId=$s.privateDnsZoneResourceId}})}
    }
    Add-Az $Fixture mcp_preflight @('resource','show','--ids',$s.privateDnsVnetLinkResourceId) -Json @{
        id=$s.privateDnsVnetLinkResourceId;properties=@{virtualNetwork=@{id=($s.subnetResourceId -replace '/subnets/[^/]+$','')}
            registrationEnabled=$false;virtualNetworkLinkState='Completed'}
    }
    foreach ($key in @('client','signing','encryption')) {
        Add-Az $Fixture mcp_preflight @('keyvault','secret','list-versions','--vault-name','fixture-vault','--name',$m.secrets.$key.name) -Json @(@{
            id="https://fixture-vault.vault.azure.net/secrets/$($m.secrets.$key.name)/$($m.secrets.$key.version)"
            attributes=@{enabled=$true;expires=[DateTimeOffset]::UtcNow.AddDays(1).ToString('o')}
        })
    }
    Add-Az $Fixture mcp_preflight @('resource','list','--resource-group',$Target.resourceGroup,'--subscription',$Target.subscriptionId) -Json $(
        if ($m.installationMode -eq 'existing') { @(@{id=$m.appServiceResourceId},@{id=$m.planResourceId}) } else { @() }
    )
    if ($m.installationMode -eq 'existing') {
        Add-Az $Fixture mcp_preflight @('resource','show','--ids',$m.planResourceId) -Json @{sku=@{name='S1';capacity=1}}
        Add-Az $Fixture mcp_preflight @('webapp','show','--ids',$m.appServiceResourceId) -Json @{
            id=$m.appServiceResourceId;serverFarmId=$m.planResourceId;tags=@{storageIdentity=$s.identity}
        }
        Add-Az $Fixture mcp_preflight @('webapp','config','show','--ids',$m.appServiceResourceId) -Json @{
            linuxFxVersion="DOCKER|$($m.registryLoginServer)/$($m.repository)@$($m.existingImageDigest)";numberOfWorkers=1;autoHealEnabled=$false
        }
        Add-Az $Fixture mcp_preflight @('webapp','deployment','slot','list','--ids',$m.appServiceResourceId) -Json @()
        Add-Az $Fixture mcp_preflight @('monitor','autoscale','list','--resource-group',$Target.resourceGroup,'--subscription',$Target.subscriptionId) -Json @()
    }
    Add-Command $Fixture mcp_what_if az @('deployment','group','what-if','--subscription',$Target.subscriptionId,
        '--resource-group',$Target.resourceGroup,'--template-file','{{ROOT}}/infra/mcp.bicep','--parameters','@{{MCP_PARAMETER_FILE}}',
        '--only-show-errors','--no-pretty-print')
    foreach ($attempt in 1..2) {
        Add-Az $Fixture mcp_stop @('webapp','stop','--ids',$m.appServiceResourceId) -Json @{}
        Add-Az $Fixture mcp_stop @('webapp','show','--ids',$m.appServiceResourceId) -Json @{state='Stopped'}
        if ($m.installationMode -eq 'fresh' -or $attempt -eq 2) {
            $Fixture.commands.mcp_stop[-1] | Add-Member -NotePropertyName optional -NotePropertyValue $true
            $Fixture.commands.mcp_stop[-2] | Add-Member -NotePropertyName optional -NotePropertyValue $true
        }
    }
    Add-Az $Fixture mcp_apply @('deployment','group','create','--subscription',$Target.subscriptionId,'--resource-group',$Target.resourceGroup,
        '--name','agent-control-mcp-{{RUN_ID}}','--template-file','{{ROOT}}/infra/mcp.bicep','--parameters','@{{MCP_PARAMETER_FILE}}') -Json @{}
    Add-Az $Fixture mcp_start @('webapp','start','--ids',$m.appServiceResourceId) -Json @{}
    Add-Az $Fixture mcp_verify @('webapp','show','--ids',$m.appServiceResourceId) -Json @{
        id=$m.appServiceResourceId;serverFarmId=$m.planResourceId;state='Running';outboundIpAddresses='192.0.2.30'
        keyVaultReferenceIdentity=$m.identityResourceId;virtualNetworkSubnetId=$s.subnetResourceId;httpsOnly=$true
    }
    Add-Az $Fixture mcp_verify @('webapp','config','show','--ids',$m.appServiceResourceId) -Json @{
        linuxFxVersion="DOCKER|$($m.registryLoginServer)/$($m.repository)@$($m.imageDigest)";numberOfWorkers=1
        autoHealEnabled=$false;vnetRouteAllEnabled=$true;acrUseManagedIdentityCreds=$true;acrUserManagedIdentityID=$m.identityClientId
        healthCheckPath='/ready';minTlsVersion='1.2';ipSecurityRestrictionsDefaultAction='Deny'
        scmIpSecurityRestrictionsDefaultAction='Deny'
        ipSecurityRestrictions=@(@{action='Allow';ipAddress='192.0.2.0/24'})
    }
    Add-Az $Fixture mcp_verify @('rest','--method','post','--url',"https://management.azure.com$($m.appServiceResourceId)/config/azurestorageaccounts/list?api-version=2024-11-01") -Json @{
        properties=@{}
    }
    $references=@{}
    foreach ($entry in @(@('client','CLIENT_SECRET'),@('signing','JWT_SIGNING_KEY'),@('encryption','OAUTH_ENCRYPTION_KEY'))) {
        $references["MCP_AZURE_$($entry[1])"]=@{status='Resolved';secretName=$m.secrets.($entry[0]).name;secretVersion=$m.secrets.($entry[0]).version}
    }
    Add-Az $Fixture mcp_verify @('rest','--method','post','--url',"https://management.azure.com$($m.appServiceResourceId)/config/configreferences/appsettings/list?api-version=2022-03-01") -Json @{properties=$references}
    $settings=@{
        MCP_TENANT_ID=$m.tenantId;MCP_CLIENT_ID=$m.clientId;MCP_API_CLIENT_ID=$m.apiClientId;MCP_API_ORIGIN=$m.apiOrigin
        MCP_PUBLIC_URL=$m.publicUrl;MCP_SECRET_SOURCE='app-service-key-vault'
        MCP_AZURE_BLOB_ACCOUNT_URL=$s.accountUrl;MCP_AZURE_BLOB_CONTAINER=$s.containerName
        MCP_AZURE_BLOB_NAME=$s.blobName;MCP_AZURE_IDENTITY_CLIENT_ID=$m.identityClientId
        WEBSITES_ENABLE_APP_SERVICE_STORAGE='false';WEBSITES_CONTAINER_STOP_TIME_LIMIT='75';WEBSITES_PORT='8000'
        MCP_ALLOWED_CLIENT_REDIRECT_URIS=(ConvertTo-Json -InputObject @($m.redirectUris) -Compress)
    }
    Add-Az $Fixture mcp_verify @('webapp','config','appsettings','list','--ids',$m.appServiceResourceId) -Json @(
        $settings.GetEnumerator() | ForEach-Object { @{name=$_.Key;value=$_.Value} }
    )
    Add-Az $Fixture mcp_verify @('monitor','diagnostic-settings','show','--resource',$m.appServiceResourceId,'--name','agent-control-mcp') -Json @{
        logAnalyticsDestinationType='Dedicated';logs=@(@{enabled=$true;category='AppServiceConsoleLogs'})
        workspaceId=(Get-TargetResourceId $Target 'Microsoft.OperationalInsights/workspaces' "$($Target.resources.appService.name)-logs")
    }
    $alerts=@(
        @{name='http-5xx';metric='Http5xx';threshold=5;operator='GreaterThanOrEqual';aggregation='Total'},
        @{name='health';metric='HealthCheckStatus';threshold=100;operator='LessThan';aggregation='Average'},
        @{name='latency';metric='AverageResponseTime';threshold=2;operator='GreaterThan';aggregation='Average'},
        @{name='memory';metric='MemoryWorkingSet';threshold=805306368;operator='GreaterThan';aggregation='Average'}
    ) | ForEach-Object { @{
        name="$($m.appServiceName)-$($_.name)";enabled=$true;scopes=@($m.appServiceResourceId)
        actions=@(@{actionGroupId=$Target.resources.monitoring.actionGroupResourceId})
        criteria=@{allOf=@(@{metricName=$_.metric;threshold=$_.threshold;operator=$_.operator;timeAggregation=$_.aggregation})}
    } }
    Add-Az $Fixture mcp_verify @('monitor','metrics','alert','list','--resource-group',$Target.resourceGroup,'--subscription',$Target.subscriptionId) -Json @($alerts)
    Add-Command $Fixture mcp_verify __http_get__ @('https://fixture-mcp.azurewebsites.net/ready') -ExitCode 200 -Output '{"status":"ready"}'
    Add-Command $Fixture mcp_verify __http_get__ @('https://fixture-mcp.azurewebsites.net/.well-known/oauth-authorization-server') -ExitCode 200 -Output '{"issuer":"https://fixture-mcp.azurewebsites.net/"}'
    if ($m.installationMode -eq 'existing') {
        $mountCommand=Copy-Object $Fixture.commands.mcp_verify[2]
        $referenceCommand=Copy-Object $Fixture.commands.mcp_verify[3]
        foreach ($property in $referenceCommand.json.properties.PSObject.Properties) { $property.Value.secretVersion='fixturemcp1' }
        $Fixture.commands.mcp_preflight += @($mountCommand,$referenceCommand)
    }
}

function Set-SyntheticBootstrapSecrets {
    param($Context)
    $Context.SecretValues = @{
        'agent-control-postgres-admin-password' = 'synthetic-admin-password-at-least-thirty-two-characters'
        'agent-control-postgres-app-password' = 'synthetic-runtime-password-at-least-thirty-two-characters'
    }
}
function New-Context {
    param($Target, $Fixture, [string]$Name, [string]$Action = 'Deploy', [string]$ResumeReceiptPath, [string]$Component='All')
    $targetPath = Save-Json $Target "$Name-target.json"
    if ($Component -eq 'Mcp') {
        $Fixture.commands.prerequisites=@()
        $Fixture.commands.bicep_build=@($Fixture.commands.bicep_build | Where-Object { $_.arguments[1] -ceq '{{ROOT}}/infra/mcp.bicep' })
    }
    $fixturePath = Save-Json $Fixture "$Name-fixture.json"
    $validated = Read-ApprovedAzureTarget $targetPath Mock
    $context = New-AzureDeploymentContext -Root $root -Target $validated -ExecutionMode Mock -MockFixturePath $fixturePath `
        -ArtifactPath (Join-Path $root 'artifacts/release/agent-control-linux-x64.zip') `
        -ReceiptPath $(if ($ResumeReceiptPath) { $ResumeReceiptPath } else { Join-Path $scratch "$Name-receipt.json" }) `
        -ResumeReceiptPath $ResumeReceiptPath -RequestedAction $Action -QualificationTargets $null -Component $Component
    $script:Contexts.Add($context)
    return $context
}

try {
    $parseErrors = $null
    foreach ($file in @((Join-Path $root 'deploy-azure.ps1'), (Join-Path $root 'scripts/azure-deployment.ps1'), (Join-Path $root 'scripts/tenant-deployment.ps1'))) {
        [Management.Automation.Language.Parser]::ParseFile($file, [ref]$null, [ref]$parseErrors) | Out-Null
        Assert-True (@($parseErrors).Count -eq 0) "PowerShell syntax failed for $file"
    }
    $dockerfile = (Get-Content -LiteralPath (Join-Path $root 'Dockerfile') -Raw) -replace '\\\r?\n[ \t]*', ' '
    $operatorStage = [regex]::Match($dockerfile, '(?ims)^FROM[ \t]+[^\r\n]+[ \t]+AS[ \t]+operator[ \t]*\r?\n(?<body>.*?)(?=^FROM[ \t]|\z)')
    Assert-True $operatorStage.Success 'Dockerfile must define the Azure operator stage.'
    $operatorSourceFiles = @(foreach ($copy in [regex]::Matches($operatorStage.Groups['body'].Value, '(?im)^[ \t]*COPY[ \t]+(?<arguments>[^\r\n]+)')) {
        $parts = @($copy.Groups['arguments'].Value.Trim() -split '[ \t]+')
        if ($parts[-1] -ceq 'backend/scripts/' -and @($parts | Where-Object { $_ -like '--from=*' }).Count -eq 0) {
            $parts[0..($parts.Count - 2)]
        }
    })
    foreach ($requiredArtifact in @('backend/scripts/azure-database.ts','backend/scripts/azure-pitr.ts','backend/scripts/release-inspect.mjs')) {
        Assert-True ($requiredArtifact -cin $operatorSourceFiles) "Operator stage must copy $requiredArtifact into backend/scripts/; later stages and host files are not runtime inputs."
        Assert-True (Test-Path -LiteralPath (Join-Path $root $requiredArtifact) -PathType Leaf) "Required operator artifact $requiredArtifact is missing from the build context."
    }
    $zipContract = @'
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {zipSync}=require("fflate"),{spawnSync}=require("node:child_process");
const [root,scratch]=process.argv.slice(1),file=path.join(scratch,"agent-control-linux-x64.zip");
const base={"backend/dist/server.js":"server","frontend/dist/index.html":"web","package.json":"{}",
"release-manifest.json":JSON.stringify({version:2,revision:"synthetic-source-filter",platform:"linux",architecture:"x64",runtime:{name:"node",major:24}})};
let cases=0;
for(const [extra,accepted] of [[null,true],["backend/tsx-501/cache",false],["node_modules/nested/tsx-10001/cache",false],
["backend/tsx-source/input.ts",true],["frontend/dist/tsx-123-source/input.tsx",true],["backend/tsx-123.ts/input.ts",true]]) {
 const files={...base};if(extra)files[extra]="synthetic";
 const zip=zipSync(Object.fromEntries(Object.entries(files).map(([p,v])=>[p,Buffer.from(v)])));
 fs.writeFileSync(file,zip);fs.writeFileSync(file+".sha256",crypto.createHash("sha256").update(zip).digest("hex")+"  agent-control-linux-x64.zip\n");
 const result=spawnSync(process.execPath,[path.join(root,"backend/scripts/release-inspect.mjs"),file],{encoding:"utf8"});
 assert.equal(result.status===0,accepted,`ZIP cache boundary: ${extra}: ${result.stderr}`);cases++;
}
console.log(JSON.stringify({event:"azure_zip_source_filter",outcome:"passed",cases}));
'@
    $zipResult = & node -e $zipContract $root $scratch
    Assert-True ($LASTEXITCODE -eq 0) 'Actual Azure ZIP inspector did not enforce numeric-cache/ordinary-source boundaries.'
    Assert-True (($zipResult | ConvertFrom-Json).cases -eq 6) 'Azure ZIP cache regression did not execute every case.'
    $vaultAccess = Get-Content -LiteralPath (Join-Path $root 'infra/key-vault-access.bicep') -Raw
    Assert-True ($vaultAccess -cmatch '(?m)^[ \t]*@minLength\(3\)[ \t]*\r?\n[ \t]*@maxLength\(3\)[ \t]*\r?\n[ \t]*param runtimeSecretNames array[ \t]*$') `
        'Key Vault access module must require exactly three runtime secret names.'
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
    Assert-True ((Test-ApprovedAzureTarget $target Mock).installationMode -ceq 'existing') 'Valid current-schema target was rejected.'
    foreach ($name in @('unexpectedField','UnexpectedField')) {
        foreach ($value in @($null, '', $false, @{}, 'invalid-input')) {
            $invalid = Copy-Object $target
            $invalid | Add-Member -NotePropertyName $name -NotePropertyValue $value
            Assert-Fails { Test-ApprovedAzureTarget $invalid Mock } 'unsupported fields'
            $invalidDictionary = $invalid | ConvertTo-Json -Depth 40 | ConvertFrom-Json -Depth 40 -AsHashtable
            Assert-Fails { Test-ApprovedAzureTarget $invalidDictionary Mock } 'unsupported fields'
        }
    }
    $invalidCase = Copy-Object $target
    $invalidCase | Add-Member -NotePropertyName 'unexpectedField' -NotePropertyValue $null
    Assert-Fails { Test-ApprovedAzureTarget $invalidCase Mock } 'unsupported fields'
    $invalidModeTarget = Copy-Object $target
    $invalidModeTarget.installationMode = 'unsupported'
    Assert-Fails { Test-ApprovedAzureTarget $invalidModeTarget Mock } 'only fresh or existing'
    $rejectedReceipt = Join-Path $scratch 'invalid-input-receipt.json'
    foreach ($arguments in @(
        @('-InstallationMode', 'unsupported'),
        @('-UnexpectedField', 'invalid-input')
    )) {
        $output = & (Get-Command pwsh).Source -NoProfile -NonInteractive -File (Join-Path $root 'deploy-azure.ps1') `
            -Action Plan -ExecutionMode Mock -ReceiptPath $rejectedReceipt @arguments 2>&1
        Assert-True ($LASTEXITCODE -ne 0 -and ($output -join "`n") -match 'ValidateSet|does not belong to the set|parameter cannot be found') `
            'Invalid named input did not fail at parameter binding.'
        Assert-True (-not (Test-Path -LiteralPath $rejectedReceipt)) 'Invalid named input produced an execution receipt.'
    }
    foreach ($invalid in @($invalidModeTarget, $invalidCase)) {
        $invalidPath = Save-Json $invalid 'invalid-target.json'
        $output = & (Get-Command pwsh).Source -NoProfile -NonInteractive -File (Join-Path $root 'deploy-azure.ps1') `
            -Action Plan -ExecutionMode Mock -TargetFile $invalidPath -ReceiptPath $rejectedReceipt 2>&1
        Assert-True ($LASTEXITCODE -ne 0 -and ($output -join "`n") -match 'installationMode|unsupported') `
            "Invalid target input did not fail before context creation: $($output -join "`n")"
        Assert-True (-not (Test-Path -LiteralPath $rejectedReceipt)) 'Invalid target input produced an execution receipt.'
    }
    foreach ($step in @('unsupported-operation')) {
        $invalidContext = New-Context $target (New-Fixture $target) "invalid-$step" 'Plan'
        Assert-Fails { Invoke-DeploymentOperation $invalidContext $step } 'not registered'
        Assert-True ($invalidContext.CommandOffsets.Count -eq 0 -and $invalidContext.Owned.Count -eq 0 -and
            -not $invalidContext.BootstrapSecretsMaterialized) 'Invalid operation reached external commands or materialized credentials.'
        foreach ($field in @('completedSteps', 'failedStep', 'attemptedSteps')) {
            $invalidReceipt = Write-AzureDeploymentReceipt $invalidContext 'failed' '' @{}
            $invalidReceipt.completedSteps = @()
            $invalidReceipt.attemptedSteps = @()
            $invalidReceipt[$field] = $(if ($field -eq 'failedStep') { $step } else { @($step) })
            $invalidReceiptPath = Save-Json $invalidReceipt "invalid-$step-$field-receipt.json"
            Assert-Fails { Import-AzureDeploymentReceipt $invalidContext $invalidReceiptPath 'Plan' } 'unknown completed step|unsupported failed or attempted step'
        }
    }
    $currentSchemaContext = New-Context $target (New-Fixture $target) 'current-schema'
    Set-SyntheticBootstrapSecrets $currentSchemaContext
    $schemaEvidence=Invoke-DeploymentOperation $currentSchemaContext database_preflight
    Assert-True ($schemaEvidence.mode -ceq 'existing' -and $schemaEvidence.database -ceq 'agentcontrol' -and
        $schemaEvidence.currentFingerprint -ceq $schemaEvidence.targetFingerprint -and
        $schemaEvidence.targetFingerprint -cmatch '^[a-f0-9]{64}$' -and
        'schemaVersion' -notin @($schemaEvidence.PSObject.Properties.Name)) 'Current schema evidence retained a numeric baseline or lost its fingerprint.'
    Remove-AzureSensitiveDirectories $currentSchemaContext
    $existingResume=New-Context $target (New-Fixture $target -FreshResourcesExist) 'existing-before-initialize'
    $existingResume.Resuming=$true
    $existingResume.Completed.Add('resource_deploy')
    Set-SyntheticBootstrapSecrets $existingResume
    Assert-True ((Invoke-DeploymentOperation $existingResume resume_verify).exactStateVerified -eq $true) 'Existing-target resume before initialization incorrectly required an empty schema.'
    Remove-AzureSensitiveDirectories $existingResume
    foreach ($case in @(
        @{ mutate = { param($t) $t.isApproval = $false }; error = 'isApproval' },
        @{ mutate = { param($t) $t.installationMode = 'upgrade' }; error = 'only fresh or existing' },
        @{ mutate = { param($t) $t.estimate.monthlyTotal = 9 }; error = 'total' },
        @{ mutate = { param($t) $t.resources.postgresFlexibleServer.sku = 'Standard_D2s_v3' }; error = 'renewed estimate' },
        @{ mutate = { param($t) $t.resources.approvedAppOutboundIpv4Addresses = @() }; error = 'outbound' },
        @{ mutate = { param($t) $t.tenantRegistrySecretName = '' }; error = 'TENANTS_JSON is required' },
        @{ mutate = { param($t) $t.tenantRegistrySecretName = 'wrong-secret' }; error = 'TENANTS_JSON is required' }
    )) {
        $invalid = Copy-Object $target
        & $case.mutate $invalid
        Assert-Fails { Test-ApprovedAzureTarget $invalid Mock } $case.error
    }
    $changedVersion = Copy-Object $target
    $changedVersion.preparedVaultContract.versions[-1].version = 'fixtureversion2'
    Assert-Fails { Test-ApprovedAzureTarget $changedVersion Mock } 'Phase 11 coordinated-rotation prerequisite'
    Assert-True (-not (Get-Content -LiteralPath (Join-Path $root 'deploy-azure.ps1') -Raw).Contains('CredentialRotation')) 'Wizard still exposes credential rotation.'

    $registryTarget = New-Target
    Assert-True ((Test-ApprovedAzureTarget $registryTarget Mock).tenantRegistrySecretName -ceq 'agent-control-tenants-json') 'Registry-only target was rejected.'
    $dateLikeProfile = @(New-RegistryProfiles $registryTarget)[0]
    $dateLikeProfile.displayName = '2026-09-26T00:00:00Z'
    $dateLikeProfile.clientSecret = '2026-09-26T00:00:00Z'
    $parsedDateLike = ConvertFrom-DeploymentTenantRegistry (ConvertTo-Json -InputObject @($dateLikeProfile) -Depth 20)
    Assert-True ($parsedDateLike[0].displayName -is [string] -and $parsedDateLike[0].clientSecret -ceq '2026-09-26T00:00:00Z') 'PowerShell JSON parsing changed a string credential or display name into a date.'
    $unapprovedRegistry = Copy-Object $registryTarget
    $unapprovedRegistry.tenantRegistryRegistrationApprovalReference = ''
    Assert-Fails { Test-ApprovedAzureTarget $unapprovedRegistry Mock } 'EVERY|every configured tenant'
    $registryContext = New-Context $registryTarget (New-Fixture $registryTarget) 'registry'
    $registryEvidence = Invoke-DeploymentOperation $registryContext vault_preflight
    Assert-True ($registryEvidence.tenantProfileCount -eq 2 -and $registryEvidence.valuesRedacted) 'Prepared multi-tenant registry was not validated in memory.'
    $parameterFile = New-AzureParameterFile $registryContext
    $parameterText = [IO.File]::ReadAllText($parameterFile)
    $parameters = ($parameterText | ConvertFrom-Json).parameters
    Assert-True ($parameters.tenantRegistrySecretName.value -ceq 'agent-control-tenants-json' -and $parameters.tenantRegistrySecretVersion.value -ceq 'fixtureversion1') 'Azure did not select the immutable registry reference.'
    Assert-True (-not $parameterText.Contains('synthetic-secondary-tenant-secret') -and -not $parameterText.Contains('synthetic-fixture-agent-control-client-secret')) 'Registry credentials leaked into ARM parameters.'
    Assert-True ((Invoke-DeploymentOperation $registryContext runtime_access_verify).runtimeSecretCount -eq 3) 'Runtime verification did not require exactly three native registry/session/database references.'
    $registryRegistration = Invoke-DeploymentOperation $registryContext registration_verify
    Assert-True ($registryRegistration.primaryRegistrationVerified -and -not $registryRegistration.additionalRegistrationsVerified -and
        $registryRegistration.tenantRegistryRegistrationApprovalReference -ceq $registryTarget.tenantRegistryRegistrationApprovalReference) 'Registry registration evidence overclaimed verification of another directory.'
    Write-AzureDeploymentReceipt $registryContext 'test-only' '' @{ vault_preflight = $registryEvidence; registration_verify = $registryRegistration } | Out-Null
    $registryReceipt = [IO.File]::ReadAllText($registryContext.ReceiptPath)
    Assert-True (-not $registryReceipt.Contains('synthetic-secondary-tenant-secret') -and -not $registryReceipt.Contains('synthetic-fixture-agent-control-client-secret')) 'Registry credentials leaked into a deployment receipt.'
    Remove-AzureSensitiveDirectories $registryContext

    foreach ($name in @('tenantDomains','tenantDisplayName','tenantIdSecretVersion','clientIdSecretVersion','clientSecretVersion')) {
        Assert-True ($name -notin @($parameters.PSObject.Properties.Name)) "ARM parameters still produce standalone tenant input $name."
    }
    Assert-True ((Get-AzureRequiredSecretNames $target).Count -eq 4 -and
        (@((Get-AzureRuntimeSecretReferences $target).Keys) -join ',') -ceq 'TENANTS_JSON,SESSION_SECRET,PGPASSWORD') 'Azure still exposes standalone tenant credentials.'
    $missingRegistryVersion = Copy-Object $registryTarget
    $missingRegistryVersion.preparedVaultContract.existingVersions = @($missingRegistryVersion.preparedVaultContract.existingVersions | Where-Object name -CNE 'agent-control-tenants-json')
    Assert-Fails { Test-ApprovedAzureTarget $missingRegistryVersion Mock } 'every previously selected version'
    $idnProfiles = @(New-RegistryProfiles $registryTarget)
    $idnProfiles[1].domains = @("b$([char]0x00fc)cher.example")
    $idnRegistryValue = ConvertTo-Json -InputObject $idnProfiles -Depth 20
    $idnFixture = New-Fixture $registryTarget
    $idnFixture.commands.vault_preflight[1].json.value = $idnRegistryValue
    $idnContext = New-Context $registryTarget $idnFixture 'registry-unicode-letter-idn'
    Assert-True ((Invoke-DeploymentOperation $idnContext vault_preflight).tenantProfileCount -eq 2 -and
        $idnContext.SecretValues['agent-control-tenants-json'] -ceq $idnRegistryValue) 'Azure rejected a supported Unicode-letter domain or rewrote the protected registry during validation.'
    Remove-AzureSensitiveDirectories $idnContext
    $integrationProfiles = @(New-RegistryProfiles $registryTarget)
    $integrationProfiles[0].integration = @{clientId='55555555-5555-4555-8555-555555555555';audience=$integrationProfiles[0].clientId;scope='AgentControl.Access'}
    $integrationValue = ConvertTo-Json -InputObject $integrationProfiles -Depth 20
    $integrationFixture = New-Fixture $registryTarget
    $integrationFixture.commands.vault_preflight[1].json.value = $integrationValue
    $integrationContext = New-Context $registryTarget $integrationFixture 'registry-dormant-integration'
    Assert-True ((Invoke-DeploymentOperation $integrationContext vault_preflight).tenantProfileCount -eq 2 -and
        $integrationContext.SecretValues['agent-control-tenants-json'] -ceq $integrationValue) 'Azure validation silently discarded the dormant tenant integration binding.'
    Remove-AzureSensitiveDirectories $integrationContext
    foreach ($case in @(
        @{ name='malformed'; json='[{"clientSecret":"synthetic-secondary-tenant-secret-never-log"}'; error='valid JSON array' },
        @{ name='empty'; json='[]'; error='at least one tenant' },
        @{ name='object'; json='{}'; error='JSON array' },
        @{ name='wrong-property-case'; mutate={ param($p) $p[1].Remove('tenantId'); $p[1]['TenantId']='88888888-8888-4888-8888-888888888888' }; error='unknown profile field' },
        @{ name='unknown-integration-field'; mutate={ param($p) $p[0].integration=@{clientId='33333333-3333-4333-8333-333333333333';audience=$p[0].clientId;scope='AgentControl.Access';enabled=$true} }; error='integration contains an unknown field' },
        @{ name='conflicting-integration'; mutate={ param($p) $p[0].integration=@{clientId=$p[0].clientId;audience=$p[0].clientId;scope='AgentControl.Access'} }; error='distinct clientId GUID' },
        @{ name='missing-domain'; mutate={ param($p) $p[1].domains=@() }; error='accepted sign-in domain' },
        @{ name='non-string-domain'; mutate={ param($p) $p[1].domains=@('fabrikam.com',42) }; error='exact organization domains' },
        @{ name='unicode-domain-separator'; mutate={ param($p) $p[1].domains=@("example$([char]0x3002)com") }; error='exact organization domains' },
        @{ name='domain-format-control'; mutate={ param($p) $p[1].domains=@("exam$([char]0x200b)ple.com") }; error='exact organization domains' },
        @{ name='domain-url'; mutate={ param($p) $p[1].domains=@('https://example.com') }; error='exact organization domains' },
        @{ name='domain-username'; mutate={ param($p) $p[1].domains=@('user@example.com') }; error='exact organization domains' },
        @{ name='domain-wildcard'; mutate={ param($p) $p[1].domains=@('*.example.com') }; error='exact organization domains' },
        @{ name='duplicate-domain'; mutate={ param($p) $p[1].domains=@('CONTOSO.com') }; error='duplicate accepted domain' },
        @{ name='duplicate-tenant'; mutate={ param($p) $p[1].tenantId=$p[0].tenantId }; error='duplicate tenant' },
        @{ name='invalid-secret'; mutate={ param($p) $p[1].clientSecret="synthetic-secret`ninvalid" }; error='single-line client secret' },
        @{ name='replaced-primary'; mutate={ param($p) $p[0].clientId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }; error='approved primary tenant' }
    )) {
        $profiles = @(New-RegistryProfiles $registryTarget)
        if ($case.mutate) { & $case.mutate $profiles }
        $fixture = New-Fixture $registryTarget
        $fixture.commands.vault_preflight[1].json.value = $(if ($case.ContainsKey('json')) { $case.json } else { ConvertTo-Json -InputObject $profiles -Depth 20 })
        $invalidRegistry = New-Context $registryTarget $fixture "registry-$($case.name)"
        try { Assert-Fails { Invoke-DeploymentOperation $invalidRegistry vault_preflight } $case.error }
        catch { throw "Registry case $($case.name): $($_.Exception.Message)" }
    }
    foreach ($issue in @('missing','wrong-name','wrong-version','unresolved')) {
        $status = ReferenceStatus $registryTarget
        if ($issue -eq 'missing') { $status.properties.PSObject.Properties.Remove('TENANTS_JSON') }
        if ($issue -eq 'wrong-name') { $status.properties.TENANTS_JSON.secretName = 'wrong-secret' }
        if ($issue -eq 'wrong-version') { $status.properties.TENANTS_JSON.secretVersion = 'wrongversion' }
        if ($issue -eq 'unresolved') { $status.properties.TENANTS_JSON.status = 'AccessToKeyVaultDenied' }
        $fixture = New-Fixture $registryTarget
        Add-RuntimeCommands $fixture $registryTarget @($status,$status,$status,$status,$status)
        $badReference = New-Context $registryTarget $fixture "registry-reference-$issue"
        Set-SyntheticBootstrapSecrets $badReference
        Assert-Fails { Invoke-DeploymentOperation $badReference runtime_access_verify } 'native Key Vault references'
    }
    foreach ($mode in @('fresh','existing')) {
        $fullRegistryTarget = New-Target $mode
        $fullRegistryContext = New-Context $fullRegistryTarget (New-Fixture $fullRegistryTarget) "registry-full-$mode"
        $fullRegistryReceipt = Invoke-AzureDeployment $fullRegistryContext Deploy
        Assert-True ($fullRegistryReceipt.status -ceq 'deployed' -and
            $fullRegistryReceipt.evidence.vault_preflight.tenantProfileCount -eq 2 -and
            $fullRegistryReceipt.evidence.runtime_access_verify.runtimeSecretCount -eq 3) 'Mock registry deployment did not carry validated profiles through the complete release flow.'
        Assert-True (-not [IO.File]::ReadAllText($fullRegistryContext.ReceiptPath).Contains('synthetic-secondary-tenant-secret')) 'Complete registry deployment leaked credentials.'
    }

    $registration = New-Context $target (New-Fixture $target) 'registration'
    $registrationEvidence = Invoke-DeploymentOperation $registration registration_verify
    Assert-True ($registrationEvidence.roleCount -eq 3 -and $registrationEvidence.administratorAssignmentCount -eq 1) 'Three-role registration with a portal-created Admin ID was rejected.'
    foreach ($case in @(
        @{ name = 'unknown-role'; mutate = { param($f) $f.commands.registration_verify[0].json.appRoles[0].value = 'Unrecognized.Role' }; error = 'three-role' },
        @{ name = 'application-members'; mutate = { param($f) $f.commands.registration_verify[0].json.appRoles[0].allowedMemberTypes = @('User','Application') }; error = 'Users/Groups' },
        @{ name = 'unrestricted-signin'; mutate = { param($f) $f.commands.registration_verify[1].json[0].appRoleAssignmentRequired = $false }; error = 'Assignment required' },
        @{ name = 'no-admin'; mutate = { param($f) $f.commands.registration_verify[2].json.value = @() }; error = 'AgentControl.Admin assignment' }
    )) {
        $fixture = New-Fixture $target
        & $case.mutate $fixture
        Assert-Fails { Invoke-DeploymentOperation (New-Context $target $fixture "registration-$($case.name)") registration_verify } $case.error
    }
    $qualification = Get-Content -LiteralPath (Join-Path $root 'infra/qualification-targets.example.json') -Raw | ConvertFrom-Json
    $qualification.isApproval = $true
    $qualification.tenantId = $target.tenantId
    $qualification.entraApplicationId = $target.entraApplicationId
    $qualification.canonicalOrigin = $target.canonicalOrigin
    $qualification.expiresAt = [DateTimeOffset]::UtcNow.AddDays(1).ToString('o')
    $qualification.personas[0].principalObjectId = '88888888-8888-4888-8888-888888888888'
    foreach ($role in @('AgentControl.Viewer','AgentControl.UsageReportUploader','AgentControl.Admin')) {
        $qualification.personas[0].appRoles = @($role)
        Assert-True ((Test-ApprovedQualificationTargets $qualification $target).approved) 'A current role persona was rejected.'
    }
    foreach ($role in @('AgentControl.Operator','agentcontrol.admin')) {
        $qualification.personas[0].appRoles = @($role)
        Assert-Fails { Test-ApprovedQualificationTargets $qualification $target } 'unknown or empty role'
    }

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
    Assert-True ((Invoke-DeploymentOperation $runtimeDefault runtime_access_verify).runtimeSecretCount -eq 3) 'Default native-reference/admin exclusion failed.'
    Remove-AzureSensitiveDirectories $runtimeDefault

    $backupDefault = New-Context $target (New-Fixture $target) 'backup-default'
    Assert-True ((Invoke-DeploymentOperation $backupDefault backup_health_verify).status -eq 'completed') 'Default release-backup health proof failed.'

    $context = New-Context $target (New-Fixture $target) 'existing'
    $receipt = Invoke-AzureDeployment $context Deploy
    Assert-True ($receipt.status -eq 'deployed') 'Command-level existing did not complete.'
    $calls = @($context.Calls)
    foreach ($required in @('enter_maintenance', 'managed_backup', 'backup_health_verify', 'resource_deploy', 'database_initialize', 'start_contained',
        'contained_smoke', 'database_reopen', 'open_and_verify', 'cleanup')) {
        Assert-True ($required -in $calls) "Existing deployment omitted $required."
    }
    Assert-True ($receipt.evidence.resource_deploy.admission -eq 'closed' -and $receipt.evidence.resource_deploy.app -eq 'stopped' -and
        $receipt.evidence.backup_health_verify.status -eq 'completed') 'Resource deployment or release backup was not proven contained.'
    Assert-True ([array]::IndexOf($calls, 'contained_smoke') -lt [array]::IndexOf($calls, 'database_reopen') -and
        [array]::IndexOf($calls, 'database_reopen') -lt [array]::IndexOf($calls, 'open_and_verify')) 'Public admission opened before contained/auth/database sequencing.'
    Assert-True ($receipt.evidence.open_and_verify.loginProof -eq 'not_verified_by_deployment_checks') 'Liveness was mislabeled as login proof.'
    Assert-True (@($context.Owned).Count -eq 0) 'Existing deployment left an owned resource.'
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
        Invoke-AzureDatabaseContainer $materialContext @('backend/scripts/azure-database.ts', 'preflight', 'existing', $target.expectedDatabaseName) | Out-Null
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
    Add-RuntimeCommands $mismatchFixture $target @((ReferenceStatus $target 'Resolved' 'TENANTS_JSON'), (ReferenceStatus $target 'Resolved' 'TENANTS_JSON'),
        (ReferenceStatus $target 'Resolved' 'TENANTS_JSON'), (ReferenceStatus $target 'Resolved' 'TENANTS_JSON'), (ReferenceStatus $target 'Resolved' 'TENANTS_JSON'))
    $mismatch = New-Context $target $mismatchFixture 'runtime-mismatch'
    Set-SyntheticBootstrapSecrets $mismatch
    Assert-Fails { Invoke-DeploymentOperation $mismatch runtime_access_verify } 'including TENANTS_JSON'
    $deniedFixture = New-Fixture $target
    Add-RuntimeCommands $deniedFixture $target @(3, 3, 3, 3, 3)
    $denied = New-Context $target $deniedFixture 'runtime-denied'
    Set-SyntheticBootstrapSecrets $denied
    Assert-Fails { Invoke-DeploymentOperation $denied runtime_access_verify } 'including TENANTS_JSON'
    $networkFixture = New-Fixture $target
    Add-RuntimeCommands $networkFixture $target @(7, 7, 7, 7, 7)
    $network = New-Context $target $networkFixture 'runtime-network'
    Set-SyntheticBootstrapSecrets $network
    Assert-Fails { Invoke-DeploymentOperation $network runtime_access_verify } 'including TENANTS_JSON'
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
        [array]::IndexOf(@($fresh.Calls), 'database_initialize') -lt [array]::IndexOf(@($fresh.Calls), 'managed_backup') -and
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
    Assert-True ('resource_deploy' -in @($firstReceipt.completedSteps) -and 'database_initialize' -notin @($firstReceipt.completedSteps)) 'Fresh pre-bootstrap interruption receipt is incomplete.'
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
    Assert-True ((Invoke-AzureDeployment $resume Deploy).status -eq 'deployed') 'Receipt-bound fresh pre-bootstrap resume failed.'
    Assert-True ('resume-skip:resource_deploy' -in @($resume.Calls)) 'Fresh resume replayed resource deployment.'

    $postBootstrapFixture = New-Fixture $freshTarget
    $postBootstrapFixture.commands.runtime_access_verify[0].exitCode = 9
    $postBootstrapReceiptPath = Join-Path $scratch 'fresh-post-bootstrap-receipt.json'
    $postBootstrap = New-Context $freshTarget $postBootstrapFixture 'fresh-post-bootstrap'
    $postBootstrap.ReceiptPath = $postBootstrapReceiptPath
    Assert-Fails { Invoke-AzureDeployment $postBootstrap Deploy } 'stopped'
    $postReceipt = Get-Content -LiteralPath $postBootstrapReceiptPath -Raw | ConvertFrom-Json
    Assert-True ('database_initialize' -in @($postReceipt.completedSteps) -and 'package_deploy' -in @($postReceipt.completedSteps)) 'Post-bootstrap interruption lost completed write evidence.'
    $postResumeFixture = New-Fixture $freshTarget -FreshResourcesExist -ResumeDatabaseInitialized
    $postResume = New-Context $freshTarget $postResumeFixture 'fresh-post-bootstrap-resume' 'Deploy' $postBootstrapReceiptPath
    Assert-True ((Invoke-AzureDeployment $postResume Deploy).status -eq 'deployed') 'Receipt-bound post-bootstrap resume failed.'
    Assert-True ('resume-skip:database_initialize' -in @($postResume.Calls) -and 'resume-skip:package_deploy' -in @($postResume.Calls)) 'Post-bootstrap resume replayed completed writes.'

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
        $processResumeFixture = New-Fixture $freshTarget -FreshResourcesExist -ResumeDatabaseInitialized:$processCase.initialized
        $processCommandLog = Join-Path $scratch "$($processCase.name)-commands.jsonl"
        $processResumeFixture.commandLogPath = $processCommandLog
        $processResumePath = Save-Json $processResumeFixture "$($processCase.name)-resume-fixture.json"
        & (Get-Command pwsh).Source -NoProfile -File (Join-Path $root 'deploy-azure.ps1') -Action Deploy -ExecutionMode Mock `
            -TargetFile $processTargetPath -MockFixturePath $processResumePath `
            -ArtifactPath (Join-Path $root 'artifacts/release/agent-control-linux-x64.zip') -ReceiptPath $processReceiptPath `
            -ResumeReceiptPath $processReceiptPath | Out-Null
        Assert-True ($LASTEXITCODE -eq 0 -and (Get-Content -LiteralPath $processReceiptPath -Raw | ConvertFrom-Json).status -eq 'deployed') `
            "$($processCase.name) did not resume across process invocations."
        $processLog = Get-Content -LiteralPath $processCommandLog -Raw
        Assert-True (-not $processLog.Contains('"operation":"resource_deploy"') -and
            (-not $processCase.initialized -or -not $processLog.Contains('"operation":"database_initialize"'))) `
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
        -Region $parameterTarget.region -AppRegistrationClientId $parameterTarget.entraApplicationId -TenantRegistryRegistrationApprovalReference $parameterTarget.tenantRegistryRegistrationApprovalReference `
        -AppServicePlanName $parameterTarget.resources.appServicePlan.name -AppServiceName $parameterTarget.resources.appService.name `
        -PostgresServerName $parameterTarget.resources.postgresFlexibleServer.name -ExistingVaultResourceId $parameterTarget.existingVaultResourceId `
        -CanonicalOrigin $parameterTarget.canonicalOrigin -InstallationMode existing `
        -AppOutboundIpv4Addresses $parameterTarget.resources.approvedAppOutboundIpv4Addresses -RunnerIpv4Address $parameterTarget.runnerIpv4Address `
        -ActionGroupResourceId $parameterTarget.resources.monitoring.actionGroupResourceId -EstimateAsOfDate $parameterTarget.estimate.asOfDate `
        -EstimateSource $parameterTarget.estimate.source -EstimateCurrency $parameterTarget.estimate.currency -EstimateItemsJson $itemsJson `
        -ApprovedMonthlyBudget 10 -BudgetStartDate $parameterTarget.resources.monitoring.budgetStartDate `
        -BudgetEndDate $parameterTarget.resources.monitoring.budgetEndDate -MaintenanceWindowStartsAt $parameterTarget.maintenanceApproval.windowStartsAt `
        -MaintenanceWindowEndsAt $parameterTarget.maintenanceApproval.windowEndsAt -ApprovedBy $parameterTarget.operatorApproval.approvedBy `
        -ApprovedAt $parameterTarget.operatorApproval.approvedAt -ApprovalReference $parameterTarget.operatorApproval.changeReference `
        -BurstableRiskAcceptanceReference $parameterTarget.riskAcceptance.reference -SecretVersionsJson $versionsJson -ExistingSecretVersionsJson $existingJson | Out-Null
    Assert-True ($LASTEXITCODE -eq 0 -and (Get-Content -LiteralPath $namedReceipt -Raw | ConvertFrom-Json).status -eq 'previewed_not_deployed') 'Complete named parameters prompted or diverged from target-file execution.'

    Assert-True ($bicep.Contains("settingName: 'TENANTS_JSON'") -and $bicep.Contains('version: tenantRegistrySecretVersion') -and
        -not $bicep.Contains("'TENANT_ID'") -and -not $bicep.Contains("'CLIENT_ID'") -and
        -not $bicep.Contains("'CLIENT_SECRET'") -and -not $bicep.Contains("'TENANT_DOMAINS'") -and -not $bicep.Contains("'TENANT_DISPLAY_NAME'") -and
        $bicep.Contains('runtimeSecretNames: [for secret in runtimeSecrets: secret.name]')) `
        'Registry-only secret references or least-privilege runtime secret scope are missing.'
    Assert-True ($null -eq (Get-AzureMcpTarget $target)) 'Omitted MCP must remain absent.'
    Assert-True (-not ((Get-Content -LiteralPath (New-AzureParameterFile $registryContext) -Raw | ConvertFrom-Json).parameters.PSObject.Properties.Name -ccontains 'mcp')) `
        'Application ARM parameters unexpectedly provision MCP.'
    foreach ($value in @($null,$false,'',@{},@{enabled=$true})) {
        $invalid=New-Target
        $invalid | Add-Member -NotePropertyName mcp -NotePropertyValue $value
        Assert-Fails { Test-ApprovedAzureTarget $invalid Mock } 'mcp must|supported fields'
    }
    $mcpTarget=Add-McpTarget (New-Target)
    Assert-True ((Test-ApprovedAzureTarget $mcpTarget Mock).mcp.storage.blobName -ceq 'oauth-state.v1.fernet') 'Exact leased Blob MCP target was rejected.'
    foreach ($callback in @('http://127.0.0.1:53110/','http://127.0.0.1:19876/mcp/oauth/callback','https://client.example.invalid/')) {
        $native=Copy-Object $mcpTarget
        $native.mcp.redirectUris=@($callback)
        Assert-True ((Test-ApprovedAzureTarget $native Mock).mcp.redirectUris[0] -ceq $callback) 'Exact native OAuth callback was rejected or rewritten.'
    }
    $wrongCase=New-Target
    $wrongCase | Add-Member -NotePropertyName MCP -NotePropertyValue @{}
    Assert-Fails { Test-ApprovedAzureTarget $wrongCase Mock } 'unsupported fields|exact lowercase mcp'
    foreach ($case in @(
        @{change={param($m) $m.imageDigest='latest'};pattern='digest'},
        @{change={param($m) $m.identityClientId=$m.identityClientId.ToUpperInvariant()};pattern='canonical lowercase'},
        @{change={param($m) $m.apiClientId=$m.clientId};pattern='tenant/API'},
        @{change={param($m) $m.tenantId='99999999-9999-4999-8999-999999999999'};pattern='tenant/API'},
        @{change={param($m) $m.registryLoginServer='other.azurecr.io'};pattern='registry|ACR'},
        @{change={param($m) $m.publicUrl='https://fixture-mcp.azurewebsites.net/*'};pattern='public resource'},
        @{change={param($m) $m.callbackUri='https://fixture-mcp.azurewebsites.net/callback'};pattern='callback'},
        @{change={param($m) $m.redirectUris=@('https://*.example.invalid/callback')};pattern='redirects'},
        @{change={param($m) $m.redirectUris='https://client.example.test/callback'};pattern='redirects'},
        @{change={param($m) $m.redirectUris=@('http://client.example.test/')};pattern='redirects'},
        @{change={param($m) $m.redirectUris=@('http://127.0.0.1:53110')};pattern='redirects'},
        @{change={param($m) $m.storage.accountUrl='http://fixtureoauth.blob.core.windows.net'};pattern='TLS Blob'},
        @{change={param($m) $m.storage.blobName='another'};pattern='TLS Blob'},
        @{change={param($m) $m.storage.containerResourceId='/other'};pattern='TLS Blob'},
        @{change={param($m) $m.storage.privateDnsZoneResourceId='/other'};pattern='TLS Blob'},
        @{change={param($m) $m.storage.preparedReference=''};pattern='Blob preparation'},
        @{change={param($m) $m.secrets.client.version=''};pattern='immutable versions'},
        @{change={param($m) $m.secrets.client | Add-Member -NotePropertyName value -NotePropertyValue 'synthetic-never-log'};pattern='supported fields'},
        @{change={param($m) $m.network.inboundIpv4Cidrs=@('0.0.0.0/0')};pattern='CIDRs'},
        @{change={param($m) $m.network.inboundIpv4Cidrs='192.0.2.0/24'};pattern='ingress'},
        @{change={param($m) $m.network.forwardedHeaders='all'};pattern='forwarded'},
        @{change={param($m) $m.cost.monthlyTotal=7};pattern='cost'}
    )) {
        $invalid=Copy-Object $mcpTarget
        & $case.change $invalid.mcp
        Assert-Fails { Test-ApprovedAzureTarget $invalid Mock } $case.pattern
    }
    $noMcp=New-Context $target (New-Fixture $target) 'no-mcp-component' 'Plan'
    Assert-Fails { New-Context $target (New-Fixture $target) 'no-mcp-explicit-component' 'Plan' -Component Mcp } 'requires explicit MCP'
    Assert-Fails { New-Context $mcpTarget (New-Fixture $mcpTarget) 'ignored-mcp' 'Plan' -Component Application } 'rather than silently'
    $mcpPlan=New-Context $mcpTarget (New-Fixture $mcpTarget) 'mcp-plan' 'Plan' -Component Mcp
    $mcpPlanReceipt=Invoke-AzureDeployment $mcpPlan Plan
    Assert-True ($mcpPlanReceipt.status -ceq 'previewed_not_deployed' -and
        $null -eq $mcpPlanReceipt.artifact -and 'mcp_apply' -notin @($mcpPlan.Calls) -and 'vault_preflight' -notin @($mcpPlan.Calls)) 'MCP-only Plan wrote resources/read API secrets/artifact.'
    $mcpDeploy=New-Context $mcpTarget (New-Fixture $mcpTarget) 'mcp-deploy' 'Deploy' -Component Mcp
    $mcpReceipt=Invoke-AzureDeployment $mcpDeploy Deploy
    Assert-True ($mcpReceipt.status -ceq 'deployed_mcp' -and $mcpReceipt.mcp.contract.imageDigest -ceq $mcpTarget.mcp.imageDigest -and
        $mcpReceipt.evidence.mcp_verify.authenticatedApiConnectivity -ceq 'not_proven') 'MCP deployment receipt lost immutable identity or overclaimed API proof.'
    Assert-True (-not @($mcpDeploy.Calls | Where-Object { $_ -in @('resource_deploy','network_reconcile','enter_maintenance','database_initialize','package_deploy') }).Count) `
        'MCP-only touched API/PostgreSQL.'
    $mcpAll=New-Context $mcpTarget (New-Fixture $mcpTarget) 'mcp-all'
    Assert-True ((Invoke-AzureDeployment $mcpAll Deploy).status -ceq 'deployed') 'Combined independent application/MCP deployment failed.'
    Assert-True ([array]::IndexOf(@($mcpAll.Calls),'open_and_verify') -lt [array]::IndexOf(@($mcpAll.Calls),'mcp_apply')) `
        'MCP was deployed before independent API/web recovered.'
    $receiptFailure=New-Context $mcpTarget (New-Fixture $mcpTarget) 'mcp-receipt-failure'
    $receiptBlocker=Join-Path $scratch 'mcp-receipt-blocker'
    [IO.File]::WriteAllText($receiptBlocker,'synthetic')
    $receiptFailure.ReceiptPath=Join-Path $receiptBlocker 'receipt.json'
    Assert-Fails { Invoke-AzureDeployment $receiptFailure Deploy } 'API/web remains online'
    Assert-True ('open_and_verify' -in @($receiptFailure.Completed) -and
        'contain_runtime' -notin @($receiptFailure.Calls)) 'An independent MCP receipt failure disabled the verified API/web.'
    $rotation=Add-McpTarget (New-Target) existing
    foreach ($key in @('client','signing','encryption')) {
        $rotated=Copy-Object $rotation
        foreach ($other in @('client','signing','encryption') | Where-Object { $_ -cne $key }) { $rotated.mcp.secrets.$other.version='fixturemcp1' }
        $rotationContext=New-Context $rotated (New-Fixture $rotated) "mcp-rotate-$key" 'Deploy' -Component Mcp
        Assert-True ((Invoke-AzureDeployment $rotationContext Deploy).status -ceq 'deployed_mcp') "Independent $key rotation failed."
        Assert-True ([array]::IndexOf(@($rotationContext.Calls),'mcp_stop') -lt [array]::IndexOf(@($rotationContext.Calls),'mcp_apply') -and
            'vault_preflight' -notin @($rotationContext.Calls)) 'Rotation failed stop-before-update or read API credentials.'
    }
    $recoverMcp=New-Context $rotation (New-Fixture $rotation) 'mcp-recover' 'Recover' -Component Mcp
    Assert-True ((Invoke-AzureDeployment $recoverMcp Recover).status -ceq 'recovered_mcp' -and
        'pitr_restore' -notin @($recoverMcp.Calls)) 'MCP-only recovery restored API business data.'
    $stopMcp=New-Context $rotation (New-Fixture $rotation) 'mcp-stop' 'Stop' -Component Mcp
    Assert-True ((Invoke-AzureDeployment $stopMcp Stop).status -ceq 'mcp_stopped' -and
        (@($stopMcp.Calls) -join ',') -ceq 'operator_identity,mcp_stop') 'Exact backup stop read API secrets, deployed or stopped the application.'
    $cliMcpFixture=Save-Json $mcpDeploy.MockFixture 'mcp-cli-fixture.json'
    $cliMcpTarget=Save-Json $mcpTarget 'mcp-cli-target.json'
    $cliMcpReceipt=Join-Path $scratch 'mcp-cli-receipt.json'
    & (Get-Command pwsh).Source -NoProfile -NonInteractive -File (Join-Path $root 'deploy-azure.ps1') `
        -Action Deploy -Component Mcp -ExecutionMode Mock -TargetFile $cliMcpTarget -MockFixturePath $cliMcpFixture `
        -ArtifactPath (Join-Path $scratch 'no-api-artifact.zip') -ReceiptPath $cliMcpReceipt | Out-Null
    Assert-True ($LASTEXITCODE -eq 0 -and (Get-Content -LiteralPath $cliMcpReceipt -Raw | ConvertFrom-Json).status -ceq 'deployed_mcp') `
        'Real CLI binding of mocked MCP-only deployment required API artifacts/authentication smoke or diverged.'
    foreach ($case in @(
        @{index=1;change={param($c) $c.json.properties.clientId='wrong'};pattern='managed identity'},
        @{index=2;change={param($c) $c.json[0].scope='/subscriptions/wrong'};pattern='broad/custom/inherited'},
        @{index=2;change={param($c) $c.json[0].roleDefinitionId='/roles/8e3af657-a8ff-443c-a75c-2fe8c4bcb635'};pattern='broad/custom/inherited'},
        @{index=2;change={param($c) $c.json=@(@{roleDefinitionId='/roles/4633458b-17de-408a-b874-0445c86b69e6';scope='/subscriptions/wrong/vault'})};pattern='broad/custom/inherited'},
        @{index=2;change={param($c) $c.json=@()};pattern='AcrPull grant'},
        @{index=3;change={param($c) $c.json=@(@{roleDefinitionId='/roles/8e3af657-a8ff-443c-a75c-2fe8c4bcb635';scope='/providers/Microsoft.Management/managementGroups/synthetic'})};pattern='broad/custom/inherited'},
        @{index=4;change={param($c) $c.json.properties.roleAssignmentMode='AbacRepositoryPermissions'};pattern='legacy AcrPull'},
        @{index=5;change={param($c) $c.json.digest='sha256:wrong'};pattern='digest mismatch'},
        @{index=6;change={param($c) $c.json.properties.publicNetworkAccess='Enabled'};pattern='TLS Blob'},
        @{index=6;change={param($c) $c.json.properties.supportsHttpsTrafficOnly=$false};pattern='TLS Blob'},
        @{index=6;change={param($c) $c.json.properties.allowSharedKeyAccess=$true};pattern='TLS Blob'},
        @{index=7;change={param($c) $c.json.properties.publicAccess='Blob'};pattern='TLS Blob'},
        @{index=8;change={param($c) $c.json.id='other-subnet'};pattern='TLS Blob'},
        @{index=9;change={param($c) $c.json.properties.privateLinkServiceConnections[0].properties.privateLinkServiceConnectionState.status='Pending'};pattern='private endpoint'},
        @{index=10;change={param($c) $c.json.properties.privateDnsZoneConfigs[0].properties.privateDnsZoneId='/other'};pattern='DNS'},
        @{index=11;change={param($c) $c.json.properties.virtualNetwork.id='/other'};pattern='DNS'},
        @{index=12;change={param($c) $c.json[0].attributes.enabled=$false};pattern='secret version'},
        @{index=2;change={param($c) $c.json[1].condition='true'};pattern='broad/custom/inherited'},
        @{index=2;change={param($c) $c.json[1].scope='/subscriptions/wrong'};pattern='broad/custom/inherited'}
    )) {
        $fixture=New-Fixture $mcpTarget
        & $case.change $fixture.commands.mcp_preflight[$case.index]
        $context=New-Context $mcpTarget $fixture "mcp-preflight-$($case.index)" 'Plan' -Component Mcp
        Assert-Fails { Invoke-DeploymentOperation $context mcp_preflight } $case.pattern
        Assert-True ('mcp_apply' -notin @($context.Calls)) 'Failed preflight reached a write.'
    }
    foreach ($case in @(
        @{index=0;change={param($c) $c.json.outboundIpAddresses='192.0.2.99'};pattern='identity mismatch'},
        @{index=1;change={param($c) $c.json.ipSecurityRestrictionsDefaultAction='Allow'};pattern='identity mismatch'},
        @{index=2;change={param($c) $c.json.properties=@{unexpected=@{}}};pattern='identity mismatch'},
        @{index=1;change={param($c) $c.json.vnetRouteAllEnabled=$false};pattern='identity mismatch'},
        @{index=3;change={param($c) $c.json.properties.MCP_AZURE_CLIENT_SECRET.secretVersion='other'};pattern='Key Vault'},
        @{index=4;change={param($c) @($c.json | Where-Object name -CEQ MCP_API_ORIGIN)[0].value='https://other.invalid'};pattern='configuration mismatch'},
        @{index=5;change={param($c) $c.json.logs[0].category='AppServiceHTTPLogs'};pattern='diagnostics'},
        @{index=6;change={param($c) $c.json[0].criteria.allOf[0].threshold=999};pattern='alert'}
    )) {
        $fixture=New-Fixture $mcpTarget
        & $case.change $fixture.commands.mcp_verify[$case.index]
        $context=New-Context $mcpTarget $fixture "mcp-runtime-$($case.index)" 'Plan' -Component Mcp
        Assert-Fails { Invoke-DeploymentOperation $context mcp_verify } $case.pattern
    }
    $applyFailedFixture=New-Fixture $mcpTarget
    $applyFailedFixture.commands.mcp_apply[0].exitCode=9
    $applyFailed=New-Context $mcpTarget $applyFailedFixture 'mcp-apply-failed' 'Deploy' -Component Mcp
    $applyFailedReceipt=Invoke-AzureDeployment $applyFailed Deploy
    Assert-True ($applyFailedReceipt.status -ceq 'mcp_failed' -and $applyFailedReceipt.failedStep -ceq 'mcp_apply' -and
        $applyFailedReceipt.evidence.mcpContainment.stopped -eq $true -and 'mcp_start' -notin @($applyFailed.Calls)) `
        'Uncertain fresh MCP apply was retried/started or failed to attempt MCP-only containment.'
    $failedFixture=New-Fixture $mcpTarget
    $failedFixture.commands.mcp_verify[1].json.linuxFxVersion='DOCKER|different'
    $failedMcp=New-Context $mcpTarget $failedFixture 'mcp-runtime-failure'
    $failedMcpReceipt=Invoke-AzureDeployment $failedMcp Deploy
    Assert-True ($failedMcpReceipt.status -ceq 'deployed_mcp_failed' -and
        'contain_runtime' -notin @($failedMcp.Calls) -and $failedMcpReceipt.evidence.mcpContainment.apiWrites -eq 0) `
        'MCP runtime failure disabled the independent API/web.'
    foreach ($binding in @('container','identity','image','secret')) {
        $changed = Copy-Object $mcpTarget
        switch ($binding) {
            container {
                $changed.mcp.storage.containerName='different'
                $changed.mcp.storage.containerResourceId="$($changed.mcp.storage.accountResourceId)/blobServices/default/containers/different"
                $changed.mcp.storage.identity="$($changed.mcp.storage.accountUrl)/different/$($changed.mcp.storage.blobName)"
            }
            identity { $changed.mcp.identityClientId='cccc0000-cccc-4ccc-8ccc-cccccccccccc' }
            image { $changed.mcp.imageDigest='sha256:' + ('d' * 64) }
            secret { $changed.mcp.secrets.encryption.version='differentversion' }
        }
        Assert-Fails { New-Context $changed (New-Fixture $changed) "mcp-resume-mismatch-$binding" 'Deploy' $failedMcp.ReceiptPath } `
            'exact approved target and execution boundary'
    }
    $resumeFixture=New-Fixture $mcpTarget
    $resumeFixture.commands.mcp_preflight=@()
    $existingFixture=New-Fixture $rotation
    $resumeFixture.commands.mcp_preflight=@($existingFixture.commands.mcp_preflight)
    $resumeFixture.commands.mcp_preflight[17].json.tags=@{storageIdentity=$mcpTarget.mcp.storage.identity;wizardRunId='{{RUN_ID}}'}
    $resumeFixture.commands.mcp_preflight[18].json.linuxFxVersion="DOCKER|$($mcpTarget.mcp.registryLoginServer)/$($mcpTarget.mcp.repository)@$($mcpTarget.mcp.imageDigest)"
    foreach ($property in $resumeFixture.commands.mcp_preflight[-1].json.properties.PSObject.Properties) { $property.Value.secretVersion='fixturemcp2' }
    $retryPath=Save-Json $failedMcpReceipt 'mcp-repeated-resume.json'
    foreach ($attempt in 1..2) {
        $retryFixture=Copy-Object $resumeFixture
        $retryFixture.commands.mcp_verify[1].json.linuxFxVersion='DOCKER|different'
        $retry=New-Context $mcpTarget $retryFixture "mcp-repeat-$attempt" 'Deploy' $retryPath
        $retried=Invoke-AzureDeployment $retry Deploy
        Assert-True ($retried.status -ceq 'deployed_mcp_failed' -and
            'contain_runtime' -notin @($retry.Calls) -and 'enter_maintenance' -notin @($retry.Calls) -and
            'vault_preflight' -notin @($retry.Calls) -and 'package_deploy' -notin @($retry.Calls)) `
            'Repeated partial MCP resume lost API-success status, read API secrets or disabled API/web.'
    }
    $retrySuccess=New-Context $mcpTarget (Copy-Object $resumeFixture) 'mcp-repeat-success' 'Deploy' $retryPath
    Assert-True ((Invoke-AzureDeployment $retrySuccess Deploy).status -ceq 'deployed' -and
        'mcp_start' -in @($retrySuccess.Calls) -and 'enter_maintenance' -notin @($retrySuccess.Calls)) `
        'Successful repeated partial resume did not preserve full-deployment identity/API independence.'
    $resumeMcp=New-Context $mcpTarget $resumeFixture 'mcp-runtime-resume' 'Deploy' $failedMcp.ReceiptPath
    $resumedMcpReceipt=Invoke-AzureDeployment $resumeMcp Deploy
    Assert-True ($resumedMcpReceipt.status -ceq 'deployed' -and 'resume-skip:mcp_apply' -in @($resumeMcp.Calls) -and
        'enter_maintenance' -notin @($resumeMcp.Calls) -and 'mcp_start' -in @($resumeMcp.Calls)) 'MCP-only failure resume redeployed API, replayed apply or failed to restart stopped MCP.'
    $uncertain=Copy-Object $failedMcpReceipt
    $uncertain.failedStep='mcp_apply'
    $uncertain.completedSteps=@($uncertain.completedSteps | Where-Object { $_ -cne 'mcp_apply' })
    $uncertainPath=Save-Json $uncertain 'mcp-uncertain.json'
    $uncertainContext=New-Context $mcpTarget (New-Fixture $mcpTarget) 'mcp-uncertain' 'Deploy' $uncertainPath
    Assert-Fails { Invoke-DeploymentOperation $uncertainContext mcp_resume_verify } 'outcome is uncertain'
    $uncertainResume=New-Context $mcpTarget (New-Fixture $mcpTarget) 'mcp-uncertain-full' 'Deploy' $uncertainPath
    Assert-Fails { Invoke-AzureDeployment $uncertainResume Deploy } 'MCP preflight/recovery stopped'
    $stillUncertain=Get-Content -LiteralPath $uncertainPath -Raw | ConvertFrom-Json
    Assert-True ($stillUncertain.failedStep -ceq 'mcp_apply' -and $uncertainResume.CommandOffsets.Count -eq 0) `
        'Uncertain resume lost its original outcome or reached external writes.'
    $againUncertain=New-Context $mcpTarget (New-Fixture $mcpTarget) 'mcp-uncertain-again' 'Deploy' $uncertainPath
    Assert-Fails { Invoke-AzureDeployment $againUncertain Deploy } 'MCP preflight/recovery stopped'
    Assert-True ($againUncertain.CommandOffsets.Count -eq 0 -and
        (Get-Content -LiteralPath $uncertainPath -Raw | ConvertFrom-Json).status -ceq 'deployed_mcp_failed') `
        'Repeated uncertain apply resume reached API containment or cleared partial-success identity.'
    $mcpBicep=Get-Content -LiteralPath (Join-Path $root 'infra/mcp.bicep') -Raw
    Assert-True ($mcpBicep.Contains('MCP_AZURE_BLOB_NAME') -and -not $mcpBicep.Contains('azurestorageaccounts') -and
        -not $mcpBicep.Contains('accessKey:') -and $mcpBicep.Contains('vnetRouteAllEnabled: true') -and
        $mcpBicep.Contains('acrUseManagedIdentityCreds: true') -and $mcpBicep.Contains("value: 'app-service-key-vault'") -and
        $mcpBicep.Contains("WEBSITES_CONTAINER_STOP_TIME_LIMIT") -and $mcpBicep.Contains('numberOfWorkers: 1')) `
        'MCP Bicep lost leased Blob/native identity/private egress/drain boundaries.'
    $sample=Get-Content -LiteralPath (Join-Path $root 'infra/mcp-target.example.json') -Raw | ConvertFrom-Json
    Assert-AzureMcpObject $sample @($mcpTarget.mcp.PSObject.Properties.Name) 'MCP example'
    Assert-True ($sample.cost.monthlyTotal -eq $null -and $sample.storage.preparedReference -ceq '') `
        'MCP example became price evidence or private-network authorization.'
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
