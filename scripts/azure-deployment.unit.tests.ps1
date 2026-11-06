#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'azure-deployment.ps1')

$parseErrors = $null
$testAst = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'azure-deployment.tests.ps1'), [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Azure deployment fixture syntax is invalid.' }
# Load fixture definitions only; the full suite also executes deployment CLI processes.
foreach ($statement in $testAst.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst] -or
        ($statement -is [Management.Automation.Language.AssignmentStatementAst] -and
        $statement.Left.Extent.Text -ceq '$script:OperationNames')) {
        . ([scriptblock]::Create($statement.Extent.Text))
    }
}

$root = Join-Path $repositoryRoot "artifacts/test-scratch/azure-deployment-unit-$([Guid]::NewGuid().ToString('N'))"
if (Test-Path -LiteralPath $root) { throw 'Unit-test scratch must be a new owned directory.' }
$scratch = Join-Path $root 'results'
$script:Checks = 0
$script:Contexts = [Collections.Generic.List[object]]::new()
try {
    foreach ($directory in @($scratch, (Join-Path $root 'infra'), (Join-Path $root 'artifacts/release'))) {
        [IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'infra/entra-app-manifest.json') -Destination (Join-Path $root 'infra/entra-app-manifest.json')
    $artifact = Join-Path $root 'artifacts/release/agent-control-linux-x64.zip'
    [IO.File]::WriteAllText($artifact, 'synthetic-mocked-release')
    $checksum = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$artifact.sha256", "$checksum  agent-control-linux-x64.zip`n")

    foreach ($length in @(46,47,63)) {
        & {
            $target = New-Target
            $target.resources.postgresFlexibleServer.name = 'p' * $length
            $target.expectedResourceIds.postgresFlexibleServer = Get-TargetResourceId $target `
                'Microsoft.DBforPostgreSQL/flexibleServers' $target.resources.postgresFlexibleServer.name
            $context = New-Context $target (New-Fixture $target) "restore-name-$length" 'Recover'
            $expected = ('p' * [Math]::Min(46, $length)) + "-restore-$($context.RunId.Substring(0, 8))"
            function Get-AzJson {
                param([string[]]$Arguments)
                switch ($Arguments[0..2] -join ' ') {
                    'postgres flexible-server restore' {
                        $name = $Arguments[[array]::IndexOf($Arguments, '--name') + 1]
                        Assert-ResourceName $name 'PostgreSQL restore server name' 63
                        Assert-True ($name -ceq $expected) 'Restore did not preserve the bounded source prefix and exact run suffix.'
                    }
                    'webapp config appsettings' {
                        Assert-True ($Arguments[3] -ceq 'set' -and
                            "PGHOST=$expected.postgres.database.azure.com" -cin $Arguments) `
                            'Recovery did not switch to the exact bounded restore identity.'
                    }
                    default { throw 'Unexpected mocked restore-name Azure command.' }
                }
                return @{}
            }
            $restore = Invoke-RealAzureOperation $context pitr_restore @{ RestorePoint = '2026-01-01T00:00:00Z' }
            $context.Completed.Add('pitr_restore')
            $evidence = @{ pitr_restore = $restore }
            Write-AzureDeploymentReceipt $context failed pitr_validate_review $evidence | Out-Null
            $unswitched = New-Context $target (New-Fixture $target) "restore-name-unswitched-$length" 'Recover' $context.ReceiptPath
            Assert-True ($unswitched.RestoredServerName -ceq $expected -and
                $unswitched.Owned.Contains("postgres-restore:$expected")) `
                'Resume rejected or lost the bounded run-owned restore identity.'
            $evidence.recovery_switch = Invoke-RealAzureOperation $context recovery_switch @{}
            $context.Completed.Add('recovery_switch')
            Write-AzureDeploymentReceipt $context failed contained_smoke $evidence | Out-Null
            $switched = New-Context $target (New-Fixture $target) "restore-name-switched-$length" 'Recover' $context.ReceiptPath
            Assert-True ($switched.RestoredServerName -ceq $expected -and $switched.ServingServerName -ceq $expected -and
                $switched.Owned.Count -eq 0) 'Resume did not retain the bounded serving restore without deletion ownership.'
        }
    }

    & {
        $target = New-Target
        $resume = New-Context $target (New-Fixture $target) 'resume-network-order'
        $resume.Resuming = $true
        $resume.Completed.Add('resource_deploy')
        $resume.Completed.Add('database_initialize')
        $state = @{ firewallCreated = $false; databaseProbes = 0 }
        function Get-AzJson {
            param([string[]]$Arguments)
            switch ($Arguments[0..2] -join ' ') {
                'webapp config appsettings' { return @(@{ name = 'MAINTENANCE_MODE'; value = 'true' }) }
                'webapp show --ids' {
                    return @{ state = 'Stopped'; outboundIpAddresses = '192.0.2.20' }
                }
                'postgres flexible-server firewall-rule' {
                    Assert-True ($Arguments[3] -ceq 'create') 'Resume unexpectedly changed a different firewall operation.'
                    $state.firewallCreated = $true
                    return @{}
                }
                default { throw 'Unexpected mocked resume Azure command.' }
            }
        }
        function Invoke-AzureDatabaseContainer {
            param($Context, [string[]]$Command, [string]$ServerName)
            Assert-True $state.firewallCreated 'Resume probed PostgreSQL before restoring runner firewall access.'
            Assert-True (($Command -join ' ') -ceq 'backend/scripts/azure-database.ts preflight existing agentcontrol' -and
                $ServerName -ceq $Context.ServingServerName) 'Resume lost the initialized current-schema or serving-server check.'
            $state.databaseProbes++
            return @{ outcome = 'succeeded' }
        }
        Invoke-RealAzureOperation $resume resume_verify @{} | Out-Null
        Assert-True ($state.databaseProbes -eq 0) 'Read-only resume verification contacted the database without runner access.'
        Invoke-RealAzureOperation $resume network_reconcile @{} | Out-Null
        Assert-True ($state.databaseProbes -eq 1) 'Resume did not validate the current database after restoring runner access.'
    }

    foreach ($hostState in @('source','restored','missing','duplicate','unavailable')) {
        & {
            $target = New-Target
            $cleanup = New-Context $target (New-Fixture $target) "restore-cleanup-$hostState"
            $restored = "$($target.resources.postgresFlexibleServer.name)-restore-$($cleanup.RunId.Substring(0, 8))"
            $cleanup.Owned.Add("postgres-restore:$restored")
            $state = @{ deleted = $false; hostReads = 0 }
            function Get-AzJson {
                param([string[]]$Arguments, [switch]$SensitiveOutput)
                if (($Arguments[0..3] -join ' ') -ceq 'webapp config appsettings list') {
                    Assert-True $SensitiveOutput 'Cleanup app settings must not be exposed in command errors.'
                    $state.hostReads++
                    switch ($hostState) {
                        'source' { return @(@{ name='PGHOST'; value="$($target.resources.postgresFlexibleServer.name).postgres.database.azure.com" }) }
                        'restored' { return @(@{ name='PGHOST'; value="$restored.postgres.database.azure.com" }) }
                        'missing' { return @() }
                        'duplicate' { return @(@{ name='PGHOST'; value='unexpected' }, @{ name='PGHOST'; value='unexpected' }) }
                        'unavailable' { throw 'Synthetic app settings unavailable.' }
                    }
                }
                if (($Arguments[0..2] -join ' ') -ceq 'postgres flexible-server delete' -and
                    $Arguments[-1] -ceq $restored) {
                    $state.deleted = $true
                    return @{}
                }
                throw 'Unexpected mocked cleanup Azure command.'
            }
            if ($hostState -ceq 'source') {
                Invoke-RealAzureOperation $cleanup cleanup @{} | Out-Null
                Assert-True ($state.deleted -and $cleanup.Owned.Count -eq 0) 'A proven unswitched restore was not cleaned up.'
            } else {
                Assert-Fails { Invoke-RealAzureOperation $cleanup cleanup @{} } `
                    $(if ($hostState -ceq 'unavailable') { 'Synthetic app settings unavailable' } else { 'Cleanup could not prove.*unswitched' })
                Assert-True (-not $state.deleted -and $cleanup.Owned.Contains("postgres-restore:$restored")) `
                    'Cleanup deleted or discarded ownership of a serving or unverified restore.'
            }
            Assert-True ($state.hostReads -eq 1) 'Restore deletion did not inspect the current serving database.'
        }
    }

    foreach ($mode in @('fresh', 'existing')) {
        $target = New-Target $mode
        $context = New-Context $target (New-Fixture $target) "automatic-$mode"
        $parameters = Get-Content -LiteralPath (New-AzureParameterFile $context) -Raw | ConvertFrom-Json
        $adminParameter = $parameters.parameters.postgresAdminPassword
        Assert-True ($null -ne $adminParameter -and
            @($adminParameter.PSObject.Properties.Name).Count -eq 1 -and
            $null -ne $adminParameter.reference -and
            $adminParameter.reference.keyVault.id -ceq $target.existingVaultResourceId -and
            $adminParameter.reference.secretName -ceq 'agent-control-postgres-admin-password' -and
            $adminParameter.reference.secretVersion -ceq (Get-SelectedSecretVersion $target 'agent-control-postgres-admin-password') -and
            $null -eq $parameters.parameters.postgresAdminPasswordSecretVersion) `
            'Database administrator input must be a version-pinned native ARM Key Vault reference, never a secret value.'
        Assert-True (-not $context.ContainsKey('AuthenticationSmokeReceiptPath')) 'Deployment context retained an obsolete approval input.'
        $receipt = Invoke-AzureDeployment $context Deploy
        Assert-True ($receipt.status -ceq 'deployed' -and
            $receipt.evidence.open_and_verify.admission -ceq 'open' -and
            $receipt.evidence.open_and_verify.loginProof -ceq 'not_verified_by_deployment_checks') `
            'Deployment must open normally without a human receipt and must not claim login proof.'
        Assert-True ('database_reopen' -in @($context.Completed) -and
            'authentication_smoke_verify' -notin @($context.Calls)) 'Deployment retained an application-owned authentication approval gate.'
        Assert-True ([array]::IndexOf(@($context.Calls), 'contained_smoke') -lt [array]::IndexOf(@($context.Calls), 'database_reopen') -and
            [array]::IndexOf(@($context.Calls), 'database_reopen') -lt [array]::IndexOf(@($context.Calls), 'open_and_verify')) `
            'Automatic opening bypassed contained smoke or database integrity checks.'
        Assert-True ($context.Owned.Count -eq 0 -and -not $context.BootstrapDirectory -and -not $context.ParameterDirectory) `
            'Deployment left run-owned resources or sensitive directories.'
    }
    $registrationTarget = New-Target
    $registrationFixture = New-Fixture $registrationTarget
    $registrationFixture.commands.registration_verify[1].json[0].appRoleAssignmentRequired = $false
    $registrationContext = New-Context $registrationTarget $registrationFixture 'employee-sign-in'
    $registration = Invoke-DeploymentOperation $registrationContext registration_verify
    Assert-True ($registration.assignmentRequired -ceq $false -and $registration.directoryWrites -eq 0 -and
        $registration.administratorAssignmentCount -eq 1) 'Employee sign-in acquired an assignment-required deployment gate.'
    $mainTemplate = Get-Content -LiteralPath (Join-Path $repositoryRoot 'infra/main.bicep') -Raw
    Assert-True ($mainTemplate -cmatch '(?m)^@secure\(\)\r?\n@description\([^\r\n]*\)\r?\nparam postgresAdminPassword string$' -and
        $mainTemplate.Contains('administratorPassword: postgresAdminPassword') -and
        -not $mainTemplate.Contains('.getSecret(') -and
        -not $mainTemplate.Contains('postgresAdminPasswordSecretVersion')) `
        'The Bicep database module must consume the secure native ARM parameter without an unsupported versioned resource getSecret call.'
    $parameterExample = Get-Content -LiteralPath (Join-Path $repositoryRoot 'infra/main.bicepparam') -Raw
    Assert-True ($parameterExample -cmatch "(?m)^param postgresAdminPassword = az\.getSecret\('[^']+', '[^']+', '[^']+', 'agent-control-postgres-admin-password', '[^']+'\)$" -and
        -not $parameterExample.Contains('postgresAdminPasswordSecretVersion')) `
        'The Bicep parameter example must use the version-aware parameter-file Key Vault function.'

    foreach ($scope in @('missing', 'other-app')) {
        $target = New-Target
        $monitoringFixture = New-Fixture $target
        $queryList = @($monitoringFixture.commands.monitoring_verify | Where-Object {
            $_.arguments[0] -ceq 'monitor' -and $_.arguments[1] -ceq 'scheduled-query'
        })[0]
        $criterion = $queryList.json[0].criteria.allOf[0]
        $criterion.query = if ($scope -ceq 'missing') {
            ([string]$criterion.query).Replace(" | where _ResourceId =~ `"$($target.expectedResourceIds.appService)`"", '')
        } else {
            ([string]$criterion.query).Replace($target.expectedResourceIds.appService, "$($target.expectedResourceIds.appService)-other")
        }
        $monitoring = New-Context $target $monitoringFixture "query-scope-$scope"
        Assert-Fails { Invoke-DeploymentOperation $monitoring monitoring_verify } 'does not match exact structured-event'
    }

    $slashTarget = New-Target
    $slashTarget.canonicalOrigin += '/'
    $slash = New-Context $slashTarget (New-Fixture $slashTarget) 'origin-root-slash'
    Assert-True ((Invoke-AzureDeployment $slash Deploy).status -ceq 'deployed') `
        'An accepted origin ending in a root slash generated incorrect smoke-check paths.'

    $target = New-Target
    $recovery = New-Context $target (New-Fixture $target -Recovery) 'automatic-recovery' 'Recover'
    Assert-True (-not $recovery.ContainsKey('AuthenticationSmokeReceiptPath')) 'Recovery context retained an obsolete approval input.'
    $restorePoint = [DateTimeOffset]::UtcNow.AddMinutes(-10).ToString('o')
    foreach ($command in @($recovery.MockFixture.commands.pitr_restore) + @($recovery.MockFixture.commands.pitr_validate_review)) {
        $command.arguments = @($command.arguments | ForEach-Object { ([string]$_).Replace('{{RESTORE_POINT}}', $restorePoint) })
    }
    $receipt = Invoke-AzureDeployment $recovery Recover -RestorePoint $restorePoint
    Assert-True ($receipt.status -ceq 'recovered' -and $receipt.evidence.open_and_verify.admission -ceq 'open' -and
        $receipt.evidence.recovery_switch.oldServerRetained -eq $true -and
        'authentication_smoke_verify' -notin @($recovery.Calls)) 'Recovery did not reopen automatically after exact restored-data validation.'
    Assert-True ($receipt.evidence.recovery_switch -is [Collections.IDictionary]) 'Recovery evidence included a collection-mutation return value.'

    $pitr = New-Context $target (New-Fixture $target -Pitr) 'unswitched-restore-rehearsal' 'PointInTimeRestore'
    foreach ($command in @($pitr.MockFixture.commands.pitr_restore) + @($pitr.MockFixture.commands.pitr_validate_review)) {
        $command.arguments = @($command.arguments | ForEach-Object { ([string]$_).Replace('{{RESTORE_POINT}}', $restorePoint) })
    }
    Assert-True ((Invoke-AzureDeployment $pitr PointInTimeRestore -RestorePoint $restorePoint).status -ceq 'pitr_rehearsal_succeeded' -and
        $pitr.Owned.Count -eq 0 -and $pitr.CommandOffsets.cleanup -eq 3) `
        'An unswitched restore rehearsal did not safely remove its firewall rule and reviewed server.'

    $switchFixture = New-Fixture $target -Recovery
    $switchFixture.commands.recovery_switch[0].exitCode = 9
    Add-Az $switchFixture cleanup @('webapp', 'config', 'appsettings', 'list', '--ids', $target.expectedResourceIds.appService) -Json @(
        @{ name = 'PGHOST'; value = "$($target.resources.postgresFlexibleServer.name)-restore-{{RUN_ID_8}}.postgres.database.azure.com" }
    )
    $switchFailure = New-Context $target $switchFixture 'uncertain-serving-switch' 'Recover'
    foreach ($command in @($switchFailure.MockFixture.commands.pitr_restore) + @($switchFailure.MockFixture.commands.pitr_validate_review)) {
        $command.arguments = @($command.arguments | ForEach-Object { ([string]$_).Replace('{{RESTORE_POINT}}', $restorePoint) })
    }
    Assert-Fails { Invoke-AzureDeployment $switchFailure Recover -RestorePoint $restorePoint } 'stopped'
    $switchReceipt = Get-Content -LiteralPath $switchFailure.ReceiptPath -Raw | ConvertFrom-Json
    Assert-True ($switchReceipt.status -ceq 'cleanup_failed' -and $switchReceipt.failedStep -ceq 'recovery_switch' -and
        @($switchReceipt.ownedResourcesRemaining).Count -eq 1 -and
        $switchReceipt.ownedResourcesRemaining[0] -ceq "postgres-restore:$($target.resources.postgresFlexibleServer.name)-restore-$($switchFailure.RunId.Substring(0, 8))") `
        'An uncertain serving switch deleted the restored server or discarded its ownership.'

    foreach ($mode in @('fresh','existing')) {
        foreach ($failureStep in @('database_preflight','runtime_access_verify')) {
            $resumeTarget = New-Target $mode
            $resumeFixture = New-Fixture $resumeTarget
            $resumeFixture.commands.$failureStep[0].exitCode = 9
            $interrupted = New-Context $resumeTarget $resumeFixture "resume-$mode-$failureStep"
            Assert-Fails { Invoke-AzureDeployment $interrupted Deploy } 'stopped'
            Assert-True ($interrupted.Owned.Count -eq 0) 'Interrupted deployment retained runner firewall access after cleanup.'
            $retry = New-Context $resumeTarget (New-Fixture $resumeTarget -FreshResourcesExist `
                -ResumeDatabaseInitialized:($failureStep -ceq 'runtime_access_verify')) `
                "retry-$mode-$failureStep" 'Deploy' $interrupted.ReceiptPath
            $retryReceipt = Invoke-AzureDeployment $retry Deploy
            Assert-True ($retryReceipt.status -ceq 'deployed' -and $retry.CommandOffsets.resume_verify -eq 2 -and
                $retry.CommandOffsets.network_reconcile -eq 3 -and $retry.Owned.Count -eq 0) `
                'Resume failed to restore runner access before checking fresh or initialized database state.'
        }
    }

    $partial = New-Context $target (New-Fixture $target) 'partial-bootstrap'
    $partial.SecretValues = @{ 'agent-control-postgres-admin-password' = 'synthetic-admin-password-at-least-thirty-two-characters' }
    Assert-Fails { New-AzureBootstrapDirectory $partial } 'Bootstrap secret values are unavailable'
    Assert-True ($partial.BootstrapDirectory -and -not $partial.BootstrapSecretsMaterialized) 'Partial bootstrap ownership was not tracked.'
    Remove-AzureSensitiveDirectories $partial
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root "artifacts/azure-bootstrap/$($partial.RunId)"))) `
        'Failed bootstrap materialization left an untracked password file.'

    $failureFixture = New-Fixture $target
    $failureFixture.commands.runtime_access_verify[0].exitCode = 9
    $failure = New-Context $target $failureFixture 'contained-failure'
    Assert-Fails { Invoke-AzureDeployment $failure Deploy } 'stopped'
    $receipt = Get-Content -LiteralPath $failure.ReceiptPath -Raw | ConvertFrom-Json
    Assert-True ($receipt.status -ceq 'failed' -and
        $receipt.evidence.containment.admission -ceq 'closed' -and $receipt.evidence.containment.app -ceq 'stopped' -and
        'open_and_verify' -notin @($failure.Calls)) 'A real access failure no longer contains the deployment.'
    $resume = New-Context $target (New-Fixture $target -FreshResourcesExist) 'contained-resume' 'Deploy' $failure.ReceiptPath
    $receipt = Invoke-AzureDeployment $resume Deploy
    Assert-True ($receipt.status -ceq 'deployed' -and 'resume-skip:resource_deploy' -in @($resume.Calls) -and
        'resume-skip:database_initialize' -in @($resume.Calls) -and 'database_reopen' -in @($resume.Completed)) `
        'Current failed receipts no longer resume automatically without replaying completed writes.'

    $uncertainFixture = New-Fixture $target
    $uncertainFixture.commands.resource_deploy[0].exitCode = 9
    $uncertain = New-Context $target $uncertainFixture 'uncertain-resource-deployment'
    Assert-Fails { Invoke-AzureDeployment $uncertain Deploy } 'stopped'
    foreach ($attempt in @('preflight','verify','verify-again')) {
        $retryFixture = New-Fixture $target
        if ($attempt -ceq 'preflight') { $retryFixture.commands.operator_identity[0].exitCode = 9 }
        $retry = New-Context $target $retryFixture "uncertain-$attempt" 'Deploy' $uncertain.ReceiptPath
        Assert-Fails { Invoke-AzureDeployment $retry Deploy } 'stopped'
        $retryReceipt = Get-Content -LiteralPath $retry.ReceiptPath -Raw | ConvertFrom-Json
        Assert-True ($retryReceipt.failedStep -ceq 'resource_deploy' -and 'resource_deploy' -notin @($retry.Calls)) `
            'A failed retry discarded the original uncertain external write or replayed it.'
    }
    $uncertainCleanup = New-Context $target (New-Fixture $target) 'uncertain-cleanup' 'Cleanup' $uncertain.ReceiptPath
    $cleanupReceipt = Invoke-AzureDeployment $uncertainCleanup Cleanup
    Assert-True ($cleanupReceipt.status -ceq 'cleanup_succeeded' -and $cleanupReceipt.failedStep -ceq 'resource_deploy') `
        'Temporary-resource cleanup erased an unresolved external write.'
    $afterCleanup = New-Context $target (New-Fixture $target) 'uncertain-after-cleanup' 'Deploy' $uncertain.ReceiptPath
    Assert-Fails { Invoke-AzureDeployment $afterCleanup Deploy } 'stopped'
    Assert-True ('resource_deploy' -notin @($afterCleanup.Calls)) 'Cleanup authorized replay of an uncertain external write.'

    $smokeFixture = New-Fixture $target
    $smokeFixture.commands.contained_smoke[4].exitCode = 200
    $smokeFailure = New-Context $target $smokeFixture 'unauthenticated-access'
    Assert-Fails { Invoke-AzureDeployment $smokeFailure Deploy } 'stopped'
    $receipt = Get-Content -LiteralPath $smokeFailure.ReceiptPath -Raw | ConvertFrom-Json
    Assert-True ($receipt.failedStep -ceq 'contained_smoke' -and 'database_reopen' -notin @($smokeFailure.Calls) -and
        $receipt.evidence.containment.admission -ceq 'closed') 'Removing an approval gate bypassed actual authentication checks.'

    $mcpTarget = Add-McpTarget (New-Target)
    $privacyDefaults = Get-AzureMcpTarget $mcpTarget
    Assert-True ($privacyDefaults.hide_employee_details -ceq $false -and $privacyDefaults.hide_champion_employee -ceq $false) 'Absent privacy must default false.'
    $privacyTemplate=Get-Content -LiteralPath (Join-Path $repositoryRoot 'infra/main.bicep') -Raw
    foreach ($key in @('hide_employee_details','hide_champion_employee')) {
        Assert-True ($privacyTemplate.Contains("value: (contains(mcpMetadata, '$key') ? mcpMetadata.$key : false) ? 'true' : 'false'")) 'API privacy environment must use explicit lowercase literals, including absent false.'
    }
    foreach ($employee in @($false,$true)) {
        foreach ($champion in @($false,$true)) {
            $privacyTarget = Copy-Object $mcpTarget
            $privacyTarget.mcp.hide_employee_details=$employee
            $privacyTarget.mcp.hide_champion_employee=$champion
            $validated = Get-AzureMcpTarget $privacyTarget
            Assert-True ($validated.hide_employee_details -ceq $employee -and $validated.hide_champion_employee -ceq $champion) 'Azure privacy booleans became coupled.'
            $privacyContext=New-Context $privacyTarget (New-Fixture $privacyTarget) "privacy-$employee-$champion"
            $parameters=Get-Content -LiteralPath (New-AzureParameterFile $privacyContext) -Raw | ConvertFrom-Json
            Assert-True ($parameters.parameters.mcpMetadata.value.hide_employee_details -ceq $employee -and
                $parameters.parameters.mcpMetadata.value.hide_champion_employee -ceq $champion) 'Azure API runtime privacy differs from saved settings.'
        }
    }
    foreach ($name in @('hide_employee_details','hide_champion_employee')) {
        foreach ($value in @($null,'false',0)) {
            $invalidPrivacy=Copy-Object $mcpTarget
            $invalidPrivacy.mcp.$name=$value
            Assert-Fails { Get-AzureMcpTarget $invalidPrivacy } 'must be a boolean'
        }
    }
    $reservedTarget = Copy-Object $mcpTarget
    $reservedTarget.mcp.publicUrl = "https://$($reservedTarget.mcp.appServiceName).azurewebsites.net/internal/mcp-metadata"
    Assert-Fails { Get-AzureMcpTarget $reservedTarget } 'exact public resource'
    $combined = New-Context $mcpTarget (New-Fixture $mcpTarget) 'combined'
    $receipt = Invoke-AzureDeployment $combined Deploy
    Assert-True ($receipt.status -ceq 'deployed' -and
        [array]::IndexOf(@($combined.Calls), 'open_and_verify') -lt [array]::IndexOf(@($combined.Calls), 'mcp_apply') -and
        $receipt.evidence.mcp_verify.authenticatedApiConnectivity -ceq 'not_proven') `
        'Optional MCP deployment no longer preserves application availability or truthful verification.'
    Assert-True ($receipt.evidence.runtime_access_verify.metadataReferenceStatus -ceq 'unavailable' -and
        $receipt.evidence.runtime_access_verify.mcpOAuthSecretsReadable -eq $false) 'An unresolved optional metadata reference blocked business admission or gained OAuth authority.'
    $apiParameters = Get-Content -LiteralPath (New-AzureParameterFile $combined) -Raw | ConvertFrom-Json
    $mcpParameters = Get-Content -LiteralPath (New-AzureMcpParameterFile $combined) -Raw | ConvertFrom-Json
    Assert-True ($apiParameters.parameters.mcpMetadata.value.secret.version -ceq $mcpParameters.parameters.metadataSecret.value.version -and
        $apiParameters.parameters.mcpMetadata.value.secret.name -ceq 'agent-control-mcp-metadata' -and
        $apiParameters.parameters.mcpMetadata.value.tenantId -ceq $mcpTarget.mcp.tenantId -and
        $apiParameters.parameters.mcpMetadata.value.origin -ceq ([Uri]$mcpTarget.mcp.publicUrl).GetLeftPart([UriPartial]::Authority)) `
        'API/MCP did not receive the same pinned metadata-only secret and fixed binding.'
    foreach ($kind in @('missing','invalid','malformed')) {
        $optionalTarget = Add-McpTarget (New-Target)
        if ($kind -eq 'missing') { $optionalTarget.mcp.secrets.PSObject.Properties.Remove('metadata') }
        elseif ($kind -eq 'malformed') {
            $optionalTarget.mcp.secrets.metadata | Add-Member -NotePropertyName value -NotePropertyValue 'synthetic-metadata-value-never-persist'
        }
        else { $optionalTarget.mcp.secrets.metadata.version = '@Microsoft.KeyVault(unresolved)' }
        Assert-True ((Get-AzureMcpMetadataReference $optionalTarget.mcp).Count -eq 0 -and
            $null -ne (Get-AzureMcpTarget $optionalTarget)) 'Optional metadata-only configuration vetoed valid MCP business configuration.'
        $optionalFixture = New-Fixture $optionalTarget
        $optionalFixture.commands.mcp_preflight[2].json += @{
            roleDefinitionId='/roles/4633458b-17de-408a-b874-0445c86b69e6'
            scope="$($optionalTarget.existingVaultResourceId)/secrets/agent-control-mcp-metadata"
        }
        $optional = New-Context $optionalTarget $optionalFixture "optional-$kind"
        $optionalReceipt = Invoke-AzureDeployment $optional Deploy
        Assert-True ($optionalReceipt.status -ceq 'deployed' -and
            $optionalReceipt.evidence.runtime_access_verify.metadataReferenceStatus -ceq 'unavailable') 'Optional metadata failure did not remain scoped through deployment.'
        $optionalParametersPath = New-AzureMcpParameterFile $optional
        $optionalParameters = Get-Content -LiteralPath $optionalParametersPath -Raw | ConvertFrom-Json
        Assert-True ('metadata' -cnotin @($optionalReceipt.mcp.contract.secrets.PSObject.Properties.Name) -and
            'metadata' -cnotin @($optionalParameters.parameters.mcp.value.secrets.PSObject.Properties.Name) -and
            @($optionalParameters.parameters.metadataSecret.value.PSObject.Properties).Count -eq 0) `
            'Malformed optional metadata was persisted instead of being omitted from deployment contracts.'
        $persisted = (Get-Content -LiteralPath $optional.ReceiptPath -Raw) + (Get-Content -LiteralPath $optionalParametersPath -Raw)
        Assert-True (-not $persisted.Contains('synthetic-metadata-value-never-persist')) 'Malformed metadata exposed an unvalidated value in deployment artifacts.'
    }
    $grantTarget = Add-McpTarget (New-Target)
    foreach ($scope in @($grantTarget.existingVaultResourceId, "$($grantTarget.existingVaultResourceId)/secrets/unrelated-secret")) {
        $grantFixture = New-Fixture $grantTarget
        $grantFixture.commands.mcp_preflight[2].json += @{
            roleDefinitionId='/roles/4633458b-17de-408a-b874-0445c86b69e6'; scope=$scope
        }
        $grantContext = New-Context $grantTarget $grantFixture "metadata-grant-denied-$script:Checks"
        Assert-Fails { Invoke-DeploymentOperation $grantContext mcp_preflight } 'broad/custom/inherited'
    }
    $forbiddenTarget = Add-McpTarget (New-Target)
    $forbiddenFixture = New-Fixture $forbiddenTarget
    $role = '4633458b-17de-408a-b874-0445c86b69e6'
    $forbiddenFixture.commands.runtime_access_verify[3].json = @(@{roleDefinitionId=$role})
    $roleFixture = @{commands=@{runtime_access_verify=@()}}
    Add-Az $roleFixture runtime_access_verify @('role','definition','list','--name',$role) -Json @(@{permissions=@(@{dataActions=@('Microsoft.KeyVault/vaults/secrets/getSecret/action');notDataActions=@()})})
    $entries = $forbiddenFixture.commands.runtime_access_verify
    $forbiddenFixture.commands.runtime_access_verify = @($entries[0..3]) + @($roleFixture.commands.runtime_access_verify) + @($entries[4..($entries.Count-1)])
    $forbidden = New-Context $forbiddenTarget $forbiddenFixture 'api-oauth-secret-denied'
    Assert-Fails { Invoke-AzureDeployment $forbidden Deploy } 'stopped'
    $forbiddenReceipt = Get-Content -LiteralPath $forbidden.ReceiptPath -Raw | ConvertFrom-Json
    Assert-True ($forbiddenReceipt.failedStep -ceq 'runtime_access_verify') 'API OAuth-secret authority escaped least-privilege verification.'
    Write-Host "Passed $script:Checks isolated Azure deployment unit assertions; all external commands and HTTP calls were fixture-mocked."
} finally {
    $script:ActiveAzureContext = $null
    foreach ($context in $script:Contexts) { Remove-AzureSensitiveDirectories $context }
    Remove-Item -LiteralPath $root -Recurse -Force
}
