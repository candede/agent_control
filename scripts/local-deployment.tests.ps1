#requires -Version 7.0
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
$repositoryRoot=Split-Path $PSScriptRoot -Parent
$scratchRoot=Join-Path $repositoryRoot 'artifacts/test-scratch'
$testRoot=Join-Path $scratchRoot "agent control tests $([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$script:Calls=[Collections.Generic.List[string]]::new()
$script:Failure=''
$script:Volumes=[Collections.Generic.HashSet[string]]::new()
$script:ComposeVersion='2.30.0'
$script:NoDocker=$false
$script:Checks=0
$script:AuthConfigured=$true
$script:CheckProjectEnvironment=$false
$script:Prompts=[Collections.Generic.List[string]]::new()
$script:Answers=[Collections.Generic.Queue[string]]::new()
$script:WizardTrace=[Collections.Generic.List[string]]::new()
$script:FixtureCalls=[Collections.Generic.List[object]]::new()
$script:MonitoredMarker=''
$script:MarkerCalls=[Collections.Generic.List[object]]::new()
function Read-Host {
    param([string]$Prompt,[switch]$AsSecureString)
    $script:WizardTrace.Add("PROMPT: $Prompt")
    $script:Prompts.Add("$Prompt|secure=$AsSecureString")
    if (-not $script:Answers.Count) { throw 'Unexpected onboarding prompt.' }
    $answer=$script:Answers.Dequeue()
    if ($AsSecureString) {
        if (-not $answer) { return [Security.SecureString]::new() }
        return ConvertTo-SecureString $answer -AsPlainText -Force
    }
    return $answer
}
function Add-EditAnswers {
    param([string[]]$Values,[string]$Domains='',[string]$DisplayName='')
    foreach ($answer in $Values[0..2]) { $script:Answers.Enqueue($answer) }
    foreach ($answer in @($Domains,$DisplayName,'')) { $script:Answers.Enqueue($answer) }
    foreach ($answer in $Values[3..4]) { $script:Answers.Enqueue($answer) }
}
function Read-FixtureRegistry {
    param($Context)
    return ConvertFrom-DeploymentTenantRegistry ([IO.File]::ReadAllText((Join-Path $Context.State 'secrets/tenants.json')))
}
function Get-Command {
    param([string]$Name,$ErrorAction)
    if ($Name -eq 'docker') { if (-not $script:NoDocker) { return @{Name='docker'} }; return }
    Microsoft.PowerShell.Core\Get-Command $Name -ErrorAction $ErrorAction
}
function Invoke-TestDocker {
    param([string[]]$Arguments,[switch]$Capture)
    $line=$Arguments -join '|'; $script:Calls.Add($line)
    if ($script:MonitoredMarker) {
        $script:MarkerCalls.Add(@{command=$line;maintenance=(Test-Path -LiteralPath $script:MonitoredMarker)})
    }
    if ($script:CheckProjectEnvironment -and $Arguments[0] -eq 'compose' -and $Arguments -contains '--env-file') {
        foreach ($name in @('LOCAL_STATE_DIR','LOCAL_TEST_IMAGE','APP_PORT','APP_UID','APP_GID','APP_IMAGE','TENANTS_JSON','TENANTS_JSON_FILE','TENANT_ID','CLIENT_ID','CLIENT_SECRET','CLIENT_SECRET_FILE','TENANT_DOMAINS','TENANT_DISPLAY_NAME','FRONTEND_ORIGIN','REDIRECT_URI','TRUST_PROXY')) {
            if ($null -ne [Environment]::GetEnvironmentVariable($name)) { throw "Shell environment overrode project setting $name." }
        }
    }
    $projectIndex=[Array]::IndexOf($Arguments,'-p')
    if ($projectIndex -ge 0 -and $Arguments[$projectIndex+1] -match '^agent-control-check-[a-f0-9]{32}$') {
        $environmentFile=$Arguments[[Array]::IndexOf($Arguments,'--env-file')+1]
        $script:FixtureCalls.Add(@{
            command=$line;project=$Arguments[$projectIndex+1];file=$environmentFile
            environment=[IO.File]::ReadAllText($environmentFile)
        })
    }
    if ($script:Failure -and $line -match $script:Failure) { throw 'Simulated Docker failure (redacted).' }
    if ($Arguments[0] -eq 'info') { return '29.7.2' }
    if ($line -eq 'compose|version|--short') { return $script:ComposeVersion }
    if ($Arguments[0] -eq 'volume') { return ($script:Volumes -join "`n") }
    if ($line -match '\|postgres$') {
        $projectIndex=[Array]::IndexOf($Arguments,'-p')
        if ($projectIndex -ge 0) { $script:Volumes.Add("$($Arguments[$projectIndex+1])_data") | Out-Null }
    }
}
function docker {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
    $global:LASTEXITCODE=0
    Invoke-TestDocker $Arguments
}
function Invoke-RestMethod {
    param([string]$Uri,[int]$TimeoutSec)
    if ($Uri.EndsWith('/api/ready')) { return @{ok=$true} }
    if ($Uri.EndsWith('/api/auth/status')) { return @{authConfigured=$script:AuthConfigured} }
    throw 'Unexpected readiness URL.'
}
function Get-LocalHealth {
    param([string]$Url)
    Assert-True ($Url -match '^http://localhost:\d+$') 'Deployment health must not depend on tunnel reachability.'
    return @{authConfigured=$script:AuthConfigured;callback="$Url/api/auth/callback"}
}
function Assert-True { param([bool]$Condition,[string]$Message) if (-not $Condition) { throw $Message }; $script:Checks++ }
function Assert-Fails { param([scriptblock]$Command,[string]$Pattern) try { & $Command; throw 'Expected failure did not occur' } catch { Assert-True ($_.Exception.Message -match $Pattern) "Unexpected failure: $($_.Exception.Message)" } }
function Get-UniqueCallIndex {
    param([string[]]$Calls,[string]$Pattern)
    $indices=@(for ($index=0; $index -lt $Calls.Count; $index++) { if ($Calls[$index] -match $Pattern) { $index } })
    Assert-True ($indices.Count -eq 1) "Expected exactly one command matching $Pattern."
    return $indices[0]
}
function New-FixtureContext {
    param([string]$Name,[int]$Port=14391)
    $fixture=New-LocalContext $testRoot $Name
    [IO.Directory]::CreateDirectory($fixture.State) | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture.State 'settings.json'),(@{port=$Port;tenantId='';clientId=''} | ConvertTo-Json))
    [IO.Directory]::CreateDirectory((Join-Path $fixture.State 'secrets')) | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture.State 'secrets/client-secret'),'')
    return New-LocalContext $testRoot $Name
}
function Get-ConfigSnapshot {
    param($Context)
    $snapshot=@{}
    foreach ($relative in @('settings.json','compose.env','secrets/client-secret','secrets/tenants.json','secrets/postgres-admin','secrets/postgres-app','secrets/session')) {
        $path=Join-Path $Context.State $relative
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $snapshot[$relative]=@{hash=(Get-FileHash -LiteralPath $path).Hash;modified=(Get-Item -LiteralPath $path).LastWriteTimeUtc.Ticks}
    }
    return $snapshot
}
function Assert-ConfigUnchanged {
    param($Context,$Snapshot,[string[]]$Except=@())
    $current=Get-ConfigSnapshot $Context
    foreach ($relative in $Snapshot.Keys) {
        if ($relative -in $Except) { continue }
        Assert-True ($current[$relative].hash -ceq $Snapshot[$relative].hash -and $current[$relative].modified -eq $Snapshot[$relative].modified) "Unchanged configuration file was rewritten: $relative."
    }
}
try {
    $guidance=(Show-LocalRegistrationGuidance 6>&1) -join "`n"
    foreach ($permission in @('openid','profile','offline_access','CopilotPackages.Read.All','CopilotPackages.ReadWrite.All','User.ReadBasic.All','Group.Read.All','User.Read.All','LicenseAssignment.Read.All','Reports.Read.All','AgentIdentity.Read.All','AuditLogsQuery.Read.All','ThreatHunting.Read.All','ResourceQuery.Resources.Read','CopilotStudio.AdminActions.Invoke')) {
        Assert-True ($guidance.Contains($permission)) "Registration guidance omitted permission $permission."
    }
    $manifest=Get-Content -LiteralPath (Join-Path $repositoryRoot 'infra/entra-app-manifest.json') -Raw | ConvertFrom-Json
    Assert-True (($manifest.appRoles.value -join ',') -ceq 'AgentControl.Viewer,AgentControl.Admin') 'Manifest must expose exactly Viewer and Admin.'
    Assert-True (@($manifest.appRoles | Where-Object { ($_.allowedMemberTypes -join ',') -cne 'User' }).Count -eq 0) 'App roles must be assignable to users/groups only.'
    foreach ($role in $manifest.appRoles) { Assert-True ($guidance.Contains($role.value)) 'Registration guidance omitted an application role.' }
    foreach ($requiredText in @('Microsoft Graph - Delegated permissions','Power Platform - Delegated permissions','8578e004-a5c6-46e7-913e-12f58912df43','tenant administrator consent','Optional Microsoft Graph Application permissions','Admin includes Viewer access','only one role assignment','Assignment required','Users/Groups for Allowed member types','does not verify or grant permissions')) {
        Assert-True ($guidance.Contains($requiredText)) "Registration guidance omitted distinction: $requiredText."
    }
    foreach ($requiredText in @('checks delegated access automatically','Normal sign-in, MFA or Conditional Access','Automatic checks never change packages','Token acquisition alone does not prove provider access','Select Grant admin consent','the app does not request or grant permissions')) {
        Assert-True ($guidance.Contains($requiredText)) "Automatic access-check guidance omitted distinction: $requiredText."
    }
    Assert-True (-not $guidance.Contains('sign-in requests all implemented delegated permissions')) 'Sign-in must not request feature consent.'
    Assert-True ($guidance -notmatch '(?m)^[ \t]+User\.Read[ \t]+') 'OIDC sign-in must not require an unused Graph profile permission.'
    Assert-True ($guidance.Contains('User.Read is not used by Agent Control.')) 'Registration guidance must identify the unused Graph profile grant.'
    Assert-True ($guidance.Contains('the current app requests these read scopes separately.')) 'Registration guidance must preserve separately requested read scopes.'
    $entry=Microsoft.PowerShell.Core\Get-Command (Join-Path $repositoryRoot 'deploy-local.ps1')
    foreach ($removed in @('TenantId','ClientId','ClientSecretFile','Port','StateRoot','Action','DryRun','ConfirmCleanup','BackupFile','RestoreDatabase','CleanupBatchSize','ConfirmReset','OpenBrowser')) {
        Assert-True (-not $entry.Parameters.ContainsKey($removed)) "Entry point still accepts $removed."
    }
    Assert-True ($entry.Parameters.ContainsKey('DbReset')) 'Entry point must expose the explicit DbReset switch.'
    Assert-True ($entry.Parameters['DbReset'].ParameterType -eq [Management.Automation.SwitchParameter]) 'DbReset must be an opt-in switch.'
    Assert-True ($entry.Parameters['DbReset'].Aliases -contains 'db-reset') 'The db-reset spelling must select the same switch.'
    Assert-True ($entry.ScriptBlock.Ast.ParamBlock.Parameters.Count -eq 3) 'Entry point must expose only Command, Project and DbReset.'
    Assert-True ($entry.Parameters['Command'].Aliases -contains 'Action') 'Entry point must accept -Action as an alias for Command.'
    $defaultProject=($entry.ScriptBlock.Ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'Project' }).DefaultValue.Value
    Assert-True ($defaultProject -ceq 'agent-control') 'Default project changed.'
    $defaultCommand=($entry.ScriptBlock.Ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'Command' }).DefaultValue.Value
    Assert-True ($defaultCommand -ceq 'start') 'Default command must be start.'
    $context=New-FixtureContext 'fixture-project'
    Assert-True ($context.State -ceq (Join-Path $testRoot '.local/fixture-project')) 'Project state is not under the repository .local folder.'
    $tenant='11111111-1111-1111-1111-111111111111'
    $client='22222222-2222-2222-2222-222222222222'
    $clientSecret='fixture-client-secret'
    $invalidDomainInputs=@(
        "example$([char]0x3002)com","example$([char]0xff0e)com","example$([char]0xff61)com",
        "exam$([char]0x200b)ple.com","exam$([char]0x200c)ple.com","exam$([char]0x200d)ple.com",
        "exam$([char]0x2060)ple.com","exam$([char]0xfeff)ple.com",
        'https://example.com','example.com/path','example.com\path','user@example.com','*.example.com',
        'example.com:443','example.com?query=1','example.com#fragment','example.com%2fpath'
    )
    foreach ($domain in $invalidDomainInputs) {
        Assert-True ($null -eq (ConvertTo-DeploymentDomain $domain)) 'A forbidden raw domain was accepted before IDNA normalization.'
    }
    foreach ($case in @(
        @{raw=' Example.COM ';expected='example.com'},
        @{raw="b$([char]0x00fc)cher.example";expected='xn--bcher-kva.example'},
        @{raw="bu$([char]0x0308)cher.example";expected='xn--bcher-kva.example'},
        @{raw='XN--BCHER-KVA.EXAMPLE';expected='xn--bcher-kva.example'}
    )) {
        Assert-True ((ConvertTo-DeploymentDomain $case.raw) -ceq $case.expected) 'Domain validation rejected or changed a supported Unicode-letter IDN or canonical ASCII domain.'
    }
    $script:NoDocker=$true
    Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'approved Docker'
    $script:NoDocker=$false; $script:Failure='^info\|'
    Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'Simulated'
    $script:Failure=''; $script:ComposeVersion='1.29.0'
    Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'Compose v2'
    $script:ComposeVersion='2.30.0'
    foreach ($action in @('Stop','EditConfig','Start','Test','Reset','Retain')) {
        $callCount=$script:Calls.Count
        Assert-Fails { Invoke-LocalDeployment $context $action -DbReset } 'DbReset.*start'
        Assert-True ($script:Calls.Count -eq $callCount) 'Invalid DbReset combination invoked Docker.'
    }
    Assert-Fails { Invoke-LocalDeployment $context 'Reset' } 'reset denied'
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $listener.Start()
    try { Assert-Fails { Assert-LocalPort $listener.LocalEndpoint.Port } 'occupied' } finally { $listener.Stop() }
    foreach ($answer in @($tenant,$client,$clientSecret,'contoso.com')) { $script:Answers.Enqueue($answer) }
    foreach ($failure in @('^build\|','\|migrate$','\|--wait-timeout\|90\|postgres$','\|--wait-timeout\|90\|app$')) {
        $script:Failure=$failure
        Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'Simulated'
    }
    Assert-True ($script:Prompts.Count -eq 4) 'New project did not onboard exactly once.'
    Assert-True ($script:Prompts[2] -match 'secure=True$') 'Client secret was not prompted securely.'
    $saved=Get-Content -LiteralPath (Join-Path $context.State 'settings.json') -Raw | ConvertFrom-Json
    Assert-True ($saved.tenants[0].tenantId -ceq $tenant -and $saved.tenants[0].clientId -ceq $client) 'Onboarding identifiers were not saved.'
    Assert-True ((Read-FixtureRegistry $context)[0].clientSecret -ceq $clientSecret) 'Client secret was not saved.'
    $compose=[IO.File]::ReadAllText((Join-Path $context.State 'compose.env'))
    $composeTemplate=[IO.File]::ReadAllText((Join-Path $repositoryRoot 'compose.yaml'))
    Assert-True ($composeTemplate.Contains('TENANTS_JSON_FILE: /run/secrets/tenants.json') -and $composeTemplate.Contains('target: tenants.json')) 'Compose did not mount the protected registry.'
    Assert-True (-not $compose.Contains('TENANT_ID=') -and -not $compose.Contains('TENANTS_JSON=')) 'Compose environment duplicated the tenant registry.'
    Assert-True (-not $compose.Contains($clientSecret)) 'Client secret leaked into compose.env.'
    Assert-True (-not [IO.File]::ReadAllText((Join-Path $context.State 'settings.json')).Contains($clientSecret)) 'Client secret leaked into settings.json.'
    if (-not $IsWindows) {
        Assert-True ([int][IO.File]::GetUnixFileMode((Join-Path $context.State 'secrets/tenants.json')) -eq 384) 'Tenant registry permissions are not 0600.'
        Assert-True ([int][IO.File]::GetUnixFileMode((Join-Path $context.State 'secrets')) -eq 448) 'Secret directory permissions are not 0700.'
    }
    $script:Failure=''
    Invoke-LocalDeployment $context 'Deploy' 6>$null
    $secret=Join-Path $context.State 'secrets/postgres-app'
    $before=[IO.File]::ReadAllText($secret)
    Invoke-LocalDeployment $context 'Deploy' 6>$null
    Invoke-LocalDeployment $context 'Start' 6>$null
    Assert-True ($script:Prompts.Count -eq 4) 'Configured Deploy/Start prompted again.'
    Assert-True ([IO.File]::ReadAllText($secret) -ceq $before) 'Repeat deploy rotated credentials.'
    Assert-True ((Read-FixtureRegistry $context)[0].clientSecret -ceq $clientSecret) 'Repeat deploy changed the Entra secret.'
    Assert-True (($script:Calls -join "`n") -notlike "*$before*") 'Secret leaked to command arguments.'
    Assert-True (-not ($script:Calls -join "`n").Contains($clientSecret)) 'Entra secret leaked to command arguments.'
    Assert-True (-not ($script:Calls -join "`n").Contains('/secrets,target=/run/secrets,readonly')) 'Database operator received the entire tenant credential directory.'
    Assert-True (($script:Calls -join "`n").Contains('/secrets/postgres-admin,target=/run/secrets/postgres-admin,readonly')) 'Database operator lost its explicit administrator secret mount.'
    Assert-True (($script:Calls -join "`n").Contains($testRoot)) 'Paths containing spaces were not preserved.'
    Assert-True (-not (($script:Calls -join "`n") -match '\|-p\|fixture-project\|down\|--volumes')) 'Normal deployment reset the application volume.'
    Assert-Fails { Invoke-LocalDeployment $context 'Retain' } 'cleanup denied'
    Invoke-LocalDeployment $context 'Retain' -ConfirmCleanup 'fixture-project/agentcontrol' -DryRun 6>$null
    Assert-True (($script:Calls -join "`n") -match 'database.ts\|retain\|confirmed\|1000\|dry-run') 'Dry-run cleanup was not explicit and bounded.'
    $script:AuthConfigured=$false
    Assert-Fails { Invoke-LocalDeployment $context 'Start' } 'sign-in configuration is missing'
    Assert-True (Test-Path -LiteralPath (Join-Path $context.State 'control/maintenance')) 'Missing runtime identity did not close admissions.'
    $script:AuthConfigured=$true
    Invoke-LocalDeployment $context 'Start' 6>$null

    $defaultContext=New-LocalContext $testRoot $defaultProject
    $customerContext=New-LocalContext $testRoot 'newCustomer'
    $sameCustomer=New-LocalContext $testRoot 'NEWCUSTOMER'
    Assert-True ($customerContext.Project -ceq 'newcustomer' -and $customerContext.State -ceq $sameCustomer.State -and $customerContext.Volume -ceq 'newcustomer_data') 'Project names were not normalized consistently.'
    foreach ($invalidProject in @('../escape','ab','customer_name','-customer')) {
        Assert-Fails { New-LocalContext $testRoot $invalidProject } 'Project must'
    }
    $otherTenant='33333333-3333-3333-3333-333333333333'
    $otherClient='44444444-4444-4444-4444-444444444444'
    foreach ($target in @($defaultContext,$customerContext)) {
        $promptCount=$script:Prompts.Count
        foreach ($answer in @($otherTenant,$otherClient,'other-fixture-secret','fabrikam.com','14392')) { $script:Answers.Enqueue($answer) }
        Initialize-LocalState $target $false -Onboard 6>$null
        Initialize-LocalState $target $true -Onboard 6>$null
        Assert-True ($script:Prompts.Count -eq $promptCount+5) 'Default/named project onboarding or reuse failed.'
        Assert-True ((Read-FixtureRegistry $target)[0].tenantId -ceq $otherTenant) 'Project received the wrong identity.'
        $reloaded=New-LocalContext $testRoot $target.Project
        Assert-True ($reloaded.Port -eq 14392 -and $reloaded.Url -ceq 'http://localhost:14392') 'Project did not load its saved port.'
    }
    Assert-True ([IO.File]::ReadAllText((Join-Path $context.State 'settings.json')).Contains($tenant)) 'Another project changed the original identity.'
    Assert-True ([IO.File]::ReadAllText((Join-Path $customerContext.State 'secrets/postgres-app')) -cne $before) 'Projects shared generated database credentials.'

    $migrated=New-FixtureContext 'legacy-tenant-upgrade'
    Initialize-LocalState $migrated $false
    $legacySettings=Join-Path $migrated.State 'settings.json'
    [IO.File]::WriteAllText($legacySettings,(@{port=14391;publicUrl='https://legacy.example.com';tenantId=$tenant;clientId=$client;note='retained legacy settings'} | ConvertTo-Json))
    $legacySecret=Join-Path $migrated.State 'secrets/client-secret'
    [IO.File]::WriteAllText($legacySecret," $clientSecret`n")
    $legacySnapshot=Get-ConfigSnapshot $migrated
    $script:Volumes.Add($migrated.Volume) | Out-Null
    $promptCount=$script:Prompts.Count
    $callCount=$script:Calls.Count
    $script:Answers.Enqueue('Contoso.com,contoso.onmicrosoft.com')
    Initialize-LocalState $migrated $true -Onboard 6>$null
    Assert-True ($script:Prompts.Count -eq $promptCount+1 -and $script:Prompts[$promptCount].StartsWith('Accepted username domains')) 'Legacy upgrade prompted for something other than newly required domains.'
    Assert-True ($script:Calls.Count -eq $callCount) 'Tenant migration issued a container/database mutation.'
    Assert-ConfigUnchanged $migrated $legacySnapshot @('settings.json','compose.env')
    $migratedSettings=Read-LocalSettings $migrated.State
    $migratedProfiles=Read-FixtureRegistry $migrated
    Assert-True ($migratedProfiles.Count -eq 1 -and $migratedProfiles[0].tenantId -ceq $tenant -and $migratedProfiles[0].clientId -ceq $client -and $migratedProfiles[0].clientSecret -ceq $clientSecret) 'Migration lost the original identity or credential.'
    Assert-True (($migratedProfiles[0].domains -join ',') -ceq 'contoso.com,contoso.onmicrosoft.com') 'Migration did not save explicit normalized domains.'
    Assert-True ($migratedSettings.port -eq 14391 -and $migratedSettings.publicUrl -ceq 'https://legacy.example.com' -and $migratedSettings.note -ceq 'retained legacy settings') 'Migration lost port, public URL or unrelated saved settings.'
    $snapshot=Get-ConfigSnapshot $migrated
    Initialize-LocalState $migrated $true -Onboard 6>$null
    Assert-True ($script:Prompts.Count -eq $promptCount+1) 'Registry migration prompted more than once.'
    Assert-ConfigUnchanged $migrated $snapshot

    $secondSecret='second-tenant-hidden-credential'
    foreach ($answer in @('','','','','','y',$otherTenant,$otherClient,$secondSecret,'fabrikam.com','Fabrikam','','','')) { $script:Answers.Enqueue($answer) }
    $messages=Invoke-LocalDeployment $migrated 'EditConfig' 6>&1
    $added=Read-FixtureRegistry $migrated
    Assert-True ($added.Count -eq 2 -and $added[0].clientSecret -ceq $clientSecret -and $added[1].tenantId -ceq $otherTenant -and $added[1].displayName -ceq 'Fabrikam') 'Adding a tenant replaced or lost a saved tenant.'
    Assert-ConfigUnchanged $migrated $snapshot @('settings.json','secrets/tenants.json')
    Assert-True (-not ($messages -join "`n").Contains($secondSecret) -and -not ($script:Calls -join "`n").Contains($secondSecret)) 'Added tenant credential leaked to messages or command arguments.'
    foreach ($file in @('settings.json','compose.env')) {
        Assert-True (-not [IO.File]::ReadAllText((Join-Path $migrated.State $file)).Contains($secondSecret)) 'Tenant credential leaked to public configuration.'
    }
    $snapshot=Get-ConfigSnapshot $migrated
    $callCount=$script:Calls.Count
    foreach ($answer in @('','','','','','','','','','','','','')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $migrated 'EditConfig' 6>$null
    Assert-ConfigUnchanged $migrated $snapshot
    Assert-True ($script:Calls.Count -eq $callCount+3) 'No-op edit of multiple named tenants stopped the app.'
    foreach ($answer in @('','','','','','','','','CONTOSO.com','','','','')) { $script:Answers.Enqueue($answer) }
    Assert-Fails { Invoke-LocalDeployment $migrated 'EditConfig' 6>$null } 'duplicate accepted domain'
    Assert-ConfigUnchanged $migrated $snapshot
    foreach ($answer in @('','','','','','','','updated-second-secret','fabrikam.com,login.fabrikam.com','','','','')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $migrated 'EditConfig' 6>$null
    $updatedProfiles=Read-FixtureRegistry $migrated
    Assert-True ($updatedProfiles[0].clientSecret -ceq $clientSecret -and $updatedProfiles[1].clientSecret -ceq 'updated-second-secret' -and $updatedProfiles[1].domains.Count -eq 2) 'Editing the second tenant affected the wrong credential or domains.'
    Assert-True (Test-Path -LiteralPath (Join-Path $migrated.State 'control/reauthenticate')) 'Domain edits did not schedule reauthentication.'
    $snapshot=Get-ConfigSnapshot $migrated
    Invoke-LocalDeployment $migrated 'Deploy' -DbReset 3>$null 6>$null
    Assert-ConfigUnchanged $migrated $snapshot
    Assert-True ((Read-FixtureRegistry $migrated).Count -eq 2) 'Explicit database reset discarded tenant profiles.'

    $registryFile=Join-Path $migrated.State 'secrets/tenants.json'
    $registryText=[IO.File]::ReadAllText($registryFile)
    foreach ($invalid in @(
        '[]','{}',"[`"$secondSecret`"", '[{"tenantId":"invalid"}]',
        (ConvertTo-Json -InputObject @($updatedProfiles[0],$updatedProfiles[0]) -Depth 20)
    )) {
        [IO.File]::WriteAllText($registryFile,$invalid)
        try { Initialize-LocalState $migrated $true -Onboard; throw 'Expected registry rejection.' }
        catch { Assert-True ($_.Exception.Message -match 'Tenant registry|tenantId' -and -not $_.Exception.Message.Contains($secondSecret)) 'Malformed registry was accepted or leaked credentials in errors.' }
    }
    Remove-Item -LiteralPath $registryFile
    Assert-Fails { Initialize-LocalState $migrated $true -Onboard } 'registry is missing'
    [IO.File]::WriteAllText($registryFile,$registryText)
    Protect-LocalPath $registryFile

    $editContext=New-FixtureContext 'editable-project'
    foreach ($answer in @($tenant,$client,"  $clientSecret  ",'contoso.com')) { $script:Answers.Enqueue($answer) }
    Initialize-LocalState $editContext $false -Onboard 6>$null
    $script:Volumes.Add($editContext.Volume) | Out-Null
    $editSettings=Join-Path $editContext.State 'settings.json'
    $editSecret=Join-Path $editContext.State 'secrets/tenants.json'
    $savedEditSettings=Read-LocalSettings $editContext.State
    $savedEditSettings.note='preserve me'
    [IO.File]::WriteAllText($editSettings,($savedEditSettings | ConvertTo-Json -Depth 20))
    [IO.File]::WriteAllText($editSecret," `n$([IO.File]::ReadAllText($editSecret))`n")
    foreach ($relative in (Get-ConfigSnapshot $editContext).Keys) {
        [IO.File]::SetLastWriteTimeUtc((Join-Path $editContext.State $relative),[DateTime]::new(2001,1,1,0,0,0,[DateTimeKind]::Utc))
    }
    $snapshot=Get-ConfigSnapshot $editContext
    $callsBefore=$script:Calls.Count
    Add-EditAnswers @('','','','','')
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot
    Assert-True ($script:Calls.Count -eq $callsBefore+3) 'No-op edit stopped containers or made unnecessary Docker changes.'
    Add-EditAnswers @($tenant,$client,$clientSecret,'14391','')
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot

    Add-EditAnswers @('','','','14393','')
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot @('settings.json','compose.env')
    $edited=Get-Content -LiteralPath $editSettings -Raw | ConvertFrom-Json
    Assert-True ($edited.port -eq 14393 -and $edited.note -ceq 'preserve me' -and $edited.tenants[0].tenantId -ceq $tenant -and $edited.tenants[0].clientId -ceq $client) 'Port-only edit changed unrelated settings.'
    Assert-True ($editContext.Url -ceq 'http://localhost:14393' -and (New-LocalContext $testRoot 'editable-project').Port -eq 14393) 'Edited port was not applied to saved/new contexts.'
    Assert-True ($script:Calls[$script:Calls.Count-1] -match '\|stop\|--timeout\|130\|app$') 'Configuration changed before stopping/draining the app.'
    Assert-True (Test-Path -LiteralPath (Join-Path $editContext.State 'control/maintenance')) 'Edited project was not left in maintenance.'

    $snapshot=Get-ConfigSnapshot $editContext
    Add-EditAnswers @('','','replacement-fixture-secret','','')
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot @('secrets/tenants.json')
    Assert-True ((Read-FixtureRegistry $editContext)[0].clientSecret -ceq 'replacement-fixture-secret') 'Secret-only edit did not save the new secret.'
    $reauthenticate=Join-Path $editContext.State 'control/reauthenticate'
    Assert-True (-not (Test-Path -LiteralPath $reauthenticate)) 'Port/secret-only edits unnecessarily scheduled session deletion.'

    $snapshot=Get-ConfigSnapshot $editContext
    Add-EditAnswers @('',$otherClient,'','','')
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot @('settings.json','secrets/tenants.json')
    Assert-True ((Get-Content -LiteralPath $editSettings -Raw | ConvertFrom-Json).tenants[0].clientId -ceq $otherClient) 'Client-ID-only edit was not saved.'
    Assert-True (Test-Path -LiteralPath $reauthenticate) 'Changed application ID did not schedule reauthentication.'
    Assert-True (-not ($script:Prompts -join "`n").Contains('replacement-fixture-secret')) 'Edit wizard displayed the saved secret.'
    Assert-True (-not ($script:Calls -join "`n").Contains('replacement-fixture-secret')) 'Edited secret leaked to Docker arguments.'

    $snapshot=Get-ConfigSnapshot $editContext
    Add-EditAnswers @($otherTenant,'','','','')
    Assert-Fails { Invoke-LocalDeployment $editContext 'EditConfig' 6>$null } 'retained data'
    Assert-ConfigUnchanged $editContext $snapshot
    foreach ($answer in @('','',"first`nsecond")) { $script:Answers.Enqueue($answer) }
    Assert-Fails { Invoke-LocalDeployment $editContext 'EditConfig' 6>$null } 'Configuration requires'
    Assert-ConfigUnchanged $editContext $snapshot
    Add-EditAnswers @('','','unsaved-secret','14394','')
    $script:Failure='\|stop\|--timeout\|130\|app$'
    Assert-Fails { Invoke-LocalDeployment $editContext 'EditConfig' 6>$null } 'Simulated'
    $script:Failure=''
    Assert-ConfigUnchanged $editContext $snapshot

    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $listener.Start()
    try {
        Add-EditAnswers @('','','',"$($listener.LocalEndpoint.Port)",'')
        Assert-Fails { Invoke-LocalDeployment $editContext 'EditConfig' 6>$null } 'occupied'
        Assert-ConfigUnchanged $editContext $snapshot
    } finally { $listener.Stop() }
    $script:Failure='DELETE FROM public\.sessions;'
    Assert-Fails { Invoke-LocalDeployment $editContext 'Deploy' 6>$null } 'Simulated'
    Assert-True ((Test-Path -LiteralPath $reauthenticate) -and (Test-Path -LiteralPath (Join-Path $editContext.State 'control/maintenance'))) 'Session-clear failure did not preserve pending reauthentication and maintenance.'
    $script:Failure=''
    Invoke-LocalDeployment $editContext 'Deploy' 6>$null
    Assert-True (-not (Test-Path -LiteralPath $reauthenticate)) 'Successful startup did not complete reauthentication.'
    Assert-ConfigUnchanged $editContext $snapshot
    $script:Answers.Enqueue('')
    Assert-True ((Read-LocalPort) -eq 3001) 'Wizard default port must be 3001.'

    $tunnelUrl='https://fixture-3002.devtunnels.ms'
    $snapshot=Get-ConfigSnapshot $editContext
    $callsBefore=$script:Calls.Count
    $invalidUrls=@('http://example.com','https://example.com/','https://example.com/path','https://example.com?query=1','https://example.com#fragment',
        'https://user:password@example.com','https://EXAMPLE.com','https://example.com:443','https://example.com:65536',"https://example.com`nTRUST_PROXY=0",
        'https://example.com/$VALUE','not-a-url','https://example.1','https://example.0xff','https://127.1','https://2130706433')
    foreach ($url in $invalidUrls) { Assert-True (-not (Test-LocalPublicUrl $url)) "Invalid public origin accepted: $url" }
    foreach ($url in @($tunnelUrl,'https://test--tunnel.devtunnels.ms','https://example.com:8443','https://127.0.0.1')) {
        Assert-True (Test-LocalPublicUrl $url) "Valid public origin rejected: $url"
    }
    foreach ($answer in (@('','','','','','','') + $invalidUrls + @(" $tunnelUrl "))) { $script:Answers.Enqueue($answer) }
    $messages=Invoke-LocalDeployment $editContext 'EditConfig' 3>$null 6>&1
    Assert-ConfigUnchanged $editContext $snapshot @('settings.json','compose.env')
    Assert-True ($script:Calls.Count -eq $callsBefore+4 -and $script:Calls[$script:Calls.Count-1] -match '\|stop\|--timeout\|130\|app$') 'Public-URL edit did not stop/drain the app.'
    Assert-True (-not (Test-Path -LiteralPath $reauthenticate)) 'Public-URL edit unnecessarily scheduled session deletion.'
    Assert-True (($messages -join "`n").Contains("Register $tunnelUrl/api/auth/callback")) 'Wizard guidance did not use the public callback.'
    Assert-True (($messages -join "`n").Contains('devtunnel port update YOUR_TUNNEL_ID -p 14393 --host-header unchanged --origin-header unchanged')) 'Wizard omitted persistent origin-preserving settings for the existing tunnel port.'
    Assert-True (($messages -join "`n").Contains('devtunnel host YOUR_TUNNEL_ID --host-header unchanged --origin-header unchanged')) 'Wizard omitted the tunnel host command.'
    $reloaded=New-LocalContext $testRoot 'editable-project'
    Assert-True ($reloaded.PublicUrl -ceq $tunnelUrl -and $reloaded.Url -ceq 'http://localhost:14393' -and $reloaded.Port -eq 14393) 'Public origin changed the listener or local health URL.'
    $compose=[IO.File]::ReadAllText((Join-Path $editContext.State 'compose.env'))
    foreach ($expected in @("FRONTEND_ORIGIN=$tunnelUrl","REDIRECT_URI=$tunnelUrl/api/auth/callback",'TRUST_PROXY=1','APP_PORT=14393')) {
        Assert-True ($compose.Contains($expected)) "Public-URL configuration omitted $expected."
    }
    Assert-True ((Read-LocalSettings $editContext.State).publicUrl -ceq $tunnelUrl) 'Public URL was not persisted.'
    Assert-True ((New-LocalContext $testRoot 'fixture-project').PublicUrl -ceq 'http://localhost:14391') 'Public URL leaked into another project.'

    $snapshot=Get-ConfigSnapshot $editContext
    $callsBefore=$script:Calls.Count
    Add-EditAnswers @('','','','','')
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot
    Assert-True ($script:Calls.Count -eq $callsBefore+3) 'No-op public URL edit stopped the app.'
    Add-EditAnswers @('','','','','https://replacement.devtunnels.ms')
    $script:Failure='\|stop\|--timeout\|130\|app$'
    Assert-Fails { Invoke-LocalDeployment $editContext 'EditConfig' 6>$null } 'Simulated'
    $script:Failure=''
    Assert-ConfigUnchanged $editContext $snapshot
    $promptCount=$script:Prompts.Count
    $messages=Invoke-LocalDeployment $reloaded 'Deploy' 6>&1
    Assert-True ($script:Prompts.Count -eq $promptCount) 'Saved public URL prompted again on start.'
    Assert-ConfigUnchanged $editContext $snapshot
    Assert-True (($messages -join "`n").Contains("Open $tunnelUrl to sign in")) 'Startup did not display the public sign-in URL.'
    Assert-True (($messages -join "`n").Contains('devtunnel port update YOUR_TUNNEL_ID -p 14393 --host-header unchanged --origin-header unchanged')) 'Startup omitted persistent origin-preserving settings for the saved tunnel port.'
    Assert-True (($messages -join "`n").Contains('devtunnel host YOUR_TUNNEL_ID --host-header unchanged --origin-header unchanged')) 'Startup omitted the tunnel host command.'

    Add-EditAnswers @('','','','14394','')
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-True ($editContext.PublicUrl -ceq $tunnelUrl -and $editContext.Url -ceq 'http://localhost:14394') 'Port edit altered the explicit public origin.'
    Add-EditAnswers @('','','','','local')
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    $reloaded=New-LocalContext $testRoot 'editable-project'
    Assert-True ($reloaded.PublicUrl -ceq 'http://localhost:14394' -and (Read-LocalSettings $editContext.State).publicUrl -ceq '') 'Reset did not restore automatic localhost origin.'
    $compose=[IO.File]::ReadAllText((Join-Path $editContext.State 'compose.env'))
    foreach ($expected in @('FRONTEND_ORIGIN=http://localhost:14394','REDIRECT_URI=http://localhost:14394/api/auth/callback','TRUST_PROXY=0')) {
        Assert-True ($compose.Contains($expected)) "Reset configuration omitted $expected."
    }
    $snapshot=Get-ConfigSnapshot $editContext
    Add-EditAnswers @('','','','','')
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot

    $invalidPublic=New-FixtureContext 'invalid-public-url'
    foreach ($value in @($null,42,@{},'http://remote.example','https://remote.example/path')) {
        [IO.File]::WriteAllText((Join-Path $invalidPublic.State 'settings.json'),(@{port=14391;publicUrl=$value} | ConvertTo-Json))
        Assert-Fails { New-LocalContext $testRoot 'invalid-public-url' } 'Saved publicUrl'
    }

    $unstarted=New-LocalContext $testRoot 'unstarted-project'
    Add-EditAnswers @($tenant,$client,$clientSecret,'14394',$tunnelUrl) -Domains 'contoso.com'
    Invoke-LocalDeployment $unstarted 'EditConfig' 6>$null
    Add-EditAnswers @($otherTenant,'','','','')
    Invoke-LocalDeployment $unstarted 'EditConfig' 6>$null
    Assert-True ((Get-Content -LiteralPath (Join-Path $unstarted.State 'settings.json') -Raw | ConvertFrom-Json).tenants[0].tenantId -ceq $otherTenant) 'Tenant correction before first deployment was rejected.'
    Assert-True (-not $script:Volumes.Contains($unstarted.Volume)) 'Edit-config provisioned a database.'
    Assert-True ((New-LocalContext $testRoot 'unstarted-project').PublicUrl -ceq $tunnelUrl) 'New project did not retain its public URL.'

    foreach ($variant in @('empty','null','absent','whitespace')) {
        $portOnly=New-FixtureContext "port-only-$variant"
        Initialize-LocalState $portOnly $false
        $script:Volumes.Add($portOnly.Volume) | Out-Null
        $settingsPath=Join-Path $portOnly.State 'settings.json'
        $secretPath=Join-Path $portOnly.State 'secrets/client-secret'
        $original=@{port=14391;tenantId='';clientId='';note='keep this'}
        if ($variant -eq 'null') { $original.tenantId=$null; $original.clientId=$null }
        if ($variant -eq 'absent') { $original.Remove('tenantId'); $original.Remove('clientId'); Remove-Item -LiteralPath $secretPath }
        if ($variant -eq 'whitespace') {
            $original.tenantId='  '; $original.clientId=' '
            [IO.File]::WriteAllText($secretPath," `n ")
        }
        [IO.File]::WriteAllText($settingsPath,($original | ConvertTo-Json))
        $unchanged=@{}
        foreach ($relative in @('secrets/client-secret','secrets/postgres-admin','secrets/postgres-app','secrets/session')) {
            $path=Join-Path $portOnly.State $relative
            if (Test-Path -LiteralPath $path) {
                $unchanged[$relative]=@{hash=(Get-FileHash -LiteralPath $path).Hash;modified=(Get-Item -LiteralPath $path).LastWriteTimeUtc.Ticks}
            }
        }
        Add-EditAnswers @('','','','14395','')
        $messages=Invoke-LocalDeployment $portOnly 'EditConfig' 6>&1
        $updated=Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -AsHashtable
        Assert-True ($updated.port -eq 14395 -and $updated.note -ceq $original.note) 'Port-only edit did not preserve unrelated settings.'
        foreach ($key in @('tenantId','clientId')) {
            Assert-True ($updated.Contains($key) -eq $original.ContainsKey($key) -and $updated[$key] -ceq $original[$key]) "Port-only edit changed skipped $key in $variant configuration."
        }
        foreach ($relative in $unchanged.Keys) {
            $path=Join-Path $portOnly.State $relative
            Assert-True ((Get-FileHash -LiteralPath $path).Hash -ceq $unchanged[$relative].hash -and (Get-Item -LiteralPath $path).LastWriteTimeUtc.Ticks -eq $unchanged[$relative].modified) "Port-only edit rewrote $relative."
        }
        if ($variant -eq 'absent') { Assert-True (-not (Test-Path -LiteralPath $secretPath)) 'Skipping an absent secret created a secret file.' }
        Assert-True (($messages -join "`n").Contains('Identity configuration is incomplete')) 'Partial configuration was incorrectly reported as complete.'
        $settingsBefore=[IO.File]::ReadAllText($settingsPath)
        $modified=(Get-Item -LiteralPath $settingsPath).LastWriteTimeUtc.Ticks
        Add-EditAnswers @('','','','','')
        Invoke-LocalDeployment $portOnly 'EditConfig' 6>$null
        Assert-True ([IO.File]::ReadAllText($settingsPath) -ceq $settingsBefore -and (Get-Item -LiteralPath $settingsPath).LastWriteTimeUtc.Ticks -eq $modified) 'No-op edit rewrote incomplete settings.'
        $script:Answers.Enqueue('')
        Assert-Fails { Invoke-LocalDeployment $portOnly 'Deploy' 6>$null } 'Configuration requires'
    }

    $newPortOnly=New-LocalContext $testRoot 'new-port-only'
    Add-EditAnswers @('','','','14395','')
    Invoke-LocalDeployment $newPortOnly 'EditConfig' 6>$null
    $newSettings=Get-Content -LiteralPath (Join-Path $newPortOnly.State 'settings.json') -Raw | ConvertFrom-Json -AsHashtable
    Assert-True ($newSettings.Count -eq 1 -and $newSettings.port -eq 14395) 'New port-only configuration saved unwanted identity fields.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $newPortOnly.State 'secrets/client-secret'))) 'New port-only configuration created an unset client secret.'
    foreach ($answer in @($tenant,$client,$clientSecret,'contoso.com')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $newPortOnly 'Deploy' 6>$null
    Assert-True ($newPortOnly.Port -eq 14395 -and (Read-FixtureRegistry $newPortOnly)[0].clientSecret -ceq $clientSecret) 'Start did not complete identity setup while retaining the edited port.'

    $partialDomains=New-LocalContext $testRoot 'partial-domain-settings'
    Add-EditAnswers @('','','','14395','') -Domains 'contoso.com' -DisplayName 'Contoso'
    Invoke-LocalDeployment $partialDomains 'EditConfig' 6>$null
    $pendingSettings=Read-LocalSettings $partialDomains.State
    Assert-True (($pendingSettings.tenantDomains -join ',') -ceq 'contoso.com' -and $pendingSettings.tenantDisplayName -ceq 'Contoso') 'Incomplete identity editing discarded entered domains or display name.'
    $promptCount=$script:Prompts.Count
    foreach ($answer in @($tenant,$client,$clientSecret)) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $partialDomains 'Deploy' 6>$null
    Assert-True ($script:Prompts.Count -eq $promptCount+3 -and (Read-FixtureRegistry $partialDomains)[0].displayName -ceq 'Contoso') 'Completing a partial profile discarded or reprompted saved domain settings.'
    Assert-True (-not (Get-ChildItem -LiteralPath $partialDomains.State -Recurse -File -Filter '*.pending-*')) 'Atomic configuration writes left pending credential files.'
    Add-EditAnswers @('','','','','') -DisplayName '2026-09-26T00:00:00.000Z'
    Invoke-LocalDeployment $partialDomains 'EditConfig' 6>$null
    $snapshot=Get-ConfigSnapshot $partialDomains
    $callCount=$script:Calls.Count
    Add-EditAnswers @('','','','','')
    Invoke-LocalDeployment $partialDomains 'EditConfig' 6>$null
    Assert-ConfigUnchanged $partialDomains $snapshot
    Assert-True ($script:Calls.Count -eq $callCount+3 -and (Read-FixtureRegistry $partialDomains)[0].displayName -ceq '2026-09-26T00:00:00.000Z') 'Reloading a date-like display name changed configuration or stopped the app.'

    $shellValues=@{}
    try {
        foreach ($name in @('LOCAL_STATE_DIR','LOCAL_TEST_IMAGE','APP_PORT','APP_UID','APP_GID','APP_IMAGE','TENANTS_JSON','TENANTS_JSON_FILE','TENANT_ID','CLIENT_ID','CLIENT_SECRET','CLIENT_SECRET_FILE','TENANT_DOMAINS','TENANT_DISPLAY_NAME','FRONTEND_ORIGIN','REDIRECT_URI','TRUST_PROXY')) {
            $shellValues[$name]=[Environment]::GetEnvironmentVariable($name)
        }
        $script:CheckProjectEnvironment=$true
        foreach ($value in @('another-project','',$null)) {
            $expectedValues=@{}
            foreach ($name in $shellValues.Keys) {
                if ($null -eq $value) {
                    if (Test-Path "Env:$name") { Remove-Item "Env:$name" }
                } else {
                    Set-Item "Env:$name" $value
                }
                $expectedValues[$name]=[Environment]::GetEnvironmentVariable($name)
            }
            foreach ($capture in @($false,$true)) {
                $script:Failure=''
                Invoke-DockerCommand ($context.Compose + @('config','--quiet')) -Capture:$capture | Out-Null
                foreach ($name in $shellValues.Keys) { Assert-True ([Environment]::GetEnvironmentVariable($name) -ceq $expectedValues[$name]) 'Shell environment was not restored after Docker.' }
                $script:Failure='\|config\|--quiet$'
                Assert-Fails { Invoke-DockerCommand ($context.Compose + @('config','--quiet')) -Capture:$capture } 'Simulated'
                foreach ($name in $shellValues.Keys) { Assert-True ([Environment]::GetEnvironmentVariable($name) -ceq $expectedValues[$name]) 'Shell environment was not restored after Docker failure.' }
            }
        }
    } finally {
        $script:Failure=''
        $script:CheckProjectEnvironment=$false
        foreach ($name in $shellValues.Keys) {
            if ($null -eq $shellValues[$name]) {
                if (Test-Path "Env:$name") { Remove-Item "Env:$name" }
            } else {
                Set-Item "Env:$name" $shellValues[$name]
            }
        }
    }

    foreach ($missing in @('tenant','client','secret-empty','secret-absent','secret-whitespace','port','all')) {
        $partial=New-FixtureContext "partial-$missing"
        Initialize-LocalState $partial $false
        $partialSettings=Join-Path $partial.State 'settings.json'
        $partialSecret=Join-Path $partial.State 'secrets/client-secret'
        $savedTenant=if ($missing -in @('tenant','all')) { '' } else { $tenant }
        $savedClient=if ($missing -in @('client','all')) { '' } else { $client }
        $partialValues=@{port=14391;tenantId=$savedTenant;clientId=$savedClient}
        if ($missing -in @('port','all')) { $partialValues.Remove('port') }
        [IO.File]::WriteAllText($partialSettings,($partialValues | ConvertTo-Json))
        if ($missing -in @('tenant','client','port')) { [IO.File]::WriteAllText($partialSecret,$clientSecret) }
        if ($missing -eq 'secret-whitespace') { [IO.File]::WriteAllText($partialSecret," `r`n ") }
        if ($missing -eq 'secret-absent') { Remove-Item -LiteralPath $partialSecret }
        $hashes=@{}
        foreach ($name in @('postgres-admin','postgres-app','session')) { $hashes[$name]=(Get-FileHash -LiteralPath (Join-Path $partial.State "secrets/$name")).Hash }
        $promptCount=$script:Prompts.Count
        if (-not $savedTenant) { $script:Answers.Enqueue($tenant) }
        if (-not $savedClient) { $script:Answers.Enqueue($client) }
        if ($missing -notin @('tenant','client','port')) { $script:Answers.Enqueue($clientSecret) }
        $script:Answers.Enqueue('contoso.com')
        if ($missing -in @('port','all')) { $script:Answers.Enqueue('14391') }
        Initialize-LocalState $partial $true -Onboard 6>$null
        $expected=if ($missing -eq 'all') { 5 } else { 2 }
        Assert-True ($script:Prompts.Count -eq $promptCount+$expected) "Partial project $missing prompted for already saved values."
        $updated=Get-Content -LiteralPath $partialSettings -Raw | ConvertFrom-Json
        Assert-True ($updated.tenants[0].tenantId -ceq $tenant -and $updated.tenants[0].clientId -ceq $client -and (Read-FixtureRegistry $partial)[0].clientSecret -ceq $clientSecret) "Partial project $missing was not completed."
        foreach ($name in $hashes.Keys) {
            Assert-True ((Get-FileHash -LiteralPath (Join-Path $partial.State "secrets/$name")).Hash -ceq $hashes[$name]) "Onboarding rotated $name."
        }
    }

    $invalidContext=New-LocalContext $testRoot 'invalid-input'
    foreach ($answer in (@('not-a-guid'," $tenant ",$client,$clientSecret) + $invalidDomainInputs + @('*.contoso.com','contoso.com,CONTOSO.com','contoso.com','abc','1023','65536','14391'))) { $script:Answers.Enqueue($answer) }
    Initialize-LocalState $invalidContext $false -Onboard 3>$null 6>$null
    Assert-True ([IO.File]::ReadAllText((Join-Path $invalidContext.State 'settings.json')).Contains($tenant)) 'Invalid GUID input was not retried and trimmed.'
    foreach ($invalidInput in @('blank-tenant','blank-client','blank-secret','multiline-secret')) {
        $cancelled=New-LocalContext $testRoot $invalidInput
        if ($invalidInput -ne 'blank-tenant') { $script:Answers.Enqueue($tenant) }
        if ($invalidInput -notin @('blank-tenant','blank-client')) { $script:Answers.Enqueue($client) }
        $script:Answers.Enqueue($(if ($invalidInput -eq 'multiline-secret') { "first`nsecond" } else { ' ' }))
        Assert-Fails { Initialize-LocalState $cancelled $false -Onboard 6>$null } 'Configuration requires'
        Assert-True (-not (Test-Path -LiteralPath $cancelled.State)) 'Incomplete onboarding persisted partial state.'
    }
    $invalidSettings=Join-Path $invalidContext.State 'settings.json'
    [IO.File]::WriteAllText($invalidSettings,(@{port=3001;tenantId='corrupt';clientId=$client} | ConvertTo-Json))
    Assert-Fails { Initialize-LocalState $invalidContext $true -Onboard } 'Saved tenant and client identifiers'
    foreach ($invalidPort in @('3001',1023,65536,3001.5,$null)) {
        [IO.File]::WriteAllText($invalidSettings,(@{port=$invalidPort;tenantId=$tenant;clientId=$client} | ConvertTo-Json))
        Assert-Fails { New-LocalContext $testRoot 'invalid-input' } 'Saved project port'
    }
    [IO.File]::WriteAllText($invalidSettings,'[]')
    Assert-Fails { New-LocalContext $testRoot 'invalid-input' } 'JSON object'

    $maintenanceContext=New-FixtureContext 'maintenance-project'
    Initialize-LocalState $maintenanceContext $false
    $script:Volumes.Add($maintenanceContext.Volume) | Out-Null
    $promptCount=$script:Prompts.Count
    Invoke-LocalDeployment $maintenanceContext 'Stop' 6>$null
    Invoke-LocalDeployment $maintenanceContext 'Test' 6>$null
    Invoke-LocalDeployment $maintenanceContext 'Backup' 6>$null
    Assert-True ($script:Prompts.Count -eq $promptCount) 'Maintenance actions unexpectedly required onboarding.'
    foreach ($answer in @($tenant,$client,$clientSecret,'contoso.com')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $maintenanceContext 'Start' 6>$null
    Assert-True ($script:Prompts.Count -eq $promptCount+4) 'Start did not onboard an existing unconfigured project.'
    Assert-True ($script:Answers.Count -eq 0) 'Not all expected wizard answers were consumed.'

    $entryRoot=Join-Path $testRoot 'entrypoint'
    [IO.Directory]::CreateDirectory((Join-Path $entryRoot 'scripts')) | Out-Null
    Copy-Item -LiteralPath $entry.Source -Destination (Join-Path $entryRoot 'deploy-local.ps1')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'local-deployment.ps1') -Destination (Join-Path $entryRoot 'scripts/local-deployment.ps1')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'tenant-deployment.ps1') -Destination (Join-Path $entryRoot 'scripts/tenant-deployment.ps1')
    $entryPath=Join-Path $entryRoot 'deploy-local.ps1'
    $entryState=Join-Path $entryRoot '.local'
    $retainedContext=$context
    foreach ($projectArguments in @(@{},@{Project='newCustomer'})) {
        $promptCount=$script:Prompts.Count
        foreach ($answer in @($tenant,$client,$clientSecret,'contoso.com','14391')) { $script:Answers.Enqueue($answer) }
        $script:WizardTrace.Clear()
        $messages=. $entryPath @projectArguments 6>&1 | ForEach-Object { $script:WizardTrace.Add([string]$_); $_ }
        $trace=$script:WizardTrace -join "`n"
        Assert-True ($trace.IndexOf('Registered app permissions and setup') -ge 0 -and $trace.IndexOf('Registered app permissions and setup') -lt $trace.IndexOf('PROMPT:')) 'Registration guidance must appear before the first wizard prompt.'
        Assert-True ($script:Prompts.Count -eq $promptCount+5) 'Public entry point did not onboard the selected project.'
        Assert-True (-not ($messages -join "`n").Contains($clientSecret)) 'Public entry point printed the client secret.'
        $messages=. $entryPath start @projectArguments 6>&1
        Assert-True (-not ($messages -join "`n").Contains('Registered app permissions and setup')) 'Configured start unnecessarily repeated onboarding guidance.'
        Assert-True ($script:Prompts.Count -eq $promptCount+5) 'Public entry point did not reuse saved onboarding values.'
        $projectName=if ($projectArguments.Project) { 'newcustomer' } else { 'agent-control' }
        Assert-True (Test-Path -LiteralPath (Join-Path $entryState "$projectName/settings.json")) 'Entry point did not save the selected project folder.'
        $messages=. $entryPath stop @projectArguments 6>&1
        Assert-True (-not ($messages -join "`n").Contains('Registered app permissions and setup')) 'Stop unexpectedly displayed onboarding guidance.'
        Assert-True (Test-Path -LiteralPath (Join-Path $entryState "$projectName/control/maintenance")) 'Explicit stop did not close admissions.'
        Add-EditAnswers @('','','','',$tunnelUrl)
        $messages=. $entryPath -Action edit-config @projectArguments 6>&1
        Assert-True (($messages -join "`n").Contains($guidance)) 'Edit-config did not display the complete registration guidance.'
        Assert-True (-not ($messages -join "`n").Contains($clientSecret)) 'Edit-config displayed the saved client secret.'
        Assert-True ($script:Prompts.Count -eq $promptCount+13) 'Explicit edit-config did not prompt for all settings.'
        $entrySettings=Read-LocalSettings (Join-Path $entryState $projectName)
        Assert-True ($entrySettings.publicUrl -ceq $tunnelUrl -and $entrySettings.port -eq 14391) '-Action edit-config did not persist the public URL independently of the port.'
        $messages=. $entryPath -Action start @projectArguments 6>&1
        Assert-True ($script:Prompts.Count -eq $promptCount+13 -and ($messages -join "`n").Contains("Open $tunnelUrl to sign in")) '-Action start did not reuse the saved public URL.'
        $savedEntry=Get-ConfigSnapshot $context
        $callOffset=$script:Calls.Count
        $messages=if ($projectArguments.Project) { . $entryPath start @projectArguments -db-reset 6>&1 }
            else { . $entryPath @projectArguments -DbReset 6>&1 }
        $resetCalls=@($script:Calls | Select-Object -Skip $callOffset)
        Assert-True (@($resetCalls | Where-Object { $_ -match 'database\.ts\|reset\|agentcontrol$' }).Count -eq 1) 'Public DbReset did not reset the selected application database exactly once.'
        Assert-True (@($resetCalls | Where-Object { $_ -match 'database\.ts\|reset\|agentcontrol$' -and $_.Contains("|--network|${projectName}_default|") }).Count -eq 1) 'Public DbReset used another project network.'
        Assert-True ($script:Prompts.Count -eq $promptCount+13) 'DbReset prompted for existing configuration again.'
        Assert-ConfigUnchanged $context $savedEntry
    }
    $context=$retainedContext
    Assert-True ($script:Answers.Count -eq 0) 'Entry-point wizard did not consume the expected answers.'
    Assert-Fails { . $entryPath -Port 3001 } 'parameter.*Port'
    Assert-Fails { . $entryPath -StateRoot $testRoot } 'parameter.*StateRoot'
    Assert-Fails { . $entryPath -Action Reset } 'ValidateSet|validation|not belong'
    foreach ($invalidResetCommand in @('stop','edit-config')) {
        $callCount=$script:Calls.Count
        Assert-Fails { . $entryPath $invalidResetCommand -DbReset } 'DbReset.*only with start'
        Assert-True ($script:Calls.Count -eq $callCount) 'Invalid public DbReset combination invoked Docker.'
    }
    $context=$retainedContext
    $script:Failure='database\.ts\|migrate$'
    try {
        Assert-Fails { . $entryPath start -Project newcustomer -DbReset 6>$null 3>$null } 'explicit database reset began; data may already have been deleted'
    } finally { $script:Failure='' }
    $context=$retainedContext

    $qualification=New-FixtureContext 'preflight-retained'
    foreach ($answer in @($tenant,$client,$clientSecret,'contoso.com')) { $script:Answers.Enqueue($answer) }
    Initialize-LocalState $qualification $false -Onboard 6>$null
    $script:Volumes.Add($qualification.Volume) | Out-Null
    $snapshot=Get-ConfigSnapshot $qualification
    $script:MonitoredMarker=Join-Path $qualification.State 'control/maintenance'
    $pendingReauthentication=Join-Path $qualification.State 'control/reauthenticate'
    [IO.File]::WriteAllText($pendingReauthentication,'pending-before-software-checks')
    try {
        foreach ($hadMaintenance in @($false,$true)) {
            foreach ($failurePattern in @('^build\|--target\|operator\|','\|--wait-timeout\|90\|test-postgres$','backend/scripts/test-all\.ts$','\|down\|--volumes','^build\|--target\|runtime\|')) {
                if ($hadMaintenance) { [IO.File]::WriteAllText($script:MonitoredMarker,'prior-maintenance-state') }
                elseif (Test-Path -LiteralPath $script:MonitoredMarker) { Remove-Item -LiteralPath $script:MonitoredMarker }
                $callOffset=$script:Calls.Count
                $fixtureOffset=$script:FixtureCalls.Count
                $messages=[Collections.Generic.List[string]]::new()
                $script:Failure=$failurePattern
                Assert-Fails { Invoke-LocalDeployment $qualification 'Deploy' 6>&1 | ForEach-Object { $messages.Add([string]$_) } } 'Simulated'
                $script:Failure=''
                Assert-ConfigUnchanged $qualification $snapshot
                Assert-True ((Test-Path -LiteralPath $script:MonitoredMarker) -eq $hadMaintenance) 'Preflight failure changed maintenance admissions.'
                if ($hadMaintenance) {
                    Assert-True ([IO.File]::ReadAllText($script:MonitoredMarker) -ceq 'prior-maintenance-state') 'Preflight failure overwrote the existing maintenance marker.'
                }
                Assert-True ([IO.File]::ReadAllText($pendingReauthentication) -ceq 'pending-before-software-checks') 'Preflight failure consumed pending reauthentication.'
                $deploymentCalls=@($script:Calls | Select-Object -Skip $callOffset)
                Assert-True (-not (($deploymentCalls -join "`n") -match '\|stop\||backend/scripts/database\.ts|\|--wait-timeout\|90\|(?:app|postgres)$|DELETE FROM')) 'Preflight failure stopped the app or touched its database.'
                Assert-True (-not (($messages -join "`n") -match 'Deployment verification summary|\[LOCAL READINESS\] PASSED')) 'Preflight failure announced deployment readiness.'
                $preflightCalls=@($script:FixtureCalls | Select-Object -Skip $fixtureOffset)
                $expectedCleanup=if ($failurePattern -match 'operator') { 0 } else { 1 }
                Assert-True (@($preflightCalls | Where-Object { $_.command -match '\|down\|--volumes\|--remove-orphans$' }).Count -eq $expectedCleanup) "Fixture cleanup count differed from $expectedCleanup after $failurePattern."
                foreach ($call in $preflightCalls) {
                    Assert-True ($call.project -cne $qualification.Project -and $call.command.Contains('|--profile|test-db|')) 'Fixture commands targeted the application project.'
                    Assert-True (-not $call.environment.Contains($qualification.State)) 'Fixture environment mounted the retained application state.'
                    foreach ($value in @($tenant,$client,$clientSecret,[IO.File]::ReadAllText((Join-Path $qualification.State 'secrets/postgres-admin')))) {
                        Assert-True (-not $call.environment.Contains($value)) 'Fixture environment contained an application identity or secret.'
                    }
                    Assert-True ($call.environment.Contains("LOCAL_TEST_IMAGE=$($qualification.Operator)")) 'Fixture run did not select the qualified operator image.'
                    Assert-True (-not (Test-Path -LiteralPath $call.file)) 'Owned fixture configuration survived cleanup.'
                }
            }
        }
        foreach ($hadMaintenance in @($false,$true)) {
            foreach ($failurePattern in @('\|--wait-timeout\|90\|postgres$','backend/scripts/database\.ts\|preflight$')) {
                if ($hadMaintenance) { [IO.File]::WriteAllText($script:MonitoredMarker,'prior-maintenance-state') }
                elseif (Test-Path -LiteralPath $script:MonitoredMarker) { Remove-Item -LiteralPath $script:MonitoredMarker }
                $callOffset=$script:Calls.Count
                $script:Failure=$failurePattern
                Assert-Fails { Invoke-LocalDeployment $qualification 'Deploy' 6>$null } 'Database preflight failed.*Simulated'
                $script:Failure=''
                Assert-ConfigUnchanged $qualification $snapshot
                Assert-True ((Test-Path -LiteralPath $script:MonitoredMarker) -eq $hadMaintenance) 'Database preflight failure changed maintenance admissions.'
                if ($hadMaintenance) {
                    Assert-True ([IO.File]::ReadAllText($script:MonitoredMarker) -ceq 'prior-maintenance-state') 'Database preflight failure overwrote existing maintenance.'
                }
                Assert-True ([IO.File]::ReadAllText($pendingReauthentication) -ceq 'pending-before-software-checks') 'Database preflight consumed pending reauthentication.'
                $deploymentCalls=@($script:Calls | Select-Object -Skip $callOffset)
                Assert-True (-not (($deploymentCalls -join "`n") -match '\|stop\||backend/scripts/database\.ts\|migrate$|\|--wait-timeout\|90\|app$')) 'Database preflight failure stopped, migrated or started the application.'
                Assert-True (-not (($deploymentCalls -join "`n").Contains("|-p|$($qualification.Project)|down"))) 'Database preflight reset the application project.'
            }
        }
        Remove-Item -LiteralPath $script:MonitoredMarker
        $callOffset=$script:Calls.Count
        $script:MarkerCalls.Clear()
        $messages=Invoke-LocalDeployment $qualification 'Deploy' 6>&1
        $deploymentCalls=@($script:Calls | Select-Object -Skip $callOffset)
        $tests=Get-UniqueCallIndex $deploymentCalls 'backend/scripts/test-all\.ts$'
        $cleanup=Get-UniqueCallIndex $deploymentCalls '\|down\|--volumes\|--remove-orphans$'
        $runtime=Get-UniqueCallIndex $deploymentCalls '^build\|--target\|runtime\|'
        $databasePreflight=Get-UniqueCallIndex $deploymentCalls 'backend/scripts/database\.ts\|preflight$'
        $stop=Get-UniqueCallIndex $deploymentCalls '\|stop\|--timeout\|130\|app$'
        $migration=Get-UniqueCallIndex $deploymentCalls 'backend/scripts/database\.ts\|migrate$'
        $start=Get-UniqueCallIndex $deploymentCalls '\|--wait-timeout\|90\|app$'
        Assert-True ($tests -lt $cleanup -and $cleanup -lt $runtime -and $runtime -lt $stop -and $stop -lt $migration -and $migration -lt $start) 'Software checks and cleanup must finish before runtime build, shutdown, migration and app start.'
        Assert-True ($runtime -lt $databasePreflight -and $databasePreflight -lt $stop) 'Database compatibility must be checked before stopping the app.'
        Assert-True (@($script:MarkerCalls | Where-Object { $_.command -match 'backend/scripts/database\.ts\|preflight$' -and $_.maintenance }).Count -eq 0) 'Database preflight entered maintenance.'
        Assert-True (@($script:MarkerCalls | Where-Object { $_.command -match 'backend/scripts/test-all\.ts$|^build\|' -and $_.maintenance }).Count -eq 0) 'Maintenance began before software/build qualification finished.'
        Assert-True (@($script:MarkerCalls | Where-Object { $_.command -match '\|stop\|--timeout\|130\|app$' -and $_.maintenance }).Count -eq 1) 'Deployment did not close admissions before stopping the app.'
        foreach ($expected in @('[AUTOMATED CHECKS] PASSED','[LOCAL READINESS] PASSED')) {
            Assert-True (($messages -join "`n").Contains($expected)) "Deployment summary omitted $expected."
        }
        Assert-True (-not (($messages -join "`n") -match 'MICROSOFT ACCESS|review Permissions')) 'Deployment summary included an unnecessary Microsoft access status or Permissions follow-up.'
        Assert-ConfigUnchanged $qualification $snapshot
        Assert-True (-not (($deploymentCalls -join "`n") -match 'database\.ts\|(?:reset|preflight-reset)\|')) 'Normal start invoked the destructive reset path.'
        $messages=Invoke-LocalDeployment $qualification 'Start' 6>&1
        Assert-True (($messages -join "`n").Contains('[AUTOMATED CHECKS] NOT RUN')) 'Existing-image Start falsely reported automated checks.'

        $script:Failure='backend/scripts/test-all\.ts$|\|down\|--volumes'
        try {
            Invoke-LocalSoftwareChecks $qualification 6>$null
            throw 'Expected both the test and cleanup failures.'
        } catch {
            Assert-True ($_.Exception -is [AggregateException] -and $_.Exception.InnerExceptions.Count -eq 2) 'Cleanup failure hid the original software failure.'
            Assert-True ($_.Exception.Message.Contains('Cleanup failed for isolated Compose project')) 'Cleanup failure did not identify its owned project.'
        }
        $script:Failure=''
    } finally {
        $script:Failure=''
        $script:MonitoredMarker=''
    }

    $resetContext=New-FixtureContext 'database-reset-project'
    foreach ($answer in @($tenant,$client,$clientSecret,'contoso.com')) { $script:Answers.Enqueue($answer) }
    Initialize-LocalState $resetContext $false -Onboard 6>$null
    $script:Volumes.Add($resetContext.Volume) | Out-Null
    $resetSnapshot=Get-ConfigSnapshot $resetContext
    $backup=Join-Path $resetContext.State 'backups/retained.dump'
    [IO.File]::WriteAllText($backup,'retained-backup')
    $script:MonitoredMarker=Join-Path $resetContext.State 'control/maintenance'
    try {
        $callOffset=$script:Calls.Count
        $script:MarkerCalls.Clear()
        $messages=Invoke-LocalDeployment $resetContext 'Deploy' -DbReset 3>&1 6>&1
        $resetCalls=@($script:Calls | Select-Object -Skip $callOffset)
        $tests=Get-UniqueCallIndex $resetCalls 'backend/scripts/test-all\.ts$'
        $preflight=Get-UniqueCallIndex $resetCalls 'database\.ts\|preflight-reset\|agentcontrol$'
        $stop=Get-UniqueCallIndex $resetCalls '\|stop\|--timeout\|130\|app$'
        $reset=Get-UniqueCallIndex $resetCalls 'database\.ts\|reset\|agentcontrol$'
        $migrate=Get-UniqueCallIndex $resetCalls 'database\.ts\|migrate$'
        $start=Get-UniqueCallIndex $resetCalls '\|--wait-timeout\|90\|app$'
        Assert-True ($tests -lt $preflight -and $preflight -lt $stop -and $stop -lt $reset -and $reset -lt $migrate -and $migrate -lt $start) 'DbReset did not qualify, validate, drain, reset, initialize and start in order.'
        Assert-True (-not (($resetCalls -join "`n") -match 'database\.ts\|preflight$')) 'Explicit reset checked compatibility with the schema it is replacing.'
        Assert-True (@($script:MarkerCalls | Where-Object { $_.command -match 'database\.ts\|reset\|agentcontrol$' -and $_.maintenance }).Count -eq 1) 'DbReset ran without maintenance.'
        Assert-True (($messages -join "`n").Contains('All saved application data')) 'DbReset omitted the destructive-data warning.'
        Assert-ConfigUnchanged $resetContext $resetSnapshot
        Assert-True ([IO.File]::ReadAllText($backup) -ceq 'retained-backup') 'DbReset removed existing backup files.'
        foreach ($resetFailure in @(
            @{pattern='backend/scripts/test-all\.ts$';maintenance=$false;started=$false},
            @{pattern='^build\|--target\|runtime\|';maintenance=$false;started=$false},
            @{pattern='database\.ts\|preflight-reset\|agentcontrol$';maintenance=$false;started=$false},
            @{pattern='\|stop\|--timeout\|130\|app$';maintenance=$true;started=$false},
            @{pattern='database\.ts\|reset\|agentcontrol$';maintenance=$true;started=$true},
            @{pattern='database\.ts\|migrate$';maintenance=$true;started=$true},
            @{pattern='\|--wait-timeout\|90\|app$';maintenance=$true;started=$true}
        )) {
            if (Test-Path -LiteralPath $script:MonitoredMarker) { Remove-Item -LiteralPath $script:MonitoredMarker }
            $callOffset=$script:Calls.Count
            $script:Failure=$resetFailure.pattern
            Assert-Fails { Invoke-LocalDeployment $resetContext 'Deploy' -DbReset 6>$null } 'Simulated'
            $script:Failure=''
            Assert-True ((Test-Path -LiteralPath $script:MonitoredMarker) -eq $resetFailure.maintenance) "Failed DbReset deployment left incorrect maintenance state after $($resetFailure.pattern)."
            Assert-True ($resetContext.DbResetStarted -eq $resetFailure.started) 'Failed deployment misreported whether reset began.'
            $resetCalls=@($script:Calls | Select-Object -Skip $callOffset)
            Assert-True (@($resetCalls | Where-Object { $_ -match 'database\.ts\|reset\|agentcontrol$' }).Count -eq [int]$resetFailure.started) 'Reset ran before qualification/drain or was repeated.'
            Assert-True (-not (($resetCalls -join "`n").Contains("|-p|$($resetContext.Project)|down"))) 'DbReset destroyed the Compose project or PostgreSQL volume.'
            Assert-ConfigUnchanged $resetContext $resetSnapshot
            Assert-True ([IO.File]::ReadAllText($backup) -ceq 'retained-backup') 'Failed reset removed backups.'
        }
    } finally {
        $script:Failure=''
        $script:MonitoredMarker=''
    }

    $uninstalled=New-LocalContext $testRoot 'software-only-project'
    $promptCount=$script:Prompts.Count
    $callOffset=$script:Calls.Count
    Invoke-LocalDeployment $uninstalled 'Test' 6>$null
    Assert-True (-not (Test-Path -LiteralPath $uninstalled.State)) 'Software-only tests initialized application state or secrets.'
    Assert-True ($script:Prompts.Count -eq $promptCount) 'Software-only tests prompted for tenant credentials.'
    Assert-True (-not (($script:Calls | Select-Object -Skip $callOffset) -join "`n").Contains('|-p|software-only-project|')) 'Software-only tests invoked the application Compose project.'
    Assert-True (($script:FixtureCalls.project | Select-Object -Unique).Count -gt 1) 'Separate preflights reused a test project.'

    $backups=Join-Path $context.State 'backups'
    $originalCulture=[Threading.Thread]::CurrentThread.CurrentCulture
    try {
        foreach ($culture in @('en-US','en-GB')) {
            [Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::GetCultureInfo($culture)
            foreach ($age in @(1,8)) {
                $dump=Join-Path $backups "fixture-$age.dump"
                [IO.File]::WriteAllText($dump,'fixture')
                $created=[DateTime]::UtcNow.AddDays(-$age)
                [IO.File]::WriteAllText("$dump.json",(@{version=3;sha256=('a'*64);snapshotAt=$created.AddSeconds(-1).ToString('o');createdAt=$created.ToString('o')} | ConvertTo-Json))
            }
            Remove-ExpiredLocalBackups $backups
            Assert-True (Test-Path -LiteralPath (Join-Path $backups 'fixture-1.dump')) "Retention removed a current backup under $culture."
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $backups 'fixture-8.dump'))) "Retention left an expired dump under $culture."
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $backups 'fixture-8.dump.json'))) "Retention left an expired receipt under $culture."
        }
    } finally {
        [Threading.Thread]::CurrentThread.CurrentCulture=$originalCulture
    }
    [IO.File]::WriteAllText($secret,'corrupt')
    Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'corrupt'
    [IO.File]::WriteAllText($secret,$before)
    Remove-Item -LiteralPath $secret
    Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'original secret'
    Assert-Fails { Invoke-LocalDeployment $context 'Reset' -ConfirmReset 'other/other_data' } 'reset denied'
    Write-Host "Passed $script:Checks PowerShell orchestration assertions."
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
    if ((Test-Path -LiteralPath $scratchRoot) -and -not (Get-ChildItem -LiteralPath $scratchRoot -Force)) {
        Remove-Item -LiteralPath $scratchRoot
    }
}