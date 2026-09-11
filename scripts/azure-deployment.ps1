#requires -Version 7.0

$script:RequiredSecretNames = @(
    'agent-control-tenant-id',
    'agent-control-client-id',
    'agent-control-client-secret',
    'agent-control-session-secret',
    'agent-control-postgres-admin-password',
    'agent-control-postgres-app-password'
)
$script:RuntimeSecretNames = @($script:RequiredSecretNames | Where-Object { $_ -ne 'agent-control-postgres-admin-password' })
$script:EstimateItemNames = @(
    'appService',
    'postgresCompute',
    'postgresStorage',
    'postgresBackup',
    'monitoring',
    'keyVault',
    'networking',
    'restoreDrill'
)

function Get-SelectedSecretVersion {
    param($Target, [string]$SecretName)
    $selected = @($Target.preparedVaultContract.versions | Where-Object { $_.name -ceq $SecretName })
    if ($selected.Count -ne 1 -or [string]$selected[0].version -notmatch '^[a-zA-Z0-9]{1,64}$') {
        throw "Secret $SecretName requires one explicit non-secret version."
    }
    return [string]$selected[0].version
}

function Get-ChangedSecretVersionNames {
    param($Target)
    if ($Target.installationMode -eq 'fresh') { return @() }
    $changed = @()
    foreach ($name in $script:RequiredSecretNames) {
        $existing = @($Target.preparedVaultContract.existingVersions | Where-Object { $_.name -ceq $name })
        if ($existing.Count -eq 1 -and [string]$existing[0].version -cne (Get-SelectedSecretVersion $Target $name)) { $changed += $name }
    }
    return $changed
}

function Assert-GuidValue {
    param([string]$Value, [string]$Name)
    if ($Value -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') {
        throw "$Name must be an explicit GUID."
    }
}

function Assert-ResourceName {
    param([string]$Value, [string]$Name, [int]$Maximum = 63)
    if (-not $Value -or $Value.Length -gt $Maximum -or $Value -notmatch '^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$') {
        throw "$Name is invalid."
    }
}

function Get-TargetResourceId {
    param($Target, [string]$ProviderType, [string]$Name)
    return "/subscriptions/$($Target.subscriptionId)/resourceGroups/$($Target.resourceGroup)/providers/$ProviderType/$Name"
}

function ConvertTo-CanonicalJson {
    param($Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [string]) { return ($Value | ConvertTo-Json -Compress) }
    if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
    if ($Value -is [ValueType]) { return ([Convert]::ToString($Value, [Globalization.CultureInfo]::InvariantCulture)) }
    if ($Value -is [Collections.IDictionary] -or $Value -is [PSCustomObject]) {
        $properties = if ($Value -is [Collections.IDictionary]) { @($Value.Keys) } else { @($Value.PSObject.Properties.Name) }
        return '{' + (($properties | Sort-Object | ForEach-Object {
            $propertyValue = if ($Value -is [Collections.IDictionary]) { $Value[$_] } else { $Value.$_ }
            "$($_ | ConvertTo-Json -Compress):$(ConvertTo-CanonicalJson $propertyValue)"
        }) -join ',') + '}'
    }
    return '[' + ((@($Value) | ForEach-Object { ConvertTo-CanonicalJson $_ }) -join ',') + ']'
}

function Get-TargetApprovalDigest {
    param($Target)
    $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-CanonicalJson $Target))
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Test-ApprovedQualificationTargets {
    param($Qualification, $Target)
    if ($null -eq $Qualification) { return @{ approved = $false; phase13ActionsDisabled = $true } }
    if ($Qualification.contractVersion -ne 1 -or $Qualification.isApproval -ne $true -or
        $Qualification.tenantId -ine $Target.tenantId -or $Qualification.entraApplicationId -ine $Target.entraApplicationId -or
        $Qualification.canonicalOrigin -cne $Target.canonicalOrigin) {
        throw 'Qualification target identity does not match the approved deployment.'
    }
    $expires = [DateTimeOffset]$Qualification.expiresAt
    if ($expires -le [DateTimeOffset]::UtcNow -or $expires -gt [DateTimeOffset]::UtcNow.AddDays(30) -or
        [string]::IsNullOrWhiteSpace([string]$Qualification.restorationOwner)) {
        throw 'Qualification expiry/restoration ownership is invalid.'
    }
    $roles = @('AgentControl.Reader', 'AgentControl.Operator', 'AgentControl.SecurityReader', 'AgentControl.Administrator')
    foreach ($persona in @($Qualification.personas)) {
        Assert-GuidValue $persona.principalObjectId 'Qualification principalObjectId'
        if (-not @($persona.appRoles).Count -or @($persona.appRoles | Where-Object { $_ -notin $roles }).Count) {
            throw 'Qualification persona contains an unknown or empty role set.'
        }
    }
    foreach ($canary in @($Qualification.nativeCanaryTargets)) {
        if ([string]::IsNullOrWhiteSpace([string]$canary.resourceNativeId) -or
            [string]::IsNullOrWhiteSpace([string]$canary.environmentId) -or
            [string]::IsNullOrWhiteSpace([string]$canary.botId) -or
            $canary.capability -cne 'copilot_studio_quarantine' -or
            @(Compare-Object @($canary.allowedActions) @('quarantine', 'unquarantine') -CaseSensitive).Count -or
            $canary.requiredFinalState -cne 'recorded-prestate') {
            throw 'Qualification canary is not an exact reversible native target.'
        }
    }
    return @{
        approved = $true
        expiresAt = $expires.ToString('o')
        personaCount = @($Qualification.personas).Count
        canaryCount = @($Qualification.nativeCanaryTargets).Count
        restorationOwnerRecorded = $true
    }
}

function Test-ApprovedAzureTarget {
    param(
        [Parameter(Mandatory)]$Target,
        [ValidateSet('Real', 'Mock')][string]$ExecutionMode
    )
    if ($Target.contractVersion -ne 2 -or $Target.isApproval -ne $true) {
        throw 'Target contract version 2 and explicit isApproval=true are required.'
    }
    Assert-GuidValue $Target.tenantId 'tenantId'
    Assert-GuidValue $Target.subscriptionId 'subscriptionId'
    Assert-GuidValue $Target.entraApplicationId 'entraApplicationId'
    if ($Target.resourceGroup -notmatch '^[a-zA-Z0-9._()/-]{1,90}$' -or $Target.resourceGroup -match '[/\\]') {
        throw 'resourceGroup is invalid.'
    }
    if ($Target.region -notmatch '^[a-z0-9]{2,32}$') { throw 'region must be explicit.' }
    Assert-ResourceName $Target.resources.appServicePlan.name 'App Service Plan name' 40
    Assert-ResourceName $Target.resources.appService.name 'App Service name' 60
    Assert-ResourceName $Target.resources.postgresFlexibleServer.name 'PostgreSQL server name' 63

    $origin = [Uri]$Target.canonicalOrigin
    if (-not $origin.IsAbsoluteUri -or $origin.Scheme -ne 'https' -or $origin.UserInfo -or $origin.Query -or $origin.Fragment -or $origin.AbsolutePath -ne '/') {
        throw 'canonicalOrigin must be one canonical HTTPS origin.'
    }
    if ($Target.callbackUri -cne "$($Target.canonicalOrigin.TrimEnd('/'))/api/auth/callback") {
        throw 'callbackUri must use the canonical origin and exact callback path.'
    }

    $vaultPattern = '^/subscriptions/([^/]+)/resourceGroups/([^/]+)/providers/Microsoft\.KeyVault/vaults/([^/]+)$'
    $vault = [regex]::Match([string]$Target.existingVaultResourceId, $vaultPattern, 'IgnoreCase')
    if (-not $vault.Success -or $vault.Groups[1].Value -ine $Target.subscriptionId) {
        throw 'The full existing Key Vault ID must be in the approved subscription.'
    }
    if ($Target.resources.appServicePlan.sku -cne 'B1' -or $Target.resources.appServicePlan.linux -ne $true -or $Target.resources.appServicePlan.instanceCount -ne 1) {
        throw 'Only the explicitly approved single Linux Basic B1 App Service Plan is implemented; a tier change needs a revised template, estimate and approval.'
    }
    $postgres = $Target.resources.postgresFlexibleServer
    if ($postgres.sku -cne 'Standard_B1ms' -or $postgres.tier -cne 'Burstable' -or $postgres.version -ne 17 -or
        $postgres.storageGiB -ne 32 -or $postgres.backupRetentionDays -ne 7 -or $postgres.highAvailability -ne $false -or
        $postgres.replicas -ne 0 -or $postgres.applicationPoolMaximum -ne 4) {
        throw 'Only PostgreSQL 17 Standard_B1ms/32 GiB/seven-day/no-HA/no-replica/pool-four is implemented; changes need renewed estimate and approval.'
    }
    if ($Target.resources.appService.nodeMajor -ne 24 -or $Target.resources.appService.remoteBuildEnabled -ne $false) {
        throw 'The release requires built-in Node 24 with remote rebuild disabled.'
    }
    if (@($Target.resources.approvedAppOutboundIpv4Addresses).Count -lt 1 -or
        @($Target.resources.approvedAppOutboundIpv4Addresses | Where-Object { $_ -notmatch '^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$' }).Count) {
        throw 'At least one exact approved App Service outbound IPv4 address is required; broad or implicit firewall access is forbidden.'
    }
    if ($Target.runnerIpv4Address -notmatch '^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$') {
        throw 'An exact approved runner IPv4 address is required.'
    }

    $expectedPlan = Get-TargetResourceId $Target 'Microsoft.Web/serverfarms' $Target.resources.appServicePlan.name
    $expectedApp = Get-TargetResourceId $Target 'Microsoft.Web/sites' $Target.resources.appService.name
    $expectedPostgres = Get-TargetResourceId $Target 'Microsoft.DBforPostgreSQL/flexibleServers' $postgres.name
    if ($Target.expectedResourceIds.appServicePlan -ine $expectedPlan -or $Target.expectedResourceIds.appService -ine $expectedApp -or
        $Target.expectedResourceIds.postgresFlexibleServer -ine $expectedPostgres -or $Target.expectedDatabaseName -cne 'agentcontrol') {
        throw 'Expected resource/database identities do not exactly match the approved target.'
    }
    if ($Target.installationMode -notin @('fresh', 'upgrade', 'legacy_import')) { throw 'installationMode is invalid.' }
    if ($Target.installationMode -eq 'fresh' -and $Target.firstInstallApproved -ne $true) {
        throw 'Fresh install requires an explicit first-install approval.'
    }
    if ($Target.installationMode -ne 'fresh' -and $Target.firstInstallApproved -eq $true) {
        throw 'Existing-target deployment cannot also approve fresh initialization.'
    }
    if ($Target.expectedSchemaVersion -ne 26) { throw 'The approved baseline must name immutable schema version 26.' }
    if ($Target.installationMode -eq 'legacy_import') {
        if (-not $Target.legacyAuditBackupPath -or $Target.legacyAuditBackupSha256 -notmatch '^[a-f0-9]{64}$') {
            throw 'Legacy import requires one bounded SQLite-safe backup path and exact checksum.'
        }
    } elseif ($Target.legacyAuditBackupPath -or $Target.legacyAuditBackupSha256) {
        throw 'Legacy audit inputs are accepted only for legacy_import mode.'
    }

    if (@(Compare-Object @($Target.preparedVaultContract.secretNames) @($script:RequiredSecretNames) -CaseSensitive).Count -or
        @(Compare-Object @($Target.preparedVaultContract.runtimeConsumers) @($script:RuntimeSecretNames) -CaseSensitive).Count -or
        $Target.preparedVaultContract.administratorPasswordRuntimeAccessible -ne $false -or
        $Target.preparedVaultContract.bootstrapSecretCleanupRequired -ne $true) {
        throw 'Prepared-vault names and five-runtime-consumer contract do not match.'
    }
    foreach ($name in $script:RequiredSecretNames) {
        Get-SelectedSecretVersion $Target $name | Out-Null
    }
    if (@($Target.preparedVaultContract.versions).Count -ne 6) { throw 'Prepared vault must select exactly six versions.' }
    if ($Target.installationMode -ne 'fresh') {
        if (@($Target.preparedVaultContract.existingVersions).Count -ne 6) {
            throw 'Existing deployment requires its six previously selected versions for a fail-closed credential comparison.'
        }
        foreach ($name in $script:RequiredSecretNames) {
            $existing = @($Target.preparedVaultContract.existingVersions | Where-Object { $_.name -ceq $name })
            if ($existing.Count -ne 1 -or [string]$existing[0].version -notmatch '^[a-zA-Z0-9]{1,64}$') {
                throw "Existing version evidence is invalid for $name."
            }
        }
        $changedVersions = @(Get-ChangedSecretVersionNames $Target)
        if ($changedVersions.Count) {
            throw 'Selected/current credential versions differ; complete the separately approved Phase 11 coordinated-rotation prerequisite before running deploy-azure.ps1.'
        }
    }

    $estimate = $Target.estimate
    $estimateDate = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParseExact([string]$estimate.asOfDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$estimateDate)) { throw 'Estimate date must be YYYY-MM-DD.' }
    $age = [DateTimeOffset]::UtcNow.Date - $estimateDate.UtcDateTime.Date
    if ($age.TotalDays -lt 0 -or $age.TotalDays -gt 31) { throw 'Estimate must be current within 31 days.' }
    if ($estimate.currency -notmatch '^[A-Z]{3}$' -or [string]::IsNullOrWhiteSpace($estimate.source)) {
        throw 'Estimate requires explicit currency and dated source.'
    }
    $syntheticSource = $estimate.source -match '(?i)synthetic|fixture|example'
    if ($ExecutionMode -eq 'Real' -and $syntheticSource) { throw 'Synthetic fixture pricing is never a real quote.' }
    if ($ExecutionMode -eq 'Mock' -and -not $syntheticSource) { throw 'Mock validation must label pricing as synthetic fixture evidence.' }
    $total = [decimal]0
    foreach ($name in $script:EstimateItemNames) {
        $amount = $estimate.items.$name
        if ($null -eq $amount -or [decimal]$amount -lt 0) { throw "Estimate item $name is missing or invalid." }
        $total += [decimal]$amount
    }
    if ([decimal]$estimate.monthlyTotal -ne $total -or [decimal]$Target.approvedMonthlyBudget -lt $total) {
        throw 'Itemized estimate total must be exact and within the approved monthly budget.'
    }

    foreach ($field in @('approvedBy', 'approvedAt', 'changeReference')) {
        if ([string]::IsNullOrWhiteSpace([string]$Target.operatorApproval.$field)) { throw "Operator approval $field is required." }
    }
    try { $approvedAt = [DateTimeOffset]$Target.operatorApproval.approvedAt }
    catch { throw 'Operator approval time must be a valid timestamp.' }
    if ($approvedAt -lt $estimateDate -or $approvedAt -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) {
        throw 'Operator approval time must be current, after the dated estimate, and not in the future.'
    }
    if ($Target.riskAcceptance.burstablePocLimitationsAccepted -ne $true -or
        [string]::IsNullOrWhiteSpace([string]$Target.riskAcceptance.reference)) {
        throw 'Explicit acceptance of Burstable production/support/CPU-credit limitations is required.'
    }
    $windowStart = [DateTimeOffset]$Target.maintenanceApproval.windowStartsAt
    $windowEnd = [DateTimeOffset]$Target.maintenanceApproval.windowEndsAt
    if ($windowEnd -le $windowStart -or ($windowEnd - $windowStart).TotalHours -gt 8 -or
        [string]::IsNullOrWhiteSpace([string]$Target.maintenanceApproval.approvedBy)) {
        throw 'A finite approved maintenance window no longer than eight hours is required.'
    }
    if ($Target.resources.monitoring.retentionDays -ne 30 -or [decimal]$Target.resources.monitoring.dailyIngestionLimitGiB -ne 0.1) {
        throw 'Monitoring retention must be 30 days with the approved 0.1 GiB daily cap.'
    }
    if ($Target.resources.monitoring.actionGroupResourceId -notmatch "^/subscriptions/$([regex]::Escape($Target.subscriptionId))/resourceGroups/[^/]+/providers/Microsoft\.Insights/actionGroups/[^/]+$") {
        throw 'An exact existing action-group resource ID in the approved subscription is required.'
    }
    if ($Target.legacyStaticWebApp.resourceId) {
        if ($Target.legacyStaticWebApp.resourceId -notmatch "^/subscriptions/$([regex]::Escape($Target.subscriptionId))/resourceGroups/[^/]+/providers/Microsoft\.Web/staticSites/[^/]+$" -or
            $Target.legacyStaticWebApp.retirementApproved -ne $true -or
            [string]::IsNullOrWhiteSpace([string]$Target.legacyStaticWebApp.approvalReference)) {
            throw 'Legacy Static Web App retirement requires its exact approved identity and approval reference.'
        }
    }
    return $Target
}

function Read-ApprovedAzureTarget {
    param([string]$Path, [ValidateSet('Real', 'Mock')][string]$ExecutionMode)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Approved target file was not found.' }
    $target = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 30
    return Test-ApprovedAzureTarget $target $ExecutionMode
}

function Test-ReleaseArtifact {
    param([string]$ArtifactPath)
    if (-not (Test-Path -LiteralPath $ArtifactPath -PathType Leaf)) { throw 'Linux/x64 release ZIP was not found.' }
    $sidecar = "$ArtifactPath.sha256"
    if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) { throw 'Release checksum sidecar was not found.' }
    $line = (Get-Content -LiteralPath $sidecar -Raw).Trim()
    if ($line -notmatch '^([a-f0-9]{64}) {2}agent-control-linux-x64\.zip$') { throw 'Release checksum sidecar is invalid.' }
    $actual = (Get-FileHash -LiteralPath $ArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $Matches[1]) { throw 'Release archive checksum does not match its sidecar.' }
    return @{ checksum = $actual; bytes = (Get-Item -LiteralPath $ArtifactPath).Length }
}

function Protect-AzureBootstrapPath {
    param([string]$Path, [switch]$Directory)
    if (-not $IsWindows) {
        [IO.File]::SetUnixFileMode($Path, $(if ($Directory) { [IO.UnixFileMode]448 } else { [IO.UnixFileMode]384 }))
    } else {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        & icacls $Path '/inheritance:r' '/grant:r' "${identity}:(F)" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not restrict bootstrap path permissions.' }
    }
}

function Invoke-ExternalCommand {
    param([string]$FilePath, [string[]]$Arguments, [switch]$SensitiveOutput, [switch]$AllowFailure)
    if ($script:ActiveAzureContext -and $script:ActiveAzureContext.ExecutionMode -eq 'Mock') {
        $mock = Invoke-CommandFixture $script:ActiveAzureContext $FilePath $Arguments
        $output = @($mock.output)
        $code = [int]$mock.code
    } else {
        $output = @(& $FilePath @Arguments 2>&1)
        $code = $LASTEXITCODE
    }
    if ($code -ne 0 -and -not $AllowFailure) {
        $suffix = if ($SensitiveOutput) { '' } else { " $((@($output) -join ' ').Substring(0, [Math]::Min(512, (@($output) -join ' ').Length)))" }
        throw "External command failed with exit code $code.$suffix"
    }
    return @{ code = $code; output = (@($output) -join "`n") }
}

function Get-AzJson {
    param([string[]]$Arguments, [switch]$SensitiveOutput, [switch]$AllowFailure)
    $result = Invoke-ExternalCommand 'az' ($Arguments + @('--only-show-errors', '-o', 'json')) -SensitiveOutput:$SensitiveOutput -AllowFailure:$AllowFailure
    if ($result.code -ne 0) { return @{ commandFailed = $true; exitCode = $result.code } }
    return $result.output | ConvertFrom-Json -Depth 30
}

function New-AzureDeploymentContext {
    param(
        [string]$Root,
        $Target,
        [ValidateSet('Real', 'Mock')][string]$ExecutionMode,
        [string]$MockFixturePath,
        [string]$ArtifactPath,
        [string]$ReceiptPath,
        [string]$ResumeReceiptPath,
        [ValidateSet('Plan', 'Deploy', 'PointInTimeRestore', 'Recover', 'Cleanup')][string]$RequestedAction,
        [string]$AuthenticationSmokeReceiptPath,
        $QualificationTargets
    )
    $fixture = $null
    if ($ExecutionMode -eq 'Mock') {
        if (-not $MockFixturePath -or -not (Test-Path -LiteralPath $MockFixturePath -PathType Leaf)) { throw 'Mock execution requires an explicit fixture.' }
        $fixture = Get-Content -LiteralPath $MockFixturePath -Raw | ConvertFrom-Json -Depth 30
        if ($fixture.fixtureVersion -ne 2 -or $fixture.rejectUnexpected -ne $true -or -not $fixture.commands) {
            throw 'Mock fixture version 2 must reject every unexpected command.'
        }
    }
    $context = @{
        Root = [IO.Path]::GetFullPath($Root)
        Target = $Target
        ExecutionMode = $ExecutionMode
        MockFixture = $fixture
        ArtifactPath = [IO.Path]::GetFullPath($ArtifactPath)
        ReceiptPath = [IO.Path]::GetFullPath($ReceiptPath)
        RunId = [Guid]::NewGuid().ToString('N')
        Calls = [Collections.Generic.List[string]]::new()
        Completed = [Collections.Generic.List[string]]::new()
        Owned = [Collections.Generic.List[string]]::new()
        CommandOffsets = @{}
        SecretValues = @{}
        BootstrapDirectory = $null
        BootstrapSecretsMaterialized = $false
        ParameterDirectory = $null
        RestoredServerName = $null
        ServingServerName = $Target.resources.postgresFlexibleServer.name
        QualificationTargets = $QualificationTargets
        AuthenticationSmokeReceiptPath = $(if ($AuthenticationSmokeReceiptPath) { [IO.Path]::GetFullPath($AuthenticationSmokeReceiptPath) } else { $null })
        Resuming = $false
        ResumeEvidence = @{}
        PreviousFailedStep = $null
        ResumeStatus = $null
        RequestedAction = $RequestedAction
        ReceiptAction = $RequestedAction
    }
    if ($ResumeReceiptPath) {
        Import-AzureDeploymentReceipt $context ([IO.Path]::GetFullPath($ResumeReceiptPath)) $RequestedAction
    } elseif ($RequestedAction -eq 'Cleanup') {
        throw 'Cleanup requires -ResumeReceiptPath for the exact failed receipt; a new empty cleanup run is forbidden.'
    }
    return $context
}

function Resolve-CommandFixtureToken {
    param($Context, $Value)
    if ($Value -is [DateTime]) { $Value = ([DateTimeOffset]$Value).ToUniversalTime().ToString('o') }
    $Value = [string]$Value
    $parameterFile = Join-Path $Context.Root "artifacts/azure-parameters/$($Context.RunId)/parameters.json"
    return $Value.Replace('{{ROOT}}', $Context.Root).
        Replace('{{RUN_ID}}', $Context.RunId).
        Replace('{{RUN_ID_8}}', $Context.RunId.Substring(0, 8)).
        Replace('{{ARTIFACT}}', $Context.ArtifactPath).
        Replace('{{PARAMETER_FILE}}', $parameterFile).
        Replace('{{ORIGIN}}', [string]$Context.Target.canonicalOrigin).
        Replace('{{BACKUP_COMPLETED_AT}}', [DateTimeOffset]::UtcNow.ToString('o')).
        Replace('{{POSTGRES_SERVER}}', [string]$Context.Target.resources.postgresFlexibleServer.name)
}

function Invoke-CommandFixture {
    param($Context, [string]$FilePath, [string[]]$Arguments)
    $operation = [string]$Context.ActiveOperation
    $property = $Context.MockFixture.commands.PSObject.Properties[$operation]
    if (-not $property) { throw "Mock rejected unexpected command in operation '$operation'." }
    $commands = @($property.Value)
    $offset = if ($Context.CommandOffsets.ContainsKey($operation)) { [int]$Context.CommandOffsets[$operation] } else { 0 }
    if ($offset -ge $commands.Count) { throw "Mock rejected extra command in operation '$operation'." }
    $expected = $commands[$offset]
    $expectedArguments = @($expected.arguments | ForEach-Object { Resolve-CommandFixtureToken $Context $_ })
    if ([string]$expected.executable -cne $FilePath -or
        @(Compare-Object $expectedArguments @($Arguments) -CaseSensitive -SyncWindow 0).Count) {
        $mismatch = 0
        while ($mismatch -lt $expectedArguments.Count -and $mismatch -lt $Arguments.Count -and
            $expectedArguments[$mismatch] -ceq $Arguments[$mismatch]) { $mismatch++ }
        $expectedValue = if ($mismatch -lt $expectedArguments.Count) { $expectedArguments[$mismatch] } else { '<missing>' }
        $actualValue = if ($mismatch -lt $Arguments.Count) { $Arguments[$mismatch] } else { '<missing>' }
        throw "Mock rejected unexpected command '$FilePath' in operation '$operation' at argument $mismatch (expected '$expectedValue', received '$actualValue')."
    }
    $Context.CommandOffsets[$operation] = $offset + 1
    if ($Context.MockFixture.commandLogPath) {
        $logPath = [IO.Path]::GetFullPath((Resolve-CommandFixtureToken $Context ([string]$Context.MockFixture.commandLogPath)))
        $allowedRoot = [IO.Path]::GetFullPath((Join-Path $Context.Root 'artifacts/test-scratch')) + [IO.Path]::DirectorySeparatorChar
        if (-not $logPath.StartsWith($allowedRoot, [StringComparison]::Ordinal)) { throw 'Mock command log must stay in artifacts/test-scratch.' }
        [IO.Directory]::CreateDirectory((Split-Path $logPath -Parent)) | Out-Null
        Add-Content -LiteralPath $logPath -Value (@{ operation = $operation; executable = $FilePath; arguments = @($Arguments) } | ConvertTo-Json -Compress)
    }
    $output = if ($expected.PSObject.Properties['json']) {
        Resolve-CommandFixtureToken $Context ($expected.json | ConvertTo-Json -Depth 30 -Compress)
    } else {
        [string]$expected.output
    }
    return @{ code = $(if ($null -eq $expected.exitCode) { 0 } else { [int]$expected.exitCode }); output = $output }
}

function Invoke-DeploymentHttpGet {
    param($Context, [string]$Uri)
    if ($Context.ExecutionMode -eq 'Mock') {
        $result = Invoke-ExternalCommand '__http_get__' @($Uri) -AllowFailure
        return @{ statusCode = $result.code; body = [string]$result.output; contentType = 'application/json' }
    }
    $response = Invoke-WebRequest -Uri $Uri -Method Get -TimeoutSec 20 -SkipHttpErrorCheck -MaximumRedirection 0
    return @{ statusCode = [int]$response.StatusCode; body = [string]$response.Content; contentType = [string]$response.Headers.'Content-Type' }
}

function Test-AuthenticationSmokeReceipt {
    param($Context, [string]$ContainedStartedAt)
    if (-not $Context.AuthenticationSmokeReceiptPath -or -not (Test-Path -LiteralPath $Context.AuthenticationSmokeReceiptPath -PathType Leaf)) {
        throw 'A human-approved authentication smoke receipt is required before public admission can open.'
    }
    $receipt = Get-Content -LiteralPath $Context.AuthenticationSmokeReceiptPath -Raw | ConvertFrom-Json -Depth 20
    $artifact = Test-ReleaseArtifact $Context.ArtifactPath
    $performedAt = [DateTimeOffset]::MinValue
    if ($receipt.receiptVersion -ne 1 -or $receipt.isApproval -ne $true -or $receipt.loginCallbackSessionVerified -ne $true) {
        throw 'Authentication smoke receipt must be an explicit version-1 login/callback/session approval.'
    }
    if ($receipt.deploymentRunId -cne $Context.RunId -or $receipt.targetApprovalDigest -cne (Get-TargetApprovalDigest $Context.Target)) {
        throw 'Authentication smoke receipt does not bind the exact deployment run and approved target.'
    }
    if ($receipt.canonicalOrigin -cne $Context.Target.canonicalOrigin -or $receipt.callbackUri -cne $Context.Target.callbackUri -or
        $receipt.artifactSha256 -cne $artifact.checksum) {
        throw 'Authentication smoke receipt does not bind the exact origin, callback and artifact.'
    }
    try { $performedAt = [DateTimeOffset]$receipt.performedAt } catch { throw 'Authentication smoke receipt approval/time evidence is invalid.' }
    if ([string]::IsNullOrWhiteSpace([string]$receipt.approvedBy) -or [string]::IsNullOrWhiteSpace([string]$receipt.reference) -or
        $performedAt -gt [DateTimeOffset]::UtcNow.AddMinutes(5) -or $performedAt -lt [DateTimeOffset]::UtcNow.AddHours(-8)) {
        throw 'Authentication smoke receipt approval/time evidence is invalid.'
    }
    if ($Context.ExecutionMode -eq 'Real') {
        if ($receipt.evidenceType -cne 'human_operator' -or -not $ContainedStartedAt -or $performedAt -lt [DateTimeOffset]$ContainedStartedAt) {
            throw 'Real authentication evidence must be human-approved after the contained application start.'
        }
    } elseif ($receipt.evidenceType -cne 'synthetic_fixture') {
        throw 'Mock authentication evidence must be explicitly labeled synthetic_fixture.'
    }
    return @{ authentication = 'human-approved-contract'; performedAt = $performedAt.ToString('o'); valuesRedacted = $true }
}

function Import-AzureDeploymentReceipt {
    param($Context, [string]$Path, [string]$RequestedAction)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Resume receipt was not found.' }
    $receipt = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 30
    if ($receipt.receiptVersion -ne 2 -or $receipt.runId -notmatch '^[a-f0-9]{32}$' -or
        $receipt.approvalDigest -cne (Get-TargetApprovalDigest $Context.Target) -or
        $receipt.executionMode -cne $Context.ExecutionMode -or
        $receipt.target.tenantId -ine $Context.Target.tenantId -or
        $receipt.target.subscriptionId -ine $Context.Target.subscriptionId -or
        $receipt.target.resourceGroup -cne $Context.Target.resourceGroup -or
        $receipt.target.appServiceResourceId -ine $Context.Target.expectedResourceIds.appService -or
        $receipt.target.postgresServerResourceId -ine $Context.Target.expectedResourceIds.postgresFlexibleServer -or
        $receipt.target.database -cne $Context.Target.expectedDatabaseName) {
        throw 'Resume receipt does not match the exact approved target and execution boundary.'
    }
    if ($RequestedAction -eq 'Cleanup') {
        if ($receipt.status -notin @('failed', 'cleanup_failed', 'awaiting_authentication_smoke')) { throw 'Cleanup accepts only an exact failed or contained-pause receipt.' }
    } elseif ($receipt.action -cne $RequestedAction -or $receipt.status -notin @('failed', 'cleanup_succeeded', 'awaiting_authentication_smoke')) {
        throw 'Resume action must match the failed receipt action.'
    }
    $knownSteps = @(
        'prerequisites', 'operator_identity', 'bicep_build', 'sku_pricing_preflight', 'vault_preflight',
        'registration_verify', 'qualification_preflight', 'target_inventory', 'release_inspection', 'bicep_what_if',
        'approval_checkpoint', 'resume_verify', 'resource_deploy', 'network_reconcile', 'enter_maintenance',
        'drain_verify', 'managed_backup', 'backup_health_verify', 'database_preflight', 'database_migrate', 'legacy_import',
        'package_deploy', 'runtime_access_verify', 'monitoring_verify', 'start_contained', 'contained_smoke',
        'authentication_smoke_verify', 'database_reopen', 'open_and_verify', 'retire_legacy_swa',
        'pitr_restore', 'pitr_validate_review', 'recovery_switch', 'contain_runtime', 'cleanup'
    )
    if (@($receipt.completedSteps | Where-Object { $_ -notin $knownSteps }).Count) {
        throw 'Resume receipt contains an unknown completed step.'
    }
    $Context.RunId = [string]$receipt.runId
    foreach ($step in @($receipt.completedSteps | Select-Object -Unique)) { $Context.Completed.Add([string]$step) }
    $expectedFirewall = "postgres-firewall:wizard-$($Context.RunId)"
    $expectedRestore = "postgres-restore:$($Context.Target.resources.postgresFlexibleServer.name)-restore-$($Context.RunId.Substring(0, 8))"
    if (@($receipt.ownedResourcesRemaining).Count -ne @($receipt.ownedResourcesRemaining | Select-Object -Unique).Count) {
        throw 'Resume receipt contains duplicate ownership records.'
    }
    foreach ($owned in @($receipt.ownedResourcesRemaining)) {
        if ($owned -cne $expectedFirewall -and $owned -cne $expectedRestore) {
            throw 'Resume receipt contains ownership outside the exact allowlisted run resources.'
        }
        $Context.Owned.Add([string]$owned)
    }
    $Context.ResumeEvidence = if ($receipt.evidence) { $receipt.evidence } else { @{} }
    $Context.PreviousFailedStep = [string]$receipt.failedStep
    $Context.ResumeStatus = [string]$receipt.status
    $Context.ReceiptAction = [string]$receipt.action
    $Context.Resuming = $true
    if ($Context.Completed.Contains('recovery_switch')) {
        $restored = [string]$Context.ResumeEvidence.recovery_switch.newPostgresServerName
        $expectedRestored = "$($Context.Target.resources.postgresFlexibleServer.name)-restore-$($Context.RunId.Substring(0, 8))"
        if ($restored -cne $expectedRestored) {
            throw 'Resume receipt recovery server identity is invalid.'
        }
        $Context.RestoredServerName = $restored
        $Context.ServingServerName = $restored
    } elseif ($Context.Owned.Contains($expectedRestore)) {
        $Context.RestoredServerName = $expectedRestore.Substring('postgres-restore:'.Length)
    }
}

function Invoke-RealAzureOperation {
    param($Context, [string]$Name, $OperationInput)
    $target = $Context.Target
    switch ($Name) {
        'prerequisites' {
            if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 is required.' }
            if ($Context.ExecutionMode -eq 'Real') {
                foreach ($command in @('docker', 'az')) {
                    if (-not (Microsoft.PowerShell.Core\Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command $command was not found." }
                }
            }
            Invoke-ExternalCommand docker @('info') | Out-Null
            return @{ powerShell = $PSVersionTable.PSVersion.ToString(); docker = 'available'; azureCli = 'available' }
        }
        'operator_identity' {
            $account = Get-AzJson @('account', 'show', '--subscription', $target.subscriptionId)
            if ($account.id -ine $target.subscriptionId -or $account.tenantId -ine $target.tenantId) { throw 'Authenticated operator identity does not match the approved tenant/subscription.' }
            return @{ subscriptionId = $account.id; tenantId = $account.tenantId; principalType = $account.user.type }
        }
        'bicep_build' {
            Invoke-ExternalCommand docker @('run', '--rm', '-v', "$($Context.Root):/workspace:ro", '-w', '/workspace',
                'mcr.microsoft.com/azure-cli:2.77.0', 'az', 'bicep', 'build', '--file', 'infra/main.bicep', '--stdout') | Out-Null
            return @{ template = 'infra/main.bicep'; localContainerBuild = $true }
        }
        'sku_pricing_preflight' {
            $postgresCapabilities = Get-AzJson @('postgres', 'flexible-server', 'list-skus', '--location', $target.region, '--subscription', $target.subscriptionId)
            $editions = @($postgresCapabilities.supportedServerEditions)
            $edition = @($editions | Where-Object { $_.name -ceq $target.resources.postgresFlexibleServer.tier })
            $serverSkus = if ($edition.Count -eq 1) { @($edition[0].supportedServerSkus) } else { @() }
            $serverSku = @($serverSkus | Where-Object { $_.name -ceq $target.resources.postgresFlexibleServer.sku })
            $supportedVersions = if ($serverSku.Count -eq 1) {
                @($serverSku[0].supportedServerVersions | ForEach-Object {
                    if ($_ -is [string] -or $_ -is [ValueType]) { [string]$_ } else { [string]$_.name }
                })
            } else { @() }
            if ($edition.Count -ne 1 -or $serverSku.Count -ne 1 -or
                [string]$target.resources.postgresFlexibleServer.version -notin $supportedVersions) {
                throw 'Regional PostgreSQL Burstable/Standard_B1ms/PostgreSQL 17 capability evidence is unavailable; no deployment is authorized.'
            }
            $appLocations = Get-AzJson @('appservice', 'list-locations', '--sku', 'B1', '--linux-workers-enabled', '--subscription', $target.subscriptionId)
            if (-not @($appLocations | Where-Object { $_.name -ieq $target.region }).Count) {
                throw 'Regional Linux App Service B1 evidence is unavailable; no deployment is authorized.'
            }
            $runtimes = Get-AzJson @('webapp', 'list-runtimes', '--os-type', 'linux')
            if (-not @($runtimes | Where-Object { $_ -match '^NODE:24(?:-lts)?$' }).Count) {
                throw 'Built-in Linux Node 24 runtime evidence is unavailable.'
            }
            $quota = Get-AzJson @('rest', '--method', 'get', '--url',
                "https://management.azure.com/subscriptions/$($target.subscriptionId)/providers/Microsoft.Web/locations/$($target.region)/usages?api-version=2023-12-01")
            if (-not $quota.value) { throw 'App Service regional quota evidence is unavailable.' }
            return @{ pricingSource = $target.estimate.source; pricingDate = $target.estimate.asOfDate; regionalSkuChecked = $true; quotaChecked = $true; node24Checked = $true }
        }
        'vault_preflight' {
            $vault = Get-AzJson @('keyvault', 'show', '--id', $target.existingVaultResourceId)
            if ($vault.properties.tenantId -ine $target.tenantId -or $vault.properties.enableRbacAuthorization -ne $true -or
                $vault.properties.enabledForTemplateDeployment -ne $true) { throw 'Prepared vault tenant/RBAC/template-deployment contract failed.' }
            $values = @{}
            foreach ($secretName in $script:RequiredSecretNames) {
                $version = Get-SelectedSecretVersion $target $secretName
                $secret = Get-AzJson @('keyvault', 'secret', 'show', '--vault-name', $vault.name, '--name', $secretName, '--version', $version) -SensitiveOutput
                if ($secret.attributes.enabled -ne $true -or -not $secret.value -or
                    ($secret.attributes.expires -and [DateTimeOffset]$secret.attributes.expires -le [DateTimeOffset]::UtcNow)) {
                    throw "Prepared vault secret $secretName is missing, disabled, expired or empty."
                }
                $values[$secretName] = [string]$secret.value
            }
            if ($values['agent-control-tenant-id'] -ine $target.tenantId -or $values['agent-control-client-id'] -ine $target.entraApplicationId) {
                throw 'Prepared vault tenant/application identifiers do not match the approved target.'
            }
            if ([Text.Encoding]::UTF8.GetByteCount($values['agent-control-session-secret']) -lt 32 -or
                $values['agent-control-postgres-admin-password'].Length -lt 32 -or
                $values['agent-control-postgres-app-password'].Length -lt 32 -or
                $values['agent-control-postgres-admin-password'] -ceq $values['agent-control-postgres-app-password'] -or
                @($values.Values | Where-Object { $_ -match "[`r`n`0]" }).Count) {
                throw 'Prepared secret value-format separation contract failed.'
            }
            $Context.SecretValues = $values
            return @{ vaultResourceId = $target.existingVaultResourceId; secretVersions = @($target.preparedVaultContract.versions); valuesRedacted = $true }
        }
        'registration_verify' {
            $app = Get-AzJson @('ad', 'app', 'show', '--id', $target.entraApplicationId)
            $manifest = Get-Content -LiteralPath (Join-Path $Context.Root 'infra/entra-app-manifest.json') -Raw | ConvertFrom-Json
            $expectedRoles = @($manifest.appRoles.value | Sort-Object)
            $actualRoles = @($app.appRoles | Where-Object isEnabled | ForEach-Object value | Sort-Object)
            if (@(Compare-Object $expectedRoles $actualRoles).Count -or $target.callbackUri -notin @($app.web.redirectUris)) {
                Write-Host "Registration preview requires exactly these role values: $($expectedRoles -join ', ')"
                Write-Host "Registration preview requires callback: $($target.callbackUri)"
                throw 'Registration differs from the approved four-role/callback preview. Apply the displayed administrator-owned change, then rerun; the wizard never writes directory configuration.'
            }
            $servicePrincipals = Get-AzJson @('ad', 'sp', 'list', '--filter', "appId eq '$($target.entraApplicationId)'")
            if (@($servicePrincipals).Count -ne 1) { throw 'The exact application service principal is missing or ambiguous.' }
            $administratorRole = @($manifest.appRoles | Where-Object value -eq 'AgentControl.Administrator')
            $assignments = Get-AzJson @('rest', '--method', 'get', '--url',
                "https://graph.microsoft.com/v1.0/servicePrincipals/$($servicePrincipals[0].id)/appRoleAssignedTo?`$filter=appRoleId%20eq%20$($administratorRole[0].id)&`$select=id,principalType")
            if (@($assignments.value).Count -lt 1) { throw 'At least one approved AgentControl.Administrator assignment is required.' }
            return @{ roleCount = $actualRoles.Count; callbackVerified = $true; directoryWrites = 0; administratorAssignmentCount = @($assignments.value).Count }
        }
        'qualification_preflight' {
            return Test-ApprovedQualificationTargets $Context.QualificationTargets $target
        }
        'target_inventory' {
            $freshResourcesWereCreated = $Context.Resuming -and $Context.Completed.Contains('resource_deploy')
            foreach ($entry in @(
                @{ id = $target.expectedResourceIds.appServicePlan; label = 'plan'; resourceType = 'Microsoft.Web/serverfarms' },
                @{ id = $target.expectedResourceIds.appService; label = 'app'; resourceType = 'Microsoft.Web/sites' },
                @{ id = $target.expectedResourceIds.postgresFlexibleServer; label = 'postgres'; resourceType = 'Microsoft.DBforPostgreSQL/flexibleServers' }
            )) {
                $resource = Get-AzJson @('resource', 'show', '--ids', $entry.id) -AllowFailure
                $exists = -not $resource.commandFailed
                if ($target.installationMode -eq 'fresh') {
                    if (-not $freshResourcesWereCreated -and $exists) {
                        throw "Fresh target already contains $($entry.label); replacement initialization is forbidden."
                    }
                    if ($freshResourcesWereCreated -and (-not $exists -or $resource.id -ine $entry.id -or
                        $resource.type -ine $entry.resourceType -or $resource.tags.app -cne 'agent-control' -or
                        $resource.tags.topology -cne 'single-app-managed-postgresql' -or
                        $resource.tags.wizardRunId -cne $Context.RunId)) {
                        throw "Fresh resume could not prove exact wizard-owned $($entry.label) identity and tags."
                    }
                } elseif (-not $exists -or $resource.id -ine $entry.id -or $resource.type -ine $entry.resourceType) {
                    throw "Expected $($entry.label) identity is missing or inaccessible."
                }
            }
            return @{ installationMode = $target.installationMode; identitiesBound = $true; freshResumeOwnershipVerified = $freshResourcesWereCreated }
        }
        'bicep_what_if' {
            $parameterFile = New-AzureParameterFile $Context
            $result = Invoke-ExternalCommand az @('deployment', 'group', 'what-if', '--subscription', $target.subscriptionId,
                '--resource-group', $target.resourceGroup, '--template-file', (Join-Path $Context.Root 'infra/main.bicep'),
                '--parameters', "@$parameterFile", '--only-show-errors', '--no-pretty-print')
            return @{ preview = $result.output; actualCloudWhatIf = $true }
        }
        'approval_checkpoint' {
            if ($OperationInput.ApprovalDigest -cne (Get-TargetApprovalDigest $target)) { throw 'Approved target changed after preview.' }
            return @{ approved = $true; approvalReference = $target.operatorApproval.changeReference }
        }
        'resource_deploy' {
            $parameterFile = New-AzureParameterFile $Context
            $deployment = Get-AzJson @('deployment', 'group', 'create', '--subscription', $target.subscriptionId,
                '--resource-group', $target.resourceGroup, '--name', "agent-control-$($Context.RunId)",
                '--template-file', (Join-Path $Context.Root 'infra/main.bicep'), '--parameters', "@$parameterFile")
            Get-AzJson @('webapp', 'config', 'appsettings', 'set', '--ids', $target.expectedResourceIds.appService,
                '--settings', 'MAINTENANCE_MODE=true') | Out-Null
            Get-AzJson @('webapp', 'stop', '--ids', $target.expectedResourceIds.appService) | Out-Null
            return @{ deploymentName = $deployment.name; outputs = $deployment.properties.outputs; admission = 'closed'; app = 'stopped' }
        }
        'network_reconcile' {
            $app = Get-AzJson @('webapp', 'show', '--ids', $target.expectedResourceIds.appService)
            $actual = @(([string]$app.outboundIpAddresses -split ',') | Where-Object { $_ } | Sort-Object -Unique)
            $approved = @($target.resources.approvedAppOutboundIpv4Addresses | Sort-Object -Unique)
            if (@(Compare-Object $approved $actual).Count) { throw 'Observed App Service egress addresses differ from the approved firewall list; amend approval and rerun.' }
            $rule = "wizard-$($Context.RunId)"
            Get-AzJson @('postgres', 'flexible-server', 'firewall-rule', 'create', '--subscription', $target.subscriptionId,
                '--resource-group', $target.resourceGroup, '--name', $target.resources.postgresFlexibleServer.name,
                '--rule-name', $rule, '--start-ip-address', $target.runnerIpv4Address, '--end-ip-address', $target.runnerIpv4Address) | Out-Null
            $Context.Owned.Add("postgres-firewall:$rule")
            return @{ appOutboundAddresses = $actual; temporaryRunnerRule = $rule }
        }
        'release_inspection' {
            Test-ReleaseArtifact $Context.ArtifactPath | Out-Null
            Invoke-ExternalCommand docker @('build', '--target', 'operator', '-t', 'agent-control-azure-operator:local', $Context.Root) | Out-Null
            $directory = Split-Path $Context.ArtifactPath -Parent
            $result = Invoke-ExternalCommand docker @('run', '--rm', '--mount', "type=bind,source=$directory,target=/export,readonly",
                '--entrypoint', 'node', 'agent-control-azure-operator:local', 'backend/scripts/release-inspect.mjs',
                "/export/$([IO.Path]::GetFileName($Context.ArtifactPath))")
            return $result.output.Split("`n")[-1] | ConvertFrom-Json
        }
        'enter_maintenance' {
            if ($target.installationMode -ne 'fresh') {
                Get-AzJson @('webapp', 'config', 'appsettings', 'set', '--ids', $target.expectedResourceIds.appService, '--settings', 'MAINTENANCE_MODE=true') | Out-Null
                Get-AzJson @('webapp', 'stop', '--ids', $target.expectedResourceIds.appService) | Out-Null
            }
            return Invoke-AzureDatabaseContainer $Context @('backend/scripts/azure-database.ts', 'maintenance')
        }
        'drain_verify' {
            return Invoke-AzureDatabaseContainer $Context @('backend/scripts/azure-database.ts', 'drain')
        }
        'managed_backup' {
            $name = "release-$($Context.RunId)"
            Get-AzJson @('postgres', 'flexible-server', 'backup', 'create', '--subscription', $target.subscriptionId,
                '--resource-group', $target.resourceGroup, '--name', $target.resources.postgresFlexibleServer.name, '--backup-name', $name) | Out-Null
            return @{ backupName = $name; retentionDays = 7 }
        }
        'backup_health_verify' {
            $name = "release-$($Context.RunId)"
            $backup = $null
            $completedAt = [DateTimeOffset]::MinValue
            $healthy = $false
            $attempts = 0
            do {
                $attempts++
                $backup = Get-AzJson @('postgres', 'flexible-server', 'backup', 'show', '--subscription', $target.subscriptionId,
                    '--resource-group', $target.resourceGroup, '--name', $target.resources.postgresFlexibleServer.name,
                    '--backup-name', $name) -AllowFailure
                $state = [string]$(if ($backup.status) { $backup.status } else { $backup.provisioningState })
                $completedParsed = $false
                if ($backup.completedTime -is [DateTime]) {
                    $completedAt = [DateTimeOffset]$backup.completedTime
                    $completedParsed = $true
                } elseif ($backup.completedTime -is [DateTimeOffset]) {
                    $completedAt = $backup.completedTime
                    $completedParsed = $true
                } else {
                    $completedParsed = [DateTimeOffset]::TryParse([string]$backup.completedTime, [ref]$completedAt)
                }
                $healthy = -not $backup.commandFailed -and $backup.backupName -ceq $name -and
                    $backup.source -ieq $target.expectedResourceIds.postgresFlexibleServer -and
                    $completedParsed -and
                    $completedAt -ge [DateTimeOffset]$target.maintenanceApproval.windowStartsAt -and
                    $completedAt -le [DateTimeOffset]$target.maintenanceApproval.windowEndsAt -and
                    $completedAt -le [DateTimeOffset]::UtcNow.AddMinutes(5) -and
                    (-not $state -or $state -in @('Completed', 'Ready', 'Succeeded'))
                if (-not $healthy -and $attempts -lt 20 -and $Context.ExecutionMode -eq 'Real') { Start-Sleep -Seconds 15 }
            } while (-not $healthy -and $attempts -lt 20)
            if (-not $healthy) {
                throw "The exact release backup did not become a completed control-plane restore point within the bounded probe " +
                    "(name=$($backup.backupName -ceq $name), source=$($backup.source -ieq $target.expectedResourceIds.postgresFlexibleServer), " +
                    "completed=$($completedAt.ToUniversalTime().ToString('o')), windowStart=$(([DateTimeOffset]$target.maintenanceApproval.windowStartsAt).ToUniversalTime().ToString('o')), " +
                    "state=$state, attempts=$attempts)."
            }
            return @{ backupName = $name; sourceServerResourceId = $target.expectedResourceIds.postgresFlexibleServer
                completedAt = $completedAt.ToUniversalTime().ToString('o'); status = 'completed'; attempts = $attempts }
        }
        'database_preflight' {
            $expectedCurrentVersion = if ($target.installationMode -eq 'fresh') { 0 } else { [int]$target.expectedSchemaVersion }
            return Invoke-AzureDatabaseContainer $Context @('backend/scripts/azure-database.ts', 'preflight', $target.installationMode, [string]$expectedCurrentVersion)
        }
        'database_migrate' {
            return Invoke-AzureDatabaseContainer $Context @('backend/scripts/database.ts')
        }
        'legacy_import' {
            return Invoke-AzureDatabaseContainer $Context @('backend/scripts/import-legacy-audit.ts', $target.legacyAuditBackupPath, $target.legacyAuditBackupSha256) -LegacyBackupPath $target.legacyAuditBackupPath
        }
        'package_deploy' {
            Get-AzJson @('webapp', 'deploy', '--ids', $target.expectedResourceIds.appService, '--src-path', $Context.ArtifactPath,
                '--type', 'zip', '--clean', 'false', '--restart', 'false') | Out-Null
            return @{ artifactChecksum = (Test-ReleaseArtifact $Context.ArtifactPath).checksum; remoteBuild = $false }
        }
        'runtime_access_verify' {
            $app = Get-AzJson @('webapp', 'show', '--ids', $target.expectedResourceIds.appService)
            if (-not $app.identity.principalId) { throw 'App managed identity is missing.' }
            $expectedReferences = [ordered]@{}
            $expectedReferences['TENANT_ID'] = 'agent-control-tenant-id'
            $expectedReferences['CLIENT_ID'] = 'agent-control-client-id'
            $expectedReferences['CLIENT_SECRET'] = 'agent-control-client-secret'
            $expectedReferences['SESSION_SECRET'] = 'agent-control-session-secret'
            $expectedReferences['PGPASSWORD'] = 'agent-control-postgres-app-password'
            $referenceUrl = "https://management.azure.com$($target.expectedResourceIds.appService)/config/configreferences/appsettings/list?api-version=2022-03-01"
            $resolved = $false
            $attempts = 0
            do {
                $attempts++
                $referenceStatus = Get-AzJson @('rest', '--method', 'post', '--url', $referenceUrl) -AllowFailure
                if (-not $referenceStatus.commandFailed -and $referenceStatus.properties) {
                    $actualNames = @($referenceStatus.properties.PSObject.Properties.Name)
                    $resolved = @(Compare-Object @($expectedReferences.Keys) $actualNames -CaseSensitive).Count -eq 0
                    foreach ($settingName in $expectedReferences.Keys) {
                        $entry = $referenceStatus.properties.PSObject.Properties[$settingName].Value
                        $status = if ($entry.status -is [string]) { [string]$entry.status } else { [string]$entry.status.code }
                        $expectedSecret = [string]$expectedReferences[$settingName]
                        $expectedVersion = Get-SelectedSecretVersion $target $expectedSecret
                        if (-not $entry -or $status -cne 'Resolved' -or $entry.secretName -cne $expectedSecret -or
                            $entry.secretVersion -cne $expectedVersion -or $entry.vaultName -cne (($target.existingVaultResourceId -split '/')[-1])) {
                            $resolved = $false
                        }
                    }
                }
                if (-not $resolved -and $attempts -lt 5 -and $Context.ExecutionMode -eq 'Real') { Start-Sleep -Seconds ([Math]::Min(30, 2 * $attempts)) }
            } while (-not $resolved -and $attempts -lt 5)
            if (-not $resolved) {
                throw 'All five exact native Key Vault references, including CLIENT_SECRET, must report Resolved with the approved names and versions.'
            }
            $adminScope = "$($target.existingVaultResourceId)/secrets/agent-control-postgres-admin-password"
            $adminAccess = Get-AzJson @('role', 'assignment', 'list', '--assignee-object-id', $app.identity.principalId,
                '--scope', $adminScope, '--include-inherited')
            $secretReadAction = 'Microsoft.KeyVault/vaults/secrets/getSecret/action'
            foreach ($assignment in @($adminAccess | Where-Object { $null -ne $_ })) {
                $definitions = @(Get-AzJson @('role', 'definition', 'list', '--name', $assignment.roleDefinitionId))
                if ($definitions.Count -ne 1) { throw 'App administrator-secret access could not be resolved fail-closed.' }
                foreach ($permission in @($definitions[0].permissions)) {
                    $allows = @($permission.dataActions | Where-Object {
                        $pattern = '^' + [regex]::Escape([string]$_).Replace('\*', '.*') + '$'
                        $secretReadAction -match $pattern
                    }).Count -gt 0
                    $denies = @($permission.notDataActions | Where-Object {
                        $pattern = '^' + [regex]::Escape([string]$_).Replace('\*', '.*') + '$'
                        $secretReadAction -match $pattern
                    }).Count -gt 0
                    if ($allows -and -not $denies) {
                        throw 'App identity has inherited access to the administrator database secret.'
                    }
                }
            }
            Invoke-AzureDatabaseContainer $Context @('backend/scripts/azure-database.ts', 'runtime') -RuntimeRole | Out-Null
            return @{ principalIdPresent = $true; runtimeSecretCount = 5; nativeReferencesResolved = $true; propagationAttempts = $attempts; administratorSecretReadable = $false; databaseRuntimeLeastPrivilege = $true }
        }
        'monitoring_verify' {
            $appDiagnostics = Get-AzJson @('monitor', 'diagnostic-settings', 'show', '--resource',
                $target.expectedResourceIds.appService, '--name', 'agent-control-app')
            $appLogs = @($appDiagnostics.logs | Where-Object { $_.enabled -eq $true })
            $appMetrics = @($appDiagnostics.metrics | Where-Object { $_.enabled -eq $true })
            if ($appDiagnostics.logAnalyticsDestinationType -cne 'Dedicated' -or $appLogs.Count -ne 1 -or
                $appLogs[0].category -cne 'AppServiceConsoleLogs' -or $appMetrics.Count -ne 1 -or
                $appMetrics[0].category -cne 'AllMetrics') {
                throw 'App diagnostics must use only the Dedicated redacted console table and approved aggregate metrics.'
            }
            $postgresDiagnostics = Get-AzJson @('monitor', 'diagnostic-settings', 'show', '--resource',
                $target.expectedResourceIds.postgresFlexibleServer, '--name', 'agent-control-postgresql')
            $postgresLogs = @($postgresDiagnostics.logs | Where-Object { $_.enabled -eq $true })
            $postgresMetrics = @($postgresDiagnostics.metrics | Where-Object { $_.enabled -eq $true })
            if ($postgresLogs.Count -ne 0 -or $postgresMetrics.Count -ne 1 -or
                $postgresMetrics[0].category -cne 'AllMetrics' -or
                $postgresDiagnostics.workspaceId -ine $appDiagnostics.workspaceId) {
                throw 'PostgreSQL diagnostics must exclude raw server/query/session logs and share only approved aggregate metrics.'
            }
            $metricAlerts = @(Get-AzJson @('monitor', 'metrics', 'alert', 'list', '--resource-group', $target.resourceGroup, '--subscription', $target.subscriptionId))
            $metricContracts = @(
                @{ name = "$($target.resources.appService.name)-health-check"; metric = 'HealthCheckStatus'; operator = 'LessThan'; threshold = 100; aggregation = 'Average' },
                @{ name = "$($target.resources.appService.name)-http-5xx"; metric = 'Http5xx'; operator = 'GreaterThanOrEqual'; threshold = 5; aggregation = 'Total' },
                @{ name = "$($target.resources.appService.name)-latency"; metric = 'AverageResponseTime'; operator = 'GreaterThan'; threshold = 2; aggregation = 'Average' },
                @{ name = "$($target.resources.postgresFlexibleServer.name)-storage"; metric = 'storage_percent'; operator = 'GreaterThan'; threshold = 80; aggregation = 'Average' },
                @{ name = "$($target.resources.postgresFlexibleServer.name)-cpu-credits"; metric = 'cpu_credits_remaining'; operator = 'LessThan'; threshold = 20; aggregation = 'Average' },
                @{ name = "$($target.resources.postgresFlexibleServer.name)-backup-storage-cost"; metric = 'backup_storage_used'; operator = 'GreaterThan'; threshold = 34359738368; aggregation = 'Maximum' }
            )
            foreach ($contract in $metricContracts) {
                $matching = @($metricAlerts | Where-Object { $_.name -ceq $contract.name -and $_.enabled -eq $true })
                $criterion = @($matching[0].criteria.allOf)[0]
                if ($matching.Count -ne 1 -or -not $criterion -or $criterion.metricName -cne $contract.metric -or
                    $criterion.operator -cne $contract.operator -or [decimal]$criterion.threshold -ne [decimal]$contract.threshold -or
                    $criterion.timeAggregation -cne $contract.aggregation) {
                    throw "Managed metric alert '$($contract.name)' does not match the approved finite threshold."
                }
            }
            $queryAlerts = @(Get-AzJson @('monitor', 'scheduled-query', 'list', '--resource-group', $target.resourceGroup,
                '--subscription', $target.subscriptionId))
            $queryContracts = @(
                @{ name = "$($target.resources.appService.name)-restarts"; operator = 'GreaterThan'; threshold = 2; events = @('listening') },
                @{ name = "$($target.resources.appService.name)-provider-failures"; operator = 'GreaterThanOrEqual'; threshold = 5
                    events = @('provider_throttled', 'provider_schema_omission', 'request_error') },
                @{ name = "$($target.resources.appService.name)-safety-incidents"; operator = 'GreaterThan'; threshold = 0
                    events = @('job_execution_stopped', 'quarantine_job_stopped',
                    'job_write_uncertain', 'quarantine_write_uncertain', 'official_usage_upload_cleanup_failed',
                    'database_pool_error', 'database_pool_saturated', 'session_store_error') }
            )
            foreach ($contract in $queryContracts) {
                $matching = @($queryAlerts | Where-Object { $_.name -ceq $contract.name -and $_.enabled -eq $true })
                $criterion = @($matching[0].criteria.allOf)[0]
                $query = [string]$criterion.query
                if ($matching.Count -ne 1 -or -not $criterion -or
                    -not $query.Contains('parse_json(ResultDescription).event') -or $query.Contains('has_any') -or
                    $criterion.timeAggregation -cne 'Count' -or $criterion.operator -cne $contract.operator -or
                    [decimal]$criterion.threshold -ne [decimal]$contract.threshold) {
                    throw "Managed log alert '$($contract.name)' does not match exact structured-event extraction and finite threshold."
                }
                foreach ($event in $contract.events) {
                    if (-not $query.Contains("""$event""")) { throw "Managed log alert '$($contract.name)' omits '$event'." }
                }
            }
            Get-AzJson @('monitor', 'action-group', 'test-notifications', 'create', '--resource-group',
                (($target.resources.monitoring.actionGroupResourceId -split '/')[4]), '--action-group',
                (($target.resources.monitoring.actionGroupResourceId -split '/')[-1]), '--alert-type', 'budget') | Out-Null
            return @{ metricAlertCount = $metricContracts.Count; structuredLogAlertCount = $queryContracts.Count
                appLogCategories = @('AppServiceConsoleLogs'); postgresLogCategories = @()
                availabilityProbe = 'AppService HealthCheckStatus /api/ready'; backupHealthProbe = 'exact release backup show'
                deliveryTest = 'requested'; retentionDays = 30; rawHttpOrQueryLogsEnabled = $false }
        }
        'start_contained' {
            Get-AzJson @('webapp', 'config', 'appsettings', 'set', '--ids', $target.expectedResourceIds.appService, '--settings', 'MAINTENANCE_MODE=true') | Out-Null
            Get-AzJson @('webapp', 'start', '--ids', $target.expectedResourceIds.appService) | Out-Null
            return @{ admission = 'closed'; app = 'started_contained'; startedAt = [DateTimeOffset]::UtcNow.ToString('o') }
        }
        'contained_smoke' {
            $health = Invoke-DeploymentHttpGet $Context "$($target.canonicalOrigin)/api/health"
            $ready = Invoke-DeploymentHttpGet $Context "$($target.canonicalOrigin)/api/ready"
            $rootPage = Invoke-DeploymentHttpGet $Context "$($target.canonicalOrigin)/"
            $deepLink = Invoke-DeploymentHttpGet $Context "$($target.canonicalOrigin)/agents"
            $unauthenticated = Invoke-DeploymentHttpGet $Context "$($target.canonicalOrigin)/api/agents"
            $auth = Invoke-DeploymentHttpGet $Context "$($target.canonicalOrigin)/api/auth/status"
            $healthBody = try { $health.body | ConvertFrom-Json } catch { $null }
            $authBody = try { $auth.body | ConvertFrom-Json } catch { $null }
            if ($health.statusCode -ne 200 -or $healthBody.ok -ne $true -or $ready.statusCode -ne 503 -or
                $rootPage.statusCode -ne 200 -or $deepLink.statusCode -ne 200 -or $unauthenticated.statusCode -ne 401 -or
                $auth.statusCode -ne 200 -or $authBody.authConfigured -ne $true -or $authBody.callback -cne $target.callbackUri) {
                throw 'Contained read-only smoke failed while admission remained closed.'
            }
            return @{ admission = 'closed'; health = 'passed'; readiness = 'maintenance'; staticAndDeepLink = 'passed'; unauthenticatedApiDenied = $true; authConfiguration = 'passed' }
        }
        'authentication_smoke_verify' {
            return Test-AuthenticationSmokeReceipt $Context ([string]$OperationInput.ContainedStartedAt)
        }
        'open_and_verify' {
            Get-AzJson @('webapp', 'config', 'appsettings', 'delete', '--ids', $target.expectedResourceIds.appService, '--setting-names', 'MAINTENANCE_MODE') | Out-Null
            $ready = $null
            $attempts = 0
            do {
                $attempts++
                $ready = Invoke-DeploymentHttpGet $Context "$($target.canonicalOrigin)/api/ready"
                if ($ready.statusCode -ne 200 -and $attempts -lt 5 -and $Context.ExecutionMode -eq 'Real') { Start-Sleep -Seconds ([Math]::Min(20, 2 * $attempts)) }
            } while ($ready.statusCode -ne 200 -and $attempts -lt 5)
            $auth = Invoke-DeploymentHttpGet $Context "$($target.canonicalOrigin)/api/auth/status"
            $readyBody = try { $ready.body | ConvertFrom-Json } catch { $null }
            $authBody = try { $auth.body | ConvertFrom-Json } catch { $null }
            if ($ready.statusCode -ne 200 -or $readyBody.ok -ne $true -or $auth.statusCode -ne 200 -or
                $authBody.authConfigured -ne $true -or $authBody.callback -cne $target.callbackUri) {
                throw 'Post-open readiness/auth configuration verification failed; admission must be reclosed.'
            }
            return @{ admission = 'open'; readiness = 'passed'; authConfiguration = 'passed'; attempts = $attempts; loginProof = 'human-approved-receipt' }
        }
        'retire_legacy_swa' {
            if (-not $target.legacyStaticWebApp.resourceId) { return @{ required = $false } }
            $legacy = Get-AzJson @('resource', 'show', '--ids', $target.legacyStaticWebApp.resourceId)
            if ($legacy.id -ine $target.legacyStaticWebApp.resourceId -or $legacy.type -ine 'Microsoft.Web/staticSites' -or
                $legacy.tags.app -cne 'agent-control') {
                throw 'Legacy Static Web App ownership did not match the exact approved retirement target.'
            }
            Get-AzJson @('resource', 'delete', '--ids', $legacy.id) | Out-Null
            return @{ retiredResourceId = $legacy.id; afterSingleAppSmoke = $true }
        }
        'database_reopen' {
            return Invoke-AzureDatabaseContainer $Context @('backend/scripts/azure-database.ts', 'reopen') -ServerName $Context.ServingServerName
        }
        'pitr_restore' {
            $restoreName = "$($target.resources.postgresFlexibleServer.name)-restore-$($Context.RunId.Substring(0, 8))"
            Get-AzJson @('postgres', 'flexible-server', 'restore', '--subscription', $target.subscriptionId,
                '--resource-group', $target.resourceGroup, '--name', $restoreName, '--source-server',
                $target.resources.postgresFlexibleServer.name, '--restore-time', $OperationInput.RestorePoint) | Out-Null
            $Context.Owned.Add("postgres-restore:$restoreName")
            $Context.RestoredServerName = $restoreName
            return @{ restoredServerName = $restoreName; servingDatabaseChanged = $false; providerDispatchEnabled = $false }
        }
        'pitr_validate_review' {
            if (-not $Context.RestoredServerName) { throw 'Restored server identity is missing.' }
            $arguments = @('backend/scripts/azure-pitr.ts', [string]$OperationInput.RestorePoint)
            if ($OperationInput.Reopen -eq $true) { $arguments += 'reopen' }
            return Invoke-AzureDatabaseContainer $Context $arguments -ServerName $Context.RestoredServerName `
                -CurrentServerName $target.resources.postgresFlexibleServer.name
        }
        'recovery_switch' {
            if (-not $Context.RestoredServerName) { throw 'Verified restored server identity is missing.' }
            Get-AzJson @('webapp', 'config', 'appsettings', 'set', '--ids', $target.expectedResourceIds.appService,
                '--settings', "PGHOST=$($Context.RestoredServerName).postgres.database.azure.com", 'MAINTENANCE_MODE=true') | Out-Null
            $owned = "postgres-restore:$($Context.RestoredServerName)"
            $Context.Owned.Remove($owned)
            $Context.ServingServerName = $Context.RestoredServerName
            return @{ newPostgresServerName = $Context.RestoredServerName; oldServerRetained = $true; servingDatabaseChanged = $true }
        }
        'contain_runtime' {
            $setting = Get-AzJson @('webapp', 'config', 'appsettings', 'set', '--ids', $target.expectedResourceIds.appService,
                '--settings', 'MAINTENANCE_MODE=true') -AllowFailure
            $stopped = Get-AzJson @('webapp', 'stop', '--ids', $target.expectedResourceIds.appService) -AllowFailure
            $databaseContained = $true
            try {
                Invoke-AzureDatabaseContainer $Context @('backend/scripts/azure-database.ts', 'maintenance') -ServerName $Context.ServingServerName | Out-Null
            } catch { $databaseContained = $false }
            if ($setting.commandFailed -or $stopped.commandFailed -or -not $databaseContained) {
                throw 'Runtime containment was incomplete; admission/database/app state requires operator incident handling.'
            }
            return @{ admission = 'closed'; app = 'stopped'; database = 'maintenance'; providerWorkEnabled = $false }
        }
        'resume_verify' {
            if (-not $Context.Resuming) { throw 'Resume verification requires an imported receipt.' }
            $uncertainExternalWrites = @('resource_deploy', 'network_reconcile', 'managed_backup', 'package_deploy',
                'monitoring_verify', 'open_and_verify', 'retire_legacy_swa', 'pitr_restore', 'recovery_switch')
            if ($Context.PreviousFailedStep -in $uncertainExternalWrites) {
                throw "Receipt stopped during '$($Context.PreviousFailedStep)', whose external outcome is uncertain; reconcile it explicitly before any replay."
            }
            if ($Context.Completed.Contains('resource_deploy')) {
                $mode = if ($Context.Completed.Contains('database_migrate')) { 'upgrade' } else { 'fresh' }
                $version = if ($mode -eq 'upgrade') { [string]$target.expectedSchemaVersion } else { '0' }
                Invoke-AzureDatabaseContainer $Context @('backend/scripts/azure-database.ts', 'preflight', $mode, $version) `
                    -ServerName $Context.ServingServerName | Out-Null
            }
            $firewall = "postgres-firewall:wizard-$($Context.RunId)"
            if ($Context.Owned.Contains($firewall)) {
                $rule = Get-AzJson @('postgres', 'flexible-server', 'firewall-rule', 'show', '--subscription', $target.subscriptionId,
                    '--resource-group', $target.resourceGroup, '--name', $target.resources.postgresFlexibleServer.name,
                    '--rule-name', "wizard-$($Context.RunId)")
                if ($rule.name -cne "wizard-$($Context.RunId)" -or $rule.startIpAddress -cne $target.runnerIpv4Address -or
                    $rule.endIpAddress -cne $target.runnerIpv4Address) {
                    throw 'Resume could not prove the exact run-owned firewall rule.'
                }
            }
            if ($Context.Completed.Contains('resource_deploy')) {
                $settings = Get-AzJson @('webapp', 'config', 'appsettings', 'list', '--ids', $target.expectedResourceIds.appService)
                $maintenance = @($settings | Where-Object { $_.name -ceq 'MAINTENANCE_MODE' -and $_.value -ceq 'true' })
                if ($maintenance.Count -ne 1) { throw 'Resume could not prove contained application admission.' }
                if (-not $Context.Completed.Contains('start_contained')) {
                    $app = Get-AzJson @('webapp', 'show', '--ids', $target.expectedResourceIds.appService)
                    if ($app.state -cne 'Stopped') { throw 'Resume could not prove the application remained stopped after resource deployment.' }
                }
            }
            return @{ approvalDigest = Get-TargetApprovalDigest $target; runId = $Context.RunId; exactStateVerified = $true }
        }
        'cleanup' {
            foreach ($owned in @($Context.Owned)) {
                if ($owned -like 'postgres-firewall:*') {
                    $rule = $owned.Substring('postgres-firewall:'.Length)
                    Get-AzJson @('postgres', 'flexible-server', 'firewall-rule', 'delete', '--yes', '--subscription', $target.subscriptionId,
                        '--resource-group', $target.resourceGroup, '--name', $target.resources.postgresFlexibleServer.name, '--rule-name', $rule) | Out-Null
                    [void]$Context.Owned.Remove($owned)
                } elseif ($owned -like 'postgres-restore:*') {
                    $server = $owned.Substring('postgres-restore:'.Length)
                    Get-AzJson @('postgres', 'flexible-server', 'delete', '--yes', '--subscription', $target.subscriptionId,
                        '--resource-group', $target.resourceGroup, '--name', $server) | Out-Null
                    [void]$Context.Owned.Remove($owned)
                } else { throw 'Cleanup refused an unknown ownership record.' }
            }
            Remove-AzureSensitiveDirectories $Context
            if ($Context.Owned.Count) { throw 'Cleanup did not converge; unresolved owned resources remain in the receipt.' }
            return @{ ownedResourcesRemaining = 0; receiptBoundRunId = $Context.RunId }
        }
        default { throw "Real operation '$Name' is not registered; remote execution stopped." }
    }
}

function Invoke-DeploymentOperation {
    param($Context, [string]$Name, $OperationInput = @{})
    $Context.Calls.Add($Name)
    $safeResumeRechecks = @('prerequisites', 'operator_identity', 'bicep_build', 'sku_pricing_preflight', 'vault_preflight',
        'registration_verify', 'qualification_preflight', 'target_inventory', 'release_inspection', 'bicep_what_if',
        'approval_checkpoint', 'resume_verify', 'drain_verify', 'backup_health_verify', 'runtime_access_verify',
        'contained_smoke', 'authentication_smoke_verify', 'contain_runtime')
    if ($Context.Resuming -and $Context.Completed.Contains($Name) -and $Name -notin $safeResumeRechecks) {
        $Context.Calls.Add("resume-skip:$Name")
        $prior = $Context.ResumeEvidence.PSObject.Properties[$Name]
        return $(if ($prior) { $prior.Value } else { @{ resumedWithoutReplay = $true } })
    }
    $previousContext = $script:ActiveAzureContext
    $Context.ActiveOperation = $Name
    $script:ActiveAzureContext = $Context
    try {
        $result = Invoke-RealAzureOperation $Context $Name $OperationInput
        if ($Context.ExecutionMode -eq 'Mock') {
            $property = $Context.MockFixture.commands.PSObject.Properties[$Name]
            if (-not $property) { throw "Mock rejected unregistered operation '$Name'." }
            $expectedCommands = @($property.Value)
            $expectedCount = $expectedCommands.Count
            $actualCount = if ($Context.CommandOffsets.ContainsKey($Name)) { [int]$Context.CommandOffsets[$Name] } else { 0 }
            $requiredRemaining = if ($actualCount -lt $expectedCount) {
                @($expectedCommands[$actualCount..($expectedCount - 1)] | Where-Object { $_.optional -ne $true })
            } else { @() }
            if ($actualCount -gt $expectedCount -or $requiredRemaining.Count) {
                throw "Mock operation '$Name' did not consume its exact command fixture ($actualCount of $expectedCount)."
            }
        }
    } finally {
        $script:ActiveAzureContext = $previousContext
        $Context.ActiveOperation = $null
    }
    if (-not $Context.Completed.Contains($Name)) { $Context.Completed.Add($Name) }
    return $result
}

function New-AzureBootstrapDirectory {
    param($Context)
    if ($Context.BootstrapSecretsMaterialized -and $Context.BootstrapDirectory) {
        Assert-AzureBootstrapMaterialized $Context
        return $Context.BootstrapDirectory
    }
    $directory = Join-Path $Context.Root "artifacts/azure-bootstrap/$($Context.RunId)"
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    Protect-AzureBootstrapPath $directory -Directory
    foreach ($pair in @(
        @{ name = 'postgres-admin'; value = $Context.SecretValues['agent-control-postgres-admin-password'] },
        @{ name = 'postgres-app'; value = $Context.SecretValues['agent-control-postgres-app-password'] }
    )) {
        if (-not $pair.value) { throw 'Bootstrap secret values are unavailable.' }
        $path = Join-Path $directory $pair.name
        [IO.File]::WriteAllText($path, $pair.value)
        Protect-AzureBootstrapPath $path
    }
    $Context.BootstrapDirectory = $directory
    $Context.BootstrapSecretsMaterialized = $true
    Assert-AzureBootstrapMaterialized $Context
    return $directory
}

function Assert-AzureBootstrapMaterialized {
    param($Context)
    if (-not $Context.BootstrapSecretsMaterialized -or -not $Context.BootstrapDirectory) {
        throw 'Bootstrap secrets were not materialized.'
    }
    foreach ($name in @('postgres-admin', 'postgres-app')) {
        $path = Join-Path $Context.BootstrapDirectory $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -lt 32) {
            throw "Bootstrap secret file $name is absent or invalid."
        }
        if (-not $IsWindows -and [IO.File]::GetUnixFileMode($path) -ne [IO.UnixFileMode]384) {
            throw "Bootstrap secret file $name permissions are not 0600."
        }
    }
}

function Remove-AzureSensitiveDirectories {
    param($Context)
    if ($Context.BootstrapDirectory -and (Test-Path -LiteralPath $Context.BootstrapDirectory)) {
        Remove-Item -LiteralPath $Context.BootstrapDirectory -Recurse -Force
    }
    if ($Context.ParameterDirectory -and (Test-Path -LiteralPath $Context.ParameterDirectory)) {
        Remove-Item -LiteralPath $Context.ParameterDirectory -Recurse -Force
    }
    $Context.BootstrapDirectory = $null
    $Context.BootstrapSecretsMaterialized = $false
    $Context.ParameterDirectory = $null
    $Context.SecretValues = @{}
}

function New-AzureParameterFile {
    param($Context)
    $target = $Context.Target
    $vaultParts = $target.existingVaultResourceId -split '/'
    $parameters = @{
        location = @{ value = $target.region }
        tenantId = @{ value = $target.tenantId }
        appRegistrationClientId = @{ value = $target.entraApplicationId }
        appServicePlanName = @{ value = $target.resources.appServicePlan.name }
        appServiceName = @{ value = $target.resources.appService.name }
        postgresServerName = @{ value = $target.resources.postgresFlexibleServer.name }
        canonicalOrigin = @{ value = $target.canonicalOrigin }
        redirectUri = @{ value = $target.callbackUri }
        keyVaultSubscriptionId = @{ value = $vaultParts[2] }
        keyVaultResourceGroupName = @{ value = $vaultParts[4] }
        keyVaultName = @{ value = $vaultParts[8] }
        tenantIdSecretVersion = @{ value = Get-SelectedSecretVersion $target 'agent-control-tenant-id' }
        clientIdSecretVersion = @{ value = Get-SelectedSecretVersion $target 'agent-control-client-id' }
        clientSecretVersion = @{ value = Get-SelectedSecretVersion $target 'agent-control-client-secret' }
        sessionSecretVersion = @{ value = Get-SelectedSecretVersion $target 'agent-control-session-secret' }
        postgresAdminPasswordSecretVersion = @{ value = Get-SelectedSecretVersion $target 'agent-control-postgres-admin-password' }
        postgresAppPasswordSecretVersion = @{ value = Get-SelectedSecretVersion $target 'agent-control-postgres-app-password' }
        approvedAppOutboundIpv4Addresses = @{ value = @($target.resources.approvedAppOutboundIpv4Addresses) }
        actionGroupResourceId = @{ value = $target.resources.monitoring.actionGroupResourceId }
        monthlyBudgetAmount = @{ value = [int][Math]::Ceiling([decimal]$target.approvedMonthlyBudget) }
        budgetStartDate = @{ value = $target.resources.monitoring.budgetStartDate }
        budgetEndDate = @{ value = $target.resources.monitoring.budgetEndDate }
        monitoringRetentionDays = @{ value = 30 }
        monitoringDailyIngestionLimitGiB = @{ value = '0.1' }
        tags = @{ value = $(if ($target.installationMode -eq 'fresh') {
            @{ wizardRunId = $Context.RunId; wizardManaged = 'true' }
        } else { @{} }) }
    }
    $directory = Join-Path $Context.Root "artifacts/azure-parameters/$($Context.RunId)"
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    Protect-AzureBootstrapPath $directory -Directory
    $path = Join-Path $directory 'parameters.json'
    [IO.File]::WriteAllText($path, (@{ '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'; contentVersion = '1.0.0.0'; parameters = $parameters } | ConvertTo-Json -Depth 12))
    Protect-AzureBootstrapPath $path
    $Context.ParameterDirectory = $directory
    return $path
}

function Invoke-AzureDatabaseContainer {
    param($Context, [string[]]$Command, [string]$LegacyBackupPath, [string]$ServerName, [string]$CurrentServerName, [switch]$RuntimeRole)
    $target = $Context.Target
    $directory = New-AzureBootstrapDirectory $Context
    Assert-AzureBootstrapMaterialized $Context
    $databaseServer = if ($ServerName) { $ServerName } else { $target.resources.postgresFlexibleServer.name }
    $arguments = @('run', '--rm', '--platform', 'linux/amd64',
        '--mount', "type=bind,source=$directory,target=/run/secrets,readonly",
        '-e', "PGHOST=$databaseServer.postgres.database.azure.com",
        '-e', 'PGPORT=5432', '-e', 'PGDATABASE=agentcontrol',
        '-e', "PGUSER=$(if ($RuntimeRole) { 'agentcontrol_app' } else { 'agentcontrol_admin' })",
        '-e', "PGPASSWORD_FILE=/run/secrets/$(if ($RuntimeRole) { 'postgres-app' } else { 'postgres-admin' })",
        '-e', 'APP_PGPASSWORD_FILE=/run/secrets/postgres-app',
        '-e', 'PGSSLMODE=verify-full')
    if ($CurrentServerName) { $arguments += @('-e', "CURRENT_PGHOST=$CurrentServerName.postgres.database.azure.com") }
    if ($LegacyBackupPath) {
        $full = [IO.Path]::GetFullPath($LegacyBackupPath)
        $arguments += @('--mount', "type=bind,source=$full,target=/legacy/audit.sqlite,readonly")
        $Command = @($Command[0], '/legacy/audit.sqlite', $Command[2])
    }
    $arguments += @('agent-control-azure-operator:local') + $Command
    $result = Invoke-ExternalCommand docker $arguments -SensitiveOutput
    if (-not $result.output) { return @{ outcome = 'succeeded' } }
    return $result.output.Split("`n")[-1] | ConvertFrom-Json
}

function Write-AzureDeploymentReceipt {
    param($Context, [string]$Status, [string]$FailedStep, $Evidence)
    $artifact = if (Test-Path -LiteralPath $Context.ArtifactPath) { Test-ReleaseArtifact $Context.ArtifactPath } else { $null }
    $receipt = [ordered]@{
        receiptVersion = 2
        runId = $Context.RunId
        action = $Context.ReceiptAction
        executionMode = $Context.ExecutionMode
        status = $Status
        recordedAt = [DateTimeOffset]::UtcNow.ToString('o')
        approvalDigest = Get-TargetApprovalDigest $Context.Target
        target = @{
            tenantId = $Context.Target.tenantId
            subscriptionId = $Context.Target.subscriptionId
            resourceGroup = $Context.Target.resourceGroup
            region = $Context.Target.region
            canonicalOrigin = $Context.Target.canonicalOrigin
            appServiceResourceId = $Context.Target.expectedResourceIds.appService
            postgresServerResourceId = $Context.Target.expectedResourceIds.postgresFlexibleServer
            database = 'agentcontrol'
            existingVaultResourceId = $Context.Target.existingVaultResourceId
        }
        artifact = if ($artifact) {
            @{
                path = 'artifacts/release/agent-control-linux-x64.zip'
                revision = $(if ($Evidence.release_inspection.revision) { $Evidence.release_inspection.revision } else { $Context.ResumeEvidence.release_inspection.revision })
                sha256 = $artifact.checksum
                bytes = $artifact.bytes
                platform = 'linux'
                architecture = 'x64'
                nodeMajor = 24
            }
        } else { $null }
        secretVersionReferences = @($Context.Target.preparedVaultContract.versions)
        completedSteps = @($Context.Completed)
        attemptedSteps = @($Context.Calls)
        failedStep = $FailedStep
        ownedResourcesRemaining = @($Context.Owned)
        evidence = $Evidence
        secretsRedacted = $true
    }
    $directory = Split-Path $Context.ReceiptPath -Parent
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $nextPath = "$($Context.ReceiptPath).new"
    [IO.File]::WriteAllText($nextPath, ($receipt | ConvertTo-Json -Depth 30))
    Move-Item -LiteralPath $nextPath -Destination $Context.ReceiptPath -Force
    return $receipt
}

function Invoke-AzureDeployment {
    param(
        $Context,
        [ValidateSet('Plan', 'Deploy', 'PointInTimeRestore', 'Recover', 'Cleanup')][string]$Action,
        [string]$RestorePoint
    )
    $evidence = [ordered]@{}
    if ($Context.Resuming -and $Context.ResumeEvidence) {
        foreach ($property in $Context.ResumeEvidence.PSObject.Properties) { $evidence[$property.Name] = $property.Value }
    }
    $failedStep = $null
    $approvalDigest = Get-TargetApprovalDigest $Context.Target
    try {
        if ($Action -eq 'Cleanup') {
            $failedStep = 'cleanup'
            if ($Context.ResumeStatus -eq 'awaiting_authentication_smoke') {
                $evidence.containment = Invoke-DeploymentOperation $Context 'contain_runtime'
            }
            $evidence.cleanup = Invoke-DeploymentOperation $Context 'cleanup'
            foreach ($step in @('cleanup', 'network_reconcile')) { [void]$Context.Completed.Remove($step) }
            if (-not $Context.Completed.Contains('recovery_switch')) {
                foreach ($step in @('pitr_restore', 'pitr_validate_review')) { [void]$Context.Completed.Remove($step) }
            }
            return Write-AzureDeploymentReceipt $Context 'cleanup_succeeded' $null $evidence
        }
        foreach ($step in @('prerequisites', 'operator_identity', 'bicep_build', 'sku_pricing_preflight', 'vault_preflight', 'registration_verify', 'qualification_preflight', 'target_inventory', 'release_inspection', 'bicep_what_if')) {
            $failedStep = $step
            $evidence[$step] = Invoke-DeploymentOperation $Context $step
        }
        $failedStep = 'approval_checkpoint'
        $evidence.approval_checkpoint = Invoke-DeploymentOperation $Context 'approval_checkpoint' @{ ApprovalDigest = $approvalDigest }
        if ($Context.Resuming) {
            $failedStep = 'resume_verify'
            $evidence.resume_verify = Invoke-DeploymentOperation $Context 'resume_verify'
        }
        if ($Action -eq 'Plan') {
            return Write-AzureDeploymentReceipt $Context 'previewed_not_deployed' $null $evidence
        }
        $now = [DateTimeOffset]::UtcNow
        if ($now -lt [DateTimeOffset]$Context.Target.maintenanceApproval.windowStartsAt -or
            $now -gt [DateTimeOffset]$Context.Target.maintenanceApproval.windowEndsAt) {
            throw 'The approved maintenance window is not currently active; no write was attempted.'
        }
        if ($Action -eq 'PointInTimeRestore') {
            $parsedRestorePoint = [DateTimeOffset]::MinValue
            if (-not $RestorePoint -or -not [DateTimeOffset]::TryParse($RestorePoint, [ref]$parsedRestorePoint)) {
                throw 'Point-in-time restore requires an explicit approved UTC restore point.'
            }
            $failedStep = 'network_reconcile'
            $evidence.network_reconcile = Invoke-DeploymentOperation $Context 'network_reconcile'
            $failedStep = 'pitr_restore'
            $evidence.pitr_restore = Invoke-DeploymentOperation $Context 'pitr_restore' @{ RestorePoint = $RestorePoint }
            $failedStep = 'pitr_validate_review'
            $evidence.pitr_validate_review = Invoke-DeploymentOperation $Context 'pitr_validate_review' @{ RestorePoint = $RestorePoint; Reopen = $false }
            $failedStep = 'cleanup'
            $evidence.cleanup = Invoke-DeploymentOperation $Context 'cleanup'
            return Write-AzureDeploymentReceipt $Context 'pitr_rehearsal_succeeded' $null $evidence
        }
        if ($Action -eq 'Recover') {
            $parsedRestorePoint = [DateTimeOffset]::MinValue
            if (-not $RestorePoint -or -not [DateTimeOffset]::TryParse($RestorePoint, [ref]$parsedRestorePoint)) {
                throw 'Recovery requires an explicit approved UTC restore point.'
            }
            foreach ($step in @('network_reconcile', 'enter_maintenance', 'drain_verify', 'managed_backup', 'backup_health_verify')) {
                $failedStep = $step
                $evidence[$step] = Invoke-DeploymentOperation $Context $step
            }
            $failedStep = 'pitr_restore'
            $evidence.pitr_restore = Invoke-DeploymentOperation $Context 'pitr_restore' @{ RestorePoint = $RestorePoint }
            $failedStep = 'pitr_validate_review'
            $evidence.pitr_validate_review = Invoke-DeploymentOperation $Context 'pitr_validate_review' @{ RestorePoint = $RestorePoint; Reopen = $false }
            $failedStep = 'recovery_switch'
            $evidence.recovery_switch = Invoke-DeploymentOperation $Context 'recovery_switch'
            $failedStep = 'start_contained'
            $evidence.start_contained = Invoke-DeploymentOperation $Context 'start_contained'
            $failedStep = 'contained_smoke'
            $evidence.contained_smoke = Invoke-DeploymentOperation $Context 'contained_smoke'
            $failedStep = 'authentication_smoke_verify'
            if ($Context.ExecutionMode -eq 'Real' -and (-not $Context.AuthenticationSmokeReceiptPath -or
                -not (Test-Path -LiteralPath $Context.AuthenticationSmokeReceiptPath -PathType Leaf))) {
                return Write-AzureDeploymentReceipt $Context 'awaiting_authentication_smoke' $failedStep $evidence
            }
            $evidence.authentication_smoke_verify = Invoke-DeploymentOperation $Context 'authentication_smoke_verify' @{
                ContainedStartedAt = $evidence.start_contained.startedAt
            }
            $failedStep = 'database_reopen'
            $evidence.database_reopen = Invoke-DeploymentOperation $Context 'database_reopen'
            $failedStep = 'open_and_verify'
            $evidence.open_and_verify = Invoke-DeploymentOperation $Context 'open_and_verify'
            if ($Context.Target.legacyStaticWebApp.resourceId) {
                $failedStep = 'retire_legacy_swa'
                $evidence.retire_legacy_swa = Invoke-DeploymentOperation $Context 'retire_legacy_swa'
            }
            $failedStep = 'cleanup'
            $evidence.cleanup = Invoke-DeploymentOperation $Context 'cleanup'
            return Write-AzureDeploymentReceipt $Context 'recovered' $null $evidence
        }
        if ($Context.Target.installationMode -ne 'fresh') {
            foreach ($step in @('network_reconcile', 'enter_maintenance', 'drain_verify', 'managed_backup', 'backup_health_verify')) {
                $failedStep = $step
                $evidence[$step] = Invoke-DeploymentOperation $Context $step
            }
        }
        $failedStep = 'resource_deploy'
        $evidence.resource_deploy = Invoke-DeploymentOperation $Context 'resource_deploy'
        if ($Context.Target.installationMode -eq 'fresh') {
            $failedStep = 'network_reconcile'
            $evidence.network_reconcile = Invoke-DeploymentOperation $Context 'network_reconcile'
        }
        foreach ($step in @('database_preflight', 'database_migrate')) {
            $failedStep = $step
            $evidence[$step] = Invoke-DeploymentOperation $Context $step
        }
        if ($Context.Target.installationMode -eq 'fresh') {
            foreach ($step in @('managed_backup', 'backup_health_verify')) {
                $failedStep = $step
                $evidence[$step] = Invoke-DeploymentOperation $Context $step
            }
            $failedStep = 'enter_maintenance'
            $evidence.enter_maintenance = Invoke-DeploymentOperation $Context 'enter_maintenance'
        }
        if ($Context.Target.installationMode -eq 'legacy_import') {
            $failedStep = 'legacy_import'
            $evidence.legacy_import = Invoke-DeploymentOperation $Context 'legacy_import'
        }
        foreach ($step in @('package_deploy', 'runtime_access_verify', 'monitoring_verify')) {
            $failedStep = $step
            $evidence[$step] = Invoke-DeploymentOperation $Context $step
        }
        $failedStep = 'start_contained'
        $evidence.start_contained = Invoke-DeploymentOperation $Context 'start_contained'
        $failedStep = 'contained_smoke'
        $evidence.contained_smoke = Invoke-DeploymentOperation $Context 'contained_smoke'
        $failedStep = 'authentication_smoke_verify'
        if ($Context.ExecutionMode -eq 'Real' -and (-not $Context.AuthenticationSmokeReceiptPath -or
            -not (Test-Path -LiteralPath $Context.AuthenticationSmokeReceiptPath -PathType Leaf))) {
            return Write-AzureDeploymentReceipt $Context 'awaiting_authentication_smoke' $failedStep $evidence
        }
        $evidence.authentication_smoke_verify = Invoke-DeploymentOperation $Context 'authentication_smoke_verify' @{
            ContainedStartedAt = $evidence.start_contained.startedAt
        }
        $failedStep = 'database_reopen'
        $evidence.database_reopen = Invoke-DeploymentOperation $Context 'database_reopen'
        $failedStep = 'open_and_verify'
        $evidence.open_and_verify = Invoke-DeploymentOperation $Context 'open_and_verify'
        if ($Context.Target.legacyStaticWebApp.resourceId) {
            $failedStep = 'retire_legacy_swa'
            $evidence.retire_legacy_swa = Invoke-DeploymentOperation $Context 'retire_legacy_swa'
        }
        $failedStep = 'cleanup'
        $evidence.cleanup = Invoke-DeploymentOperation $Context 'cleanup'
        return Write-AzureDeploymentReceipt $Context 'deployed' $null $evidence
    } catch {
        $errorCode = "deployment_$($failedStep ?? 'validation')_failed"
        $containmentFailed = $false
        if ($Action -notin @('Plan', 'PointInTimeRestore', 'Cleanup') -and
            ($Context.Completed.Contains('resource_deploy') -or
            @($Context.Calls | Where-Object { $_ -in @('resource_deploy', 'start_contained', 'database_reopen', 'open_and_verify') }).Count)) {
            try {
                $evidence.containment = Invoke-DeploymentOperation $Context 'contain_runtime'
                foreach ($step in @('start_contained', 'contained_smoke', 'authentication_smoke_verify', 'database_reopen', 'open_and_verify')) {
                    [void]$Context.Completed.Remove($step)
                }
            } catch {
                $containmentFailed = $true
                $errorCode = "${errorCode}_containment_incomplete"
            }
        }
        $cleanupFailed = $false
        if ($Action -ne 'Cleanup') {
            try {
                $evidence.cleanup = Invoke-DeploymentOperation $Context 'cleanup'
                foreach ($step in @('cleanup', 'network_reconcile')) { [void]$Context.Completed.Remove($step) }
                if (-not $Context.Completed.Contains('recovery_switch')) {
                    foreach ($step in @('pitr_restore', 'pitr_validate_review')) { [void]$Context.Completed.Remove($step) }
                }
            } catch {
                $cleanupFailed = $true
                $errorCode = "${errorCode}_cleanup_incomplete"
            }
        } else {
            $cleanupFailed = $true
            $errorCode = "${errorCode}_cleanup_incomplete"
        }
        $evidence.errorCode = $errorCode
        $evidence.containmentComplete = -not $containmentFailed
        Write-AzureDeploymentReceipt $Context $(if ($cleanupFailed) { 'cleanup_failed' } else { 'failed' }) $failedStep $evidence | Out-Null
        throw "Azure deployment stopped at '$failedStep'. Receipt is redacted and resumable; no implicit replacement or retry was attempted."
    } finally {
        Remove-AzureSensitiveDirectories $Context
    }
}
