#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('Plan', 'Deploy', 'PointInTimeRestore', 'Recover', 'Cleanup')]
    [string]$Action = 'Plan',
    [ValidateSet('Real', 'Mock')]
    [string]$ExecutionMode = 'Real',
    [string]$TargetFile,
    [string]$MockFixturePath,
    [string]$ArtifactPath = (Join-Path $PSScriptRoot 'artifacts/release/agent-control-linux-x64.zip'),
    [string]$ReceiptPath = (Join-Path $PSScriptRoot 'artifacts/release/azure-deployment-receipt.json'),
    [string]$ResumeReceiptPath,
    [string]$AuthenticationSmokeReceiptPath,
    [string]$QualificationTargetsFile,
    [string]$RestorePoint,

    [string]$TenantId,
    [string]$SubscriptionId,
    [string]$ResourceGroupName,
    [string]$Region,
    [string]$AppRegistrationClientId,
    [string]$AppServicePlanName,
    [string]$AppServiceName,
    [string]$PostgresServerName,
    [string]$ExistingVaultResourceId,
    [string]$CanonicalOrigin,
    [ValidateSet('fresh', 'upgrade', 'legacy_import')]
    [string]$InstallationMode,
    [switch]$FirstInstallApproved,
    [int]$ExpectedSchemaVersion = 26,
    [string[]]$AppOutboundIpv4Addresses,
    [string]$RunnerIpv4Address,
    [string]$ActionGroupResourceId,
    [string]$EstimateAsOfDate,
    [string]$EstimateSource,
    [string]$EstimateCurrency,
    [string]$EstimateItemsJson,
    [decimal]$ApprovedMonthlyBudget,
    [string]$BudgetStartDate,
    [string]$BudgetEndDate,
    [string]$MaintenanceWindowStartsAt,
    [string]$MaintenanceWindowEndsAt,
    [string]$ApprovedBy,
    [string]$ApprovedAt,
    [string]$ApprovalReference,
    [string]$BurstableRiskAcceptanceReference,
    [string]$SecretVersionsJson,
    [string]$ExistingSecretVersionsJson,
    [string]$LegacyAuditBackupPath,
    [string]$LegacyAuditBackupSha256
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts/azure-deployment.ps1')

function Read-NonSecretValue {
    param([string]$Prompt, [string]$Current)
    if (-not [string]::IsNullOrWhiteSpace($Current)) { return $Current.Trim() }
    do { $value = Read-Host $Prompt } while ([string]::IsNullOrWhiteSpace($value))
    return $value.Trim()
}

function New-TargetFromParameters {
    param([string[]]$ProvidedParameterNames)
    $provided = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $ProvidedParameterNames) { [void]$provided.Add($name) }
    $script:TenantId = Read-NonSecretValue 'Approved tenant GUID' $TenantId
    $script:SubscriptionId = Read-NonSecretValue 'Approved subscription GUID' $SubscriptionId
    $script:ResourceGroupName = Read-NonSecretValue 'Approved resource group' $ResourceGroupName
    $script:Region = Read-NonSecretValue 'Approved Azure region' $Region
    $script:AppRegistrationClientId = Read-NonSecretValue 'Existing Entra application/client GUID' $AppRegistrationClientId
    $script:AppServicePlanName = Read-NonSecretValue 'App Service Plan name' $AppServicePlanName
    $script:AppServiceName = Read-NonSecretValue 'App Service name' $AppServiceName
    $script:PostgresServerName = Read-NonSecretValue 'PostgreSQL Flexible Server name' $PostgresServerName
    $script:ExistingVaultResourceId = Read-NonSecretValue 'Full existing Key Vault ARM resource ID' $ExistingVaultResourceId
    $script:CanonicalOrigin = Read-NonSecretValue 'Canonical HTTPS origin' $CanonicalOrigin
    $script:InstallationMode = Read-NonSecretValue 'Installation mode: fresh, upgrade, or legacy_import' $InstallationMode
    $script:RunnerIpv4Address = Read-NonSecretValue 'Exact approved temporary runner IPv4 address' $RunnerIpv4Address
    if (-not $AppOutboundIpv4Addresses) {
        $script:AppOutboundIpv4Addresses = @((Read-NonSecretValue 'Approved App Service outbound IPv4 addresses (comma separated)' '') -split ',' | ForEach-Object Trim)
    }
    $script:ActionGroupResourceId = Read-NonSecretValue 'Existing monitoring action-group resource ID' $ActionGroupResourceId
    $script:EstimateAsOfDate = Read-NonSecretValue 'Estimate date (YYYY-MM-DD)' $EstimateAsOfDate
    $script:EstimateSource = Read-NonSecretValue 'Current estimate source/reference' $EstimateSource
    $script:EstimateCurrency = Read-NonSecretValue 'Estimate currency (three letters)' $EstimateCurrency
    $items = if ($EstimateItemsJson) {
        $EstimateItemsJson | ConvertFrom-Json
    } else {
        $values = [ordered]@{}
        foreach ($name in $script:EstimateItemNames) {
            $values[$name] = [decimal](Read-NonSecretValue "Estimated monthly $name" '')
        }
        [PSCustomObject]$values
    }
    if (-not $provided.Contains('ApprovedMonthlyBudget')) {
        $script:ApprovedMonthlyBudget = [decimal](Read-NonSecretValue 'Approved monthly budget ceiling' '')
    }
    $script:BudgetStartDate = Read-NonSecretValue 'Budget start date' $BudgetStartDate
    $script:BudgetEndDate = Read-NonSecretValue 'Budget end date' $BudgetEndDate
    $script:MaintenanceWindowStartsAt = Read-NonSecretValue 'Maintenance window UTC start' $MaintenanceWindowStartsAt
    $script:MaintenanceWindowEndsAt = Read-NonSecretValue 'Maintenance window UTC end' $MaintenanceWindowEndsAt
    $script:ApprovedBy = Read-NonSecretValue 'Non-secret approval role/reference' $ApprovedBy
    $script:ApprovedAt = Read-NonSecretValue 'Approval timestamp (UTC)' $ApprovedAt
    $script:ApprovalReference = Read-NonSecretValue 'Change approval reference' $ApprovalReference
    $script:BurstableRiskAcceptanceReference = Read-NonSecretValue 'Explicit Burstable POC risk acceptance reference' $BurstableRiskAcceptanceReference
    $versions = if ($SecretVersionsJson) {
        @($SecretVersionsJson | ConvertFrom-Json)
    } else {
        $values = @()
        foreach ($name in $script:RequiredSecretNames) {
            $values += [PSCustomObject]@{ name = $name; version = Read-NonSecretValue "Selected non-secret version for $name" '' }
        }
        $values
    }
    $existingVersions = if ($InstallationMode -eq 'fresh') {
        @()
    } elseif ($ExistingSecretVersionsJson) {
        @($ExistingSecretVersionsJson | ConvertFrom-Json)
    } else {
        $values = @()
        foreach ($name in $script:RequiredSecretNames) {
            $values += [PSCustomObject]@{ name = $name; version = Read-NonSecretValue "Currently deployed non-secret version for $name" '' }
        }
        $values
    }
    if ($InstallationMode -eq 'legacy_import') {
        $script:LegacyAuditBackupPath = Read-NonSecretValue 'SQLite-safe legacy audit backup path' $LegacyAuditBackupPath
        $script:LegacyAuditBackupSha256 = Read-NonSecretValue 'Legacy audit backup SHA-256' $LegacyAuditBackupSha256
    }
    $estimateTotal = ($script:EstimateItemNames | ForEach-Object { [decimal]$items.$_ } | Measure-Object -Sum).Sum
    $expected = [PSCustomObject]@{
        appServicePlan = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.Web/serverfarms/$AppServicePlanName"
        appService = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.Web/sites/$AppServiceName"
        postgresFlexibleServer = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.DBforPostgreSQL/flexibleServers/$PostgresServerName"
    }
    return [PSCustomObject]@{
        contractVersion = 2
        isApproval = $true
        tenantId = $TenantId
        subscriptionId = $SubscriptionId
        resourceGroup = $ResourceGroupName
        region = $Region
        entraApplicationId = $AppRegistrationClientId
        canonicalOrigin = $CanonicalOrigin.TrimEnd('/')
        callbackUri = "$($CanonicalOrigin.TrimEnd('/'))/api/auth/callback"
        existingVaultResourceId = $ExistingVaultResourceId
        installationMode = $InstallationMode
        firstInstallApproved = [bool]$FirstInstallApproved
        expectedResourceIds = $expected
        expectedDatabaseName = 'agentcontrol'
        expectedSchemaVersion = $ExpectedSchemaVersion
        runnerIpv4Address = $RunnerIpv4Address
        legacyAuditBackupPath = $LegacyAuditBackupPath
        legacyAuditBackupSha256 = $LegacyAuditBackupSha256
        resources = [PSCustomObject]@{
            appServicePlan = [PSCustomObject]@{ name = $AppServicePlanName; sku = 'B1'; linux = $true; instanceCount = 1 }
            appService = [PSCustomObject]@{ name = $AppServiceName; nodeMajor = 24; remoteBuildEnabled = $false }
            postgresFlexibleServer = [PSCustomObject]@{
                name = $PostgresServerName; database = 'agentcontrol'; sku = 'Standard_B1ms'; tier = 'Burstable'; version = 17
                storageGiB = 32; backupRetentionDays = 7; highAvailability = $false; replicas = 0; applicationPoolMaximum = 4
            }
            approvedAppOutboundIpv4Addresses = @($AppOutboundIpv4Addresses)
            monitoring = [PSCustomObject]@{
                retentionDays = 30
                dailyIngestionLimitGiB = 0.1
                actionGroupResourceId = $ActionGroupResourceId
                budgetStartDate = $BudgetStartDate
                budgetEndDate = $BudgetEndDate
            }
        }
        estimate = [PSCustomObject]@{
            currency = $EstimateCurrency.ToUpperInvariant()
            asOfDate = $EstimateAsOfDate
            source = $EstimateSource
            items = $items
            monthlyTotal = [decimal]$estimateTotal
        }
        approvedMonthlyBudget = $ApprovedMonthlyBudget
        operatorApproval = [PSCustomObject]@{
            approvedBy = $ApprovedBy
            approvedAt = $ApprovedAt
            changeReference = $ApprovalReference
        }
        maintenanceApproval = [PSCustomObject]@{
            approvedBy = $ApprovedBy
            windowStartsAt = $MaintenanceWindowStartsAt
            windowEndsAt = $MaintenanceWindowEndsAt
        }
        riskAcceptance = [PSCustomObject]@{
            burstablePocLimitationsAccepted = $true
            reference = $BurstableRiskAcceptanceReference
        }
        preparedVaultContract = [PSCustomObject]@{
            secretNames = @($script:RequiredSecretNames)
            runtimeConsumers = @($script:RuntimeSecretNames)
            administratorPasswordRuntimeAccessible = $false
            bootstrapSecretCleanupRequired = $true
            versions = @($versions)
            existingVersions = @($existingVersions)
        }
    }
}

try {
    $target = if ($TargetFile) {
        Read-ApprovedAzureTarget ([IO.Path]::GetFullPath($TargetFile)) $ExecutionMode
    } else {
        Test-ApprovedAzureTarget (New-TargetFromParameters -ProvidedParameterNames @($PSBoundParameters.Keys)) $ExecutionMode
    }
    $context = New-AzureDeploymentContext -Root $PSScriptRoot -Target $target -ExecutionMode $ExecutionMode `
        -MockFixturePath $MockFixturePath -ArtifactPath $ArtifactPath -ReceiptPath $ReceiptPath `
        -ResumeReceiptPath $ResumeReceiptPath -RequestedAction $Action -AuthenticationSmokeReceiptPath $AuthenticationSmokeReceiptPath `
        -QualificationTargets $(if ($QualificationTargetsFile) { Get-Content -LiteralPath ([IO.Path]::GetFullPath($QualificationTargetsFile)) -Raw | ConvertFrom-Json -Depth 20 } else { $null })
    $receipt = Invoke-AzureDeployment -Context $context -Action $Action -RestorePoint $RestorePoint
    Write-Host "Azure deployment workflow status: $($receipt.status)"
    Write-Host "Redacted receipt: $ReceiptPath"
} catch {
    Write-Error "Azure deployment workflow failed closed: $($_.Exception.Message)"
    exit 1
}
