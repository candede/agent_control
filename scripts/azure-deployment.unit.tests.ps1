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

    foreach ($mode in @('fresh', 'existing')) {
        $target = New-Target $mode
        $context = New-Context $target (New-Fixture $target) "automatic-$mode"
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

    $smokeFixture = New-Fixture $target
    $smokeFixture.commands.contained_smoke[4].exitCode = 200
    $smokeFailure = New-Context $target $smokeFixture 'unauthenticated-access'
    Assert-Fails { Invoke-AzureDeployment $smokeFailure Deploy } 'stopped'
    $receipt = Get-Content -LiteralPath $smokeFailure.ReceiptPath -Raw | ConvertFrom-Json
    Assert-True ($receipt.failedStep -ceq 'contained_smoke' -and 'database_reopen' -notin @($smokeFailure.Calls) -and
        $receipt.evidence.containment.admission -ceq 'closed') 'Removing an approval gate bypassed actual authentication checks.'

    $mcpTarget = Add-McpTarget (New-Target)
    $combined = New-Context $mcpTarget (New-Fixture $mcpTarget) 'combined'
    $receipt = Invoke-AzureDeployment $combined Deploy
    Assert-True ($receipt.status -ceq 'deployed' -and
        [array]::IndexOf(@($combined.Calls), 'open_and_verify') -lt [array]::IndexOf(@($combined.Calls), 'mcp_apply') -and
        $receipt.evidence.mcp_verify.authenticatedApiConnectivity -ceq 'not_proven') `
        'Optional MCP deployment no longer preserves application availability or truthful verification.'
    Write-Host "Passed $script:Checks isolated Azure deployment unit assertions; all external commands and HTTP calls were fixture-mocked."
} finally {
    $script:ActiveAzureContext = $null
    foreach ($context in $script:Contexts) { Remove-AzureSensitiveDirectories $context }
    Remove-Item -LiteralPath $root -Recurse -Force
}
