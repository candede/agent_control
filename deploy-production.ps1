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
        $output = & $FilePath @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed: $FilePath $($Arguments -join ' ')`n$output"
        }

        return ($output -join "`n")
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

$repoRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
    $repoRoot = (Get-Location).Path
}

Set-Location $repoRoot

Require-Command "az" "Install Azure CLI from https://learn.microsoft.com/cli/azure/install-azure-cli."
Require-Command "node" "Install Node.js 24 or newer from https://nodejs.org/."
Require-Command "npm" "Install Node.js 24 or newer from https://nodejs.org/."
Require-Command "npx" "Install Node.js 24 or newer from https://nodejs.org/."

$nodeMajor = [int]((& node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 24) {
    throw "Node.js 24 or newer is required. Current version: $(& node --version)"
}

$SubscriptionId = Read-RequiredValue "Azure subscription ID" $SubscriptionId
$ResourceGroupName = Read-RequiredValue "Azure resource group name" $ResourceGroupName
$EnvironmentName = Read-RequiredValue "Environment name, such as prod" $EnvironmentName
$NamePrefix = Read-RequiredValue "Globally unique resource name prefix" $NamePrefix
$AppRegistrationClientId = Read-RequiredValue "Existing Entra app registration client ID" $AppRegistrationClientId
$KeyVaultName = Read-RequiredValue "Existing RBAC-enabled Key Vault name" $KeyVaultName
$ClientSecretName = Read-RequiredValue "Key Vault secret name for CLIENT_SECRET" $ClientSecretName
$SessionSecretName = Read-RequiredValue "Key Vault secret name for SESSION_SECRET" $SessionSecretName

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
$outputsJson = Get-AzValue -Arguments @(
    "deployment", "group", "create",
    "--resource-group", $ResourceGroupName,
    "--template-file", (Join-Path $repoRoot "infra/main.bicep"),
    "--parameters",
    "environmentName=$EnvironmentName",
    "location=$Location",
    "namePrefix=$NamePrefix",
    "tenantId=$TenantId",
    "appRegistrationClientId=$AppRegistrationClientId",
    "keyVaultName=$KeyVaultName",
    "clientSecretName=$ClientSecretName",
    "sessionSecretName=$SessionSecretName",
    "--query", "properties.outputs",
    "-o", "json",
    "--only-show-errors"
)

$outputs = $outputsJson | ConvertFrom-Json
$staticWebAppName = $outputs.staticWebAppName.value
$staticWebAppUrl = $outputs.staticWebAppUrl.value
$backendAppName = $outputs.backendAppName.value
$redirectUri = $outputs.redirectUri.value

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
Invoke-CommandChecked -FilePath "az" -Arguments @(
    "webapp", "deploy",
    "--resource-group", $ResourceGroupName,
    "--name", $backendAppName,
    "--src-path", $zipPath,
    "--type", "zip",
    "--only-show-errors"
)

Write-Host "Deploying frontend Static Web App..."
$staticWebAppToken = Get-AzValue -Arguments @(
    "staticwebapp", "secrets", "list",
    "--name", $staticWebAppName,
    "--resource-group", $ResourceGroupName,
    "--query", "properties.apiKey",
    "-o", "tsv",
    "--only-show-errors"
)

Invoke-CommandChecked -FilePath "npx" -Arguments @(
    "--yes",
    "@azure/static-web-apps-cli",
    "deploy",
    (Join-Path $repoRoot "frontend/dist"),
    "--deployment-token", $staticWebAppToken,
    "--env", "production"
)

Write-Host "Smoke-testing health endpoint..."
$healthUrl = "$staticWebAppUrl/api/health"
$healthResponse = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing
if ($healthResponse.StatusCode -lt 200 -or $healthResponse.StatusCode -ge 300) {
    throw "Health check failed with status $($healthResponse.StatusCode): $healthUrl"
}

Remove-Item -Recurse -Force $packageDir, $zipPath -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Deployment complete."
Write-Host "App URL: $staticWebAppUrl"
Write-Host "Backend App Service: $backendAppName"
Write-Host "Expected Entra redirect URI: $redirectUri"
Write-Host "If this redirect URI is not on the existing Entra app registration, add it and rerun this script before testing sign-in."