[CmdletBinding()]
param(
    [string]$SubscriptionId,
    [string]$TenantId,
    [string]$ResourceGroupName,
    [string]$Location,
    [string]$EnvironmentName = "prod",
    [string]$NamePrefix = "agent-control",
    [string]$AppRegistrationClientId,
    [string]$KeyVaultName,
    [string]$ClientSecretName = "agent-control-client-secret",
    [string]$SessionSecretName = "agent-control-session-secret",
    [ValidateSet("Public", "Private")]
    [string]$KeyVaultNetworkAccess = "Public",
    [string]$VirtualNetworkAddressPrefix = "10.42.0.0/24",
    [string]$AppServiceIntegrationSubnetPrefix = "10.42.0.0/26",
    [string]$PrivateEndpointSubnetPrefix = "10.42.0.64/27",
    [string]$StaticWebAppLocation = "westeurope",
    [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"

function Require-Command {
    param([string]$Name, [string]$InstallHint)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found. $InstallHint"
    }
}

function Read-RequiredValue {
    param([string]$Name, [string]$CurrentValue)

    if (-not [string]::IsNullOrWhiteSpace($CurrentValue)) {
        return $CurrentValue.Trim()
    }

    do {
        $value = Read-Host $Name
    } while ([string]::IsNullOrWhiteSpace($value))

    return $value.Trim()
}

function Invoke-CommandChecked {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [switch]$CaptureOutput
    )

    if ($CaptureOutput) {
        $stderrPath = [System.IO.Path]::GetTempFileName()
        try {
            $output = @(& $FilePath @Arguments 2> $stderrPath)
            $exitCode = $LASTEXITCODE
            $stderr = Get-Content -Path $stderrPath -Raw -ErrorAction SilentlyContinue

            if ($exitCode -ne 0) {
                $details = @()
                if ($output.Count -gt 0) {
                    $details += $output -join "`n"
                }
                if (-not [string]::IsNullOrWhiteSpace($stderr)) {
                    $details += $stderr.TrimEnd()
                }

                $detailSuffix = if ($details.Count -gt 0) { "`n$($details -join "`n")" } else { "" }
                throw "Command failed: $FilePath $($Arguments -join ' ')$detailSuffix"
            }

            if (-not [string]::IsNullOrWhiteSpace($stderr)) {
                Write-Warning $stderr.TrimEnd()
            }

            return ($output -join "`n")
        }
        finally {
            Remove-Item -Path $stderrPath -Force -ErrorAction SilentlyContinue
        }
    }

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: $FilePath $($Arguments -join ' ')"
    }
}

function Get-AzValue {
    param([string[]]$Arguments)

    return (Invoke-CommandChecked -FilePath "az" -Arguments $Arguments -CaptureOutput).Trim()
}

function New-AppServiceQuotaErrorMessage {
    param(
        [string]$SubscriptionId,
        [string]$Location,
        [string]$OriginalError
    )

    $quotaScope = "/subscriptions/$SubscriptionId/providers/Microsoft.Web/locations/$Location"
    $minimumLimitMatch = [regex]::Match($OriginalError, '\(Minimum\) New Limit[^:]*:\s*(\d+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    $requestedLimit = if ($minimumLimitMatch.Success) { [int]$minimumLimitMatch.Groups[1].Value } else { 1 }
    return @(
        "Azure App Service quota is insufficient for the B1 plan in region '$Location'."
        "App Service reports its worker capacity as 'VMs'; this template does not deploy an Azure virtual machine."
        ""
        "Request the minimum quota for one B1 worker, then rerun this deployment:"
        "az extension add --name quota --upgrade"
        "az provider register --namespace Microsoft.Quota --subscription $SubscriptionId --wait"
        "az quota update --resource-name B1 --scope `"$quotaScope`" --limit-object value=$requestedLimit"
        ""
        "Quota allocation is free, but the deployed B1 App Service plan is billable. The request requires subscription-level quota permissions and may require Azure approval. The script does not change subscription quota automatically."
        ""
        "Original Azure error:"
        $OriginalError
    ) -join "`n"
}

function Wait-ForHealthyEndpoint {
    param(
        [string]$Uri,
        [int]$TimeoutSeconds = 600,
        [int]$RetryIntervalSeconds = 10
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastFailure = "No response received."

    do {
        try {
            $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 30
            $body = $response.Content | ConvertFrom-Json
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300 -and $body.ok -eq $true) {
                return
            }

            $lastFailure = "Received status $($response.StatusCode) without the expected { ok: true } response."
        }
        catch {
            $lastFailure = $_.Exception.Message
        }

        if ([DateTimeOffset]::UtcNow -lt $deadline) {
            Write-Host "Backend is not ready yet; retrying in $RetryIntervalSeconds seconds..."
            Start-Sleep -Seconds $RetryIntervalSeconds
        }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    throw "Health check did not succeed within $TimeoutSeconds seconds: $Uri`nLast failure: $lastFailure"
}

function Wait-ForKeyVaultReferences {
    param(
        [string]$AppResourceId,
        [string[]]$SettingNames,
        [int]$TimeoutSeconds = 600,
        [int]$RetryIntervalSeconds = 10
    )

    $refreshUri = "https://management.azure.com$AppResourceId/config/configreferences/appsettings/refresh?api-version=2022-03-01"
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastFailure = "No reference status received."
    $lastStatus = ""

    do {
        try {
            $referencesJson = Get-AzValue -Arguments @(
                "rest",
                "--method", "post",
                "--uri", $refreshUri,
                "-o", "json",
                "--only-show-errors"
            )
            $response = $referencesJson | ConvertFrom-Json
            $references = @($response.value | Where-Object { $SettingNames -contains $_.name })
            $status = @($SettingNames | ForEach-Object {
                    $settingName = $_
                    $reference = $references | Where-Object { $_.name -eq $settingName } | Select-Object -First 1
                    if ($null -eq $reference) {
                        "$settingName=Missing"
                    }
                    else {
                        "$settingName=$($reference.properties.status)"
                    }
                }) -join ", "

            if ($status -ne $lastStatus) {
                Write-Host "Key Vault references: $status"
                $lastStatus = $status
            }

            $unresolved = @($references | Where-Object { $_.properties.status -ne "Resolved" })
            if ($references.Count -eq $SettingNames.Count -and $unresolved.Count -eq 0) {
                return
            }

            $lastFailure = $status
        }
        catch {
            $lastFailure = $_.Exception.Message
        }

        if ([DateTimeOffset]::UtcNow -lt $deadline) {
            Start-Sleep -Seconds $RetryIntervalSeconds
        }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    throw "Key Vault references did not resolve within $TimeoutSeconds seconds.`nLast status: $lastFailure"
}

function Wait-ForWebAppDeployment {
    param(
        [string]$AppName,
        [DateTimeOffset]$SubmittedAfter,
        [int]$TimeoutSeconds = 900,
        [int]$RetryIntervalSeconds = 10
    )

    $deploymentUrl = "https://$AppName.scm.azurewebsites.net/api/deployments/latest"
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastStatus = "Waiting for Kudu to create the deployment record."
    $lastProgress = ""

    do {
        try {
            $deploymentJson = Get-AzValue -Arguments @(
                "rest",
                "--method", "get",
                "--url", $deploymentUrl,
                "--resource", "https://management.azure.com/",
                "-o", "json",
                "--only-show-errors"
            )
            $deployment = $deploymentJson | ConvertFrom-Json
            $receivedTime = if ($deployment.received_time -is [DateTimeOffset]) {
                $deployment.received_time
            }
            elseif ($deployment.received_time -is [DateTime]) {
                [DateTimeOffset]$deployment.received_time
            }
            else {
                [DateTimeOffset]::Parse(
                    [string]$deployment.received_time,
                    [System.Globalization.CultureInfo]::InvariantCulture,
                    [System.Globalization.DateTimeStyles]::RoundtripKind
                )
            }

            if ($receivedTime -ge $SubmittedAfter.AddSeconds(-5)) {
                $lastStatus = "Deployment $($deployment.id): $($deployment.status_text) $($deployment.progress)".Trim()
                if ($lastStatus -ne $lastProgress) {
                    Write-Host $lastStatus
                    $lastProgress = $lastStatus
                }

                if ($deployment.complete -and $deployment.status -eq 4) {
                    return
                }

                if ($deployment.complete) {
                    throw "Kudu deployment failed with status $($deployment.status): $lastStatus`nLogs: $($deployment.log_url)"
                }
            }
        }
        catch {
            if ($_.Exception.Message -match "Kudu deployment failed") {
                throw
            }

            $lastStatus = $_.Exception.Message
        }

        if ([DateTimeOffset]::UtcNow -lt $deadline) {
            Start-Sleep -Seconds $RetryIntervalSeconds
        }
    } while ([DateTimeOffset]::UtcNow -lt $deadline)

    throw "Kudu deployment did not complete within $TimeoutSeconds seconds.`nLast status: $lastStatus`nDeployment status: $deploymentUrl"
}

function Submit-WebAppZipDeployment {
    param(
        [string]$ResourceGroupName,
        [string]$AppName,
        [string]$ZipPath,
        [int]$MaximumAttempts = 3
    )

    for ($attempt = 1; $attempt -le $MaximumAttempts; $attempt++) {
        try {
            Invoke-CommandChecked -FilePath "az" -Arguments @(
                "webapp", "deploy",
                "--resource-group", $ResourceGroupName,
                "--name", $AppName,
                "--src-path", $ZipPath,
                "--type", "zip",
                "--async", "true",
                "--track-status", "false",
                "--only-show-errors"
            ) -CaptureOutput | Out-Null
            return
        }
        catch {
            $isTransientScmFailure = $_.Exception.Message -match "HTTP_50[234]|status code 50[234]|Bad Gateway|Service Unavailable|Gateway Timeout"
            if (-not $isTransientScmFailure -or $attempt -eq $MaximumAttempts) {
                throw
            }

            Write-Warning "Kudu returned a transient gateway error while accepting the ZIP. Retrying deployment submission ($($attempt + 1)/$MaximumAttempts)..."
            Start-Sleep -Seconds 15
        }
    }
}

function Get-StaticSitesClient {
    $releaseDefinitions = Invoke-RestMethod -Uri "https://aka.ms/swalocaldeploy"
    $stableRelease = @($releaseDefinitions) | Where-Object { $_.version -eq "stable" } | Select-Object -First 1
    if ($null -eq $stableRelease) {
        throw "The Static Sites client release metadata did not contain a stable version."
    }

    $platform = if ($IsWindows) {
        "win-x64"
    }
    elseif ($IsMacOS) {
        "osx-x64"
    }
    elseif ($IsLinux) {
        "linux-x64"
    }
    else {
        throw "Static Sites deployment is not supported on this operating system."
    }

    $fileDefinition = $stableRelease.files.PSObject.Properties[$platform].Value
    if ($null -eq $fileDefinition) {
        throw "The stable Static Sites client does not provide a '$platform' binary."
    }

    $clientDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "agent-control/static-sites-client/$($stableRelease.buildId)"
    $clientPath = Join-Path $clientDirectory ([System.IO.Path]::GetFileName($fileDefinition.url))
    New-Item -ItemType Directory -Path $clientDirectory -Force | Out-Null

    $expectedHash = $fileDefinition.sha.ToLowerInvariant()
    $actualHash = if (Test-Path $clientPath) {
        (Get-FileHash -Path $clientPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    else {
        ""
    }

    if ($actualHash -ne $expectedHash) {
        Remove-Item -Path $clientPath -Force -ErrorAction SilentlyContinue
        Write-Host "Downloading the Microsoft Static Sites deployment client..."
        Invoke-WebRequest -Uri $fileDefinition.url -OutFile $clientPath -UseBasicParsing
        $actualHash = (Get-FileHash -Path $clientPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            Remove-Item -Path $clientPath -Force -ErrorAction SilentlyContinue
            throw "Static Sites client checksum validation failed. Expected $expectedHash, received $actualHash."
        }
    }

    if (-not $IsWindows) {
        Invoke-CommandChecked -FilePath "chmod" -Arguments @("+x", $clientPath)
    }

    return $clientPath
}

function Invoke-StaticWebAppDeployment {
    param(
        [string]$ClientPath,
        [string]$DeploymentToken,
        [string]$RepositoryRoot,
        [string]$ArtifactPath
    )

    $deploymentEnvironment = @{
        DEPLOYMENT_ACTION         = "upload"
        DEPLOYMENT_PROVIDER       = "SwaCli"
        REPOSITORY_BASE           = $RepositoryRoot
        SKIP_APP_BUILD            = "true"
        SKIP_API_BUILD            = "true"
        DEPLOYMENT_TOKEN          = $DeploymentToken
        APP_LOCATION              = $ArtifactPath
        CONFIG_FILE_LOCATION      = $ArtifactPath
        VERBOSE                   = "false"
        FUNCTION_LANGUAGE         = "node"
        FUNCTION_LANGUAGE_VERSION = "22"
    }
    $previousValues = @{}

    try {
        foreach ($name in $deploymentEnvironment.Keys) {
            $previousValues[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
            [Environment]::SetEnvironmentVariable($name, $deploymentEnvironment[$name], "Process")
        }

        Invoke-CommandChecked -FilePath $ClientPath -Arguments @()
    }
    finally {
        foreach ($name in $deploymentEnvironment.Keys) {
            if ($null -eq $previousValues[$name]) {
                Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
            }
            else {
                [Environment]::SetEnvironmentVariable($name, $previousValues[$name], "Process")
            }
        }
    }
}

$repoRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
    $repoRoot = (Get-Location).Path
}

Set-Location $repoRoot

Require-Command "az" "Install Azure CLI from https://learn.microsoft.com/cli/azure/install-azure-cli."
Require-Command "node" "Install Node.js 24 or newer from https://nodejs.org/."
Require-Command "npm" "Install Node.js 24 or newer from https://nodejs.org/."

$nodeMajor = [int]((& node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 24) {
    throw "Node.js 24 or newer is required. Current version: $(& node --version)"
}

$SubscriptionId = Read-RequiredValue "Azure subscription ID" $SubscriptionId
$ResourceGroupName = Read-RequiredValue "Azure resource group name" $ResourceGroupName
$StaticWebAppLocation = Read-RequiredValue "Azure Static Web Apps region" $StaticWebAppLocation
$EnvironmentName = Read-RequiredValue "Environment name, such as prod" $EnvironmentName
$NamePrefix = Read-RequiredValue "Globally unique resource name prefix" $NamePrefix
$AppRegistrationClientId = Read-RequiredValue "Existing Entra app registration client ID" $AppRegistrationClientId
$KeyVaultName = Read-RequiredValue "Existing RBAC-enabled Key Vault name" $KeyVaultName
$ClientSecretName = Read-RequiredValue "Key Vault secret name for CLIENT_SECRET" $ClientSecretName
$SessionSecretName = Read-RequiredValue "Key Vault secret name for SESSION_SECRET" $SessionSecretName
$KeyVaultNetworkAccess = if ($KeyVaultNetworkAccess -ieq "Private") { "Private" } else { "Public" }
$VirtualNetworkAddressPrefix = Read-RequiredValue "Private mode virtual network address prefix" $VirtualNetworkAddressPrefix
$AppServiceIntegrationSubnetPrefix = Read-RequiredValue "Private mode App Service integration subnet prefix" $AppServiceIntegrationSubnetPrefix
$PrivateEndpointSubnetPrefix = Read-RequiredValue "Private mode private endpoint subnet prefix" $PrivateEndpointSubnetPrefix

Write-Host "Checking Azure sign-in..."
try {
    Get-AzValue -Arguments @("account", "show", "--only-show-errors", "-o", "json") | Out-Null
}
catch {
    Write-Host "Opening browser for Azure sign-in..."
    $loginArgs = @("login", "--only-show-errors")
    if (-not [string]::IsNullOrWhiteSpace($TenantId)) {
        $loginArgs += @("--tenant", $TenantId)
    }
    Invoke-CommandChecked -FilePath "az" -Arguments $loginArgs
    Get-AzValue -Arguments @("account", "show", "--only-show-errors", "-o", "json") | Out-Null
}

Invoke-CommandChecked -FilePath "az" -Arguments @("account", "set", "--subscription", $SubscriptionId, "--only-show-errors")

if ([string]::IsNullOrWhiteSpace($TenantId)) {
    $TenantId = Get-AzValue -Arguments @("account", "show", "--query", "tenantId", "-o", "tsv", "--only-show-errors")
}

if ([string]::IsNullOrWhiteSpace($Location)) {
    Write-Host "Using the target resource group's Azure region..."
    try {
        $Location = Get-AzValue -Arguments @("group", "show", "--name", $ResourceGroupName, "--query", "location", "-o", "tsv", "--only-show-errors")
    }
    catch {
        throw "Could not find resource group '$ResourceGroupName' to infer Azure region. Create the resource group first, or rerun with -Location."
    }
}
else {
    $Location = $Location.Trim()
}

Write-Host "Creating or updating resource group..."
Invoke-CommandChecked -FilePath "az" -Arguments @(
    "group", "create",
    "--name", $ResourceGroupName,
    "--location", $Location,
    "--only-show-errors"
)

Write-Host "Deploying Azure resources with Bicep..."
try {
    $outputsJson = Get-AzValue -Arguments @(
        "deployment", "group", "create",
        "--resource-group", $ResourceGroupName,
        "--template-file", (Join-Path $repoRoot "infra/main.bicep"),
        "--parameters",
        "environmentName=$EnvironmentName",
        "location=$Location",
        "staticWebAppLocation=$StaticWebAppLocation",
        "namePrefix=$NamePrefix",
        "tenantId=$TenantId",
        "appRegistrationClientId=$AppRegistrationClientId",
        "keyVaultName=$KeyVaultName",
        "clientSecretName=$ClientSecretName",
        "sessionSecretName=$SessionSecretName",
        "keyVaultNetworkAccess=$KeyVaultNetworkAccess",
        "virtualNetworkAddressPrefix=$VirtualNetworkAddressPrefix",
        "appServiceIntegrationSubnetPrefix=$AppServiceIntegrationSubnetPrefix",
        "privateEndpointSubnetPrefix=$PrivateEndpointSubnetPrefix",
        "--query", "properties.outputs",
        "-o", "json",
        "--only-show-errors"
    )
}
catch {
    if ($_.Exception.Message -match "InternalSubscriptionIsOverQuotaForSku|Operation cannot be completed without additional quota") {
        throw (New-AppServiceQuotaErrorMessage -SubscriptionId $SubscriptionId -Location $Location -OriginalError $_.Exception.Message)
    }

    throw
}

$outputs = $outputsJson | ConvertFrom-Json
$staticWebAppName = $outputs.staticWebAppName.value
$staticWebAppUrl = $outputs.staticWebAppUrl.value
$backendAppName = $outputs.backendAppName.value
$backendAppResourceId = $outputs.backendAppResourceId.value
$redirectUri = $outputs.redirectUri.value

if ($KeyVaultNetworkAccess -eq "Private") {
    Write-Host "Disabling public network access on Key Vault '$KeyVaultName'..."
    Invoke-CommandChecked -FilePath "az" -Arguments @(
        "keyvault", "update",
        "--resource-group", $ResourceGroupName,
        "--name", $KeyVaultName,
        "--public-network-access", "Disabled",
        "-o", "none",
        "--only-show-errors"
    )

    $vaultPublicNetworkAccess = Get-AzValue -Arguments @(
        "keyvault", "show",
        "--resource-group", $ResourceGroupName,
        "--name", $KeyVaultName,
        "--query", "properties.publicNetworkAccess",
        "-o", "tsv",
        "--only-show-errors"
    )
    if ($vaultPublicNetworkAccess -ne "Disabled") {
        throw "Private mode requires Key Vault public network access to be Disabled, but Azure reports '$vaultPublicNetworkAccess'."
    }
}

Write-Host "Refreshing and validating App Service Key Vault references..."
Wait-ForKeyVaultReferences `
    -AppResourceId $backendAppResourceId `
    -SettingNames @("CLIENT_SECRET", "SESSION_SECRET")

if (-not $SkipChecks) {
    Write-Host "Installing dependencies and validating the app..."
    Invoke-CommandChecked -FilePath "npm" -Arguments @("ci")
    Invoke-CommandChecked -FilePath "npm" -Arguments @("run", "test", "--workspace", "backend")
    Invoke-CommandChecked -FilePath "npm" -Arguments @("run", "test", "--workspace", "frontend")
    Invoke-CommandChecked -FilePath "npm" -Arguments @("run", "typecheck", "--workspace", "backend")
    Invoke-CommandChecked -FilePath "npm" -Arguments @("run", "lint", "--workspace", "frontend")
    Invoke-CommandChecked -FilePath "npm" -Arguments @("run", "build")
}
else {
    Write-Host "Skipping tests and build checks because -SkipChecks was specified."
    Invoke-CommandChecked -FilePath "npm" -Arguments @("ci")
    Invoke-CommandChecked -FilePath "npm" -Arguments @("run", "build")
}

Write-Host "Packaging backend..."
$packageDir = Join-Path $repoRoot "backend-package"
$zipPath = Join-Path $repoRoot "backend.zip"
Remove-Item -Recurse -Force $packageDir, $zipPath -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $packageDir "backend") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $packageDir "frontend") | Out-Null
Copy-Item (Join-Path $repoRoot "package-lock.json") $packageDir
Copy-Item (Join-Path $repoRoot "package.json") $packageDir
Copy-Item (Join-Path $repoRoot "backend/package.json") (Join-Path $packageDir "backend/package.json")
Copy-Item (Join-Path $repoRoot "frontend/package.json") (Join-Path $packageDir "frontend/package.json")
Copy-Item -Recurse (Join-Path $repoRoot "backend/dist") (Join-Path $packageDir "backend/dist")
Push-Location $packageDir
try {
    Invoke-CommandChecked -FilePath "npm" -Arguments @("ci", "--omit=dev", "--workspace", "backend")
}
finally {
    Pop-Location
}
Remove-Item -Recurse -Force (Join-Path $packageDir "frontend")
Compress-Archive -Path (Join-Path $packageDir "*") -DestinationPath $zipPath -Force

Write-Host "Deploying backend App Service..."
$backendDeploymentSubmittedAt = [DateTimeOffset]::UtcNow
Submit-WebAppZipDeployment -ResourceGroupName $ResourceGroupName -AppName $backendAppName -ZipPath $zipPath
Wait-ForWebAppDeployment -AppName $backendAppName -SubmittedAfter $backendDeploymentSubmittedAt

Write-Host "Deploying frontend Static Web App..."
$staticWebAppToken = Get-AzValue -Arguments @(
    "staticwebapp", "secrets", "list",
    "--name", $staticWebAppName,
    "--resource-group", $ResourceGroupName,
    "--query", "properties.apiKey",
    "-o", "tsv",
    "--only-show-errors"
)

$staticSitesClient = Get-StaticSitesClient
Invoke-StaticWebAppDeployment `
    -ClientPath $staticSitesClient `
    -DeploymentToken $staticWebAppToken `
    -RepositoryRoot $repoRoot `
    -ArtifactPath (Join-Path $repoRoot "frontend/dist")

Write-Host "Smoke-testing health endpoint..."
$healthUrl = "$staticWebAppUrl/api/health"
Wait-ForHealthyEndpoint -Uri $healthUrl

Remove-Item -Recurse -Force $packageDir, $zipPath -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Deployment complete."
Write-Host "App URL: $staticWebAppUrl"
Write-Host "Backend App Service: $backendAppName"
Write-Host "Expected Entra redirect URI: $redirectUri"
Write-Host "If this redirect URI is not on the existing Entra app registration, add it and rerun this script before testing sign-in."