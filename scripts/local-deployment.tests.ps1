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
function Get-Command {
    param([string]$Name,$ErrorAction)
    if ($Name -eq 'docker') { if (-not $script:NoDocker) { return @{Name='docker'} }; return }
    Microsoft.PowerShell.Core\Get-Command $Name -ErrorAction $ErrorAction
}
function Invoke-TestDocker {
    param([string[]]$Arguments,[switch]$Capture)
    $line=$Arguments -join '|'; $script:Calls.Add($line)
    if ($script:CheckProjectEnvironment -and $Arguments[0] -eq 'compose' -and $Arguments -contains '--env-file') {
        foreach ($name in @('LOCAL_STATE_DIR','APP_PORT','APP_UID','APP_GID','APP_IMAGE','TENANT_ID','CLIENT_ID','FRONTEND_ORIGIN','REDIRECT_URI','TRUST_PROXY')) {
            if ($null -ne [Environment]::GetEnvironmentVariable($name)) { throw "Shell environment overrode project setting $name." }
        }
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
function New-FixtureContext {
    param([string]$Name,[int]$Port=14391)
    $fixture=New-LocalContext $testRoot $Name
    [IO.Directory]::CreateDirectory($fixture.State) | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture.State 'settings.json'),(@{port=$Port;tenantId='';clientId=''} | ConvertTo-Json))
    return New-LocalContext $testRoot $Name
}
function Get-ConfigSnapshot {
    param($Context)
    $snapshot=@{}
    foreach ($relative in @('settings.json','compose.env','secrets/client-secret','secrets/postgres-admin','secrets/postgres-app','secrets/session')) {
        $path=Join-Path $Context.State $relative
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
    foreach ($permission in @('CopilotPackages.Read.All','CopilotPackages.ReadWrite.All','User.ReadBasic.All','Group.Read.All','AuditLogsQuery.Read.All','ThreatHunting.Read.All','ResourceQuery.Resources.Read','CopilotStudio.AdminActions.Invoke')) {
        Assert-True ($guidance.Contains($permission)) "Registration guidance omitted permission $permission."
    }
    $manifest=Get-Content -LiteralPath (Join-Path $repositoryRoot 'infra/entra-app-manifest.json') -Raw | ConvertFrom-Json
    Assert-True (($manifest.appRoles.value -join ',') -ceq 'AgentControl.Viewer,AgentControl.Admin') 'Manifest must expose exactly Viewer and Admin.'
    Assert-True (@($manifest.appRoles | Where-Object { ($_.allowedMemberTypes -join ',') -cne 'User' }).Count -eq 0) 'App roles must be assignable to users/groups only.'
    foreach ($role in $manifest.appRoles) { Assert-True ($guidance.Contains($role.value)) 'Registration guidance omitted an application role.' }
    foreach ($requiredText in @('openid and profile','Microsoft Graph - Delegated permissions','Power Platform - Delegated permissions','8578e004-a5c6-46e7-913e-12f58912df43','tenant administrator consent','Optional Microsoft Graph Application permissions','Admin includes Viewer access','only one role assignment','Assignment required','Users/Groups for Allowed member types','does not verify or grant permissions')) {
        Assert-True ($guidance.Contains($requiredText)) "Registration guidance omitted distinction: $requiredText."
    }
    foreach ($requiredText in @('checks delegated access automatically','Interactive consent, MFA or Conditional Access','Automatic checks never change packages','Token acquisition alone does not prove provider access','Normal sign-in requests all implemented delegated permissions up front, including package changes','Sign in without provider setup defers consent')) {
        Assert-True ($guidance.Contains($requiredText)) "Automatic access-check guidance omitted distinction: $requiredText."
    }
    $entry=Microsoft.PowerShell.Core\Get-Command (Join-Path $repositoryRoot 'deploy-local.ps1')
    foreach ($removed in @('TenantId','ClientId','ClientSecretFile','Port','StateRoot','Action','DryRun','ConfirmCleanup','BackupFile','RestoreDatabase','CleanupBatchSize','ConfirmReset','OpenBrowser')) {
        Assert-True (-not $entry.Parameters.ContainsKey($removed)) "Entry point still accepts $removed."
    }
    Assert-True ($entry.ScriptBlock.Ast.ParamBlock.Parameters.Count -eq 2) 'Entry point must expose only Command and Project.'
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
    $script:NoDocker=$true
    Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'approved Docker'
    $script:NoDocker=$false; $script:Failure='^info\|'
    Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'Simulated'
    $script:Failure=''; $script:ComposeVersion='1.29.0'
    Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'Compose v2'
    $script:ComposeVersion='2.30.0'
    Assert-Fails { Invoke-LocalDeployment $context 'Reset' } 'reset denied'
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $listener.Start()
    try { Assert-Fails { Assert-LocalPort $listener.LocalEndpoint.Port } 'occupied' } finally { $listener.Stop() }
    foreach ($answer in @($tenant,$client,$clientSecret)) { $script:Answers.Enqueue($answer) }
    foreach ($failure in @('^build\|','\|migrate$','\|--wait-timeout\|90\|postgres$','\|--wait-timeout\|90\|app$')) {
        $script:Failure=$failure
        Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'Simulated'
    }
    Assert-True ($script:Prompts.Count -eq 3) 'New project did not onboard exactly once.'
    Assert-True ($script:Prompts[2] -match 'secure=True$') 'Client secret was not prompted securely.'
    $saved=Get-Content -LiteralPath (Join-Path $context.State 'settings.json') -Raw | ConvertFrom-Json
    Assert-True ($saved.tenantId -ceq $tenant -and $saved.clientId -ceq $client) 'Onboarding identifiers were not saved.'
    Assert-True ([IO.File]::ReadAllText((Join-Path $context.State 'secrets/client-secret')) -ceq $clientSecret) 'Client secret was not saved.'
    $compose=[IO.File]::ReadAllText((Join-Path $context.State 'compose.env'))
    Assert-True ($compose.Contains("TENANT_ID=$tenant") -and $compose.Contains("CLIENT_ID=$client")) 'Compose did not receive the saved identifiers.'
    Assert-True (-not $compose.Contains($clientSecret)) 'Client secret leaked into compose.env.'
    Assert-True (-not [IO.File]::ReadAllText((Join-Path $context.State 'settings.json')).Contains($clientSecret)) 'Client secret leaked into settings.json.'
    if (-not $IsWindows) {
        Assert-True ([int][IO.File]::GetUnixFileMode((Join-Path $context.State 'secrets/client-secret')) -eq 384) 'Client secret permissions are not 0600.'
        Assert-True ([int][IO.File]::GetUnixFileMode((Join-Path $context.State 'secrets')) -eq 448) 'Secret directory permissions are not 0700.'
    }
    $script:Failure=''
    Invoke-LocalDeployment $context 'Deploy' 6>$null
    $secret=Join-Path $context.State 'secrets/postgres-app'
    $before=[IO.File]::ReadAllText($secret)
    Invoke-LocalDeployment $context 'Deploy' 6>$null
    Invoke-LocalDeployment $context 'Start' 6>$null
    Assert-True ($script:Prompts.Count -eq 3) 'Configured Deploy/Start prompted again.'
    Assert-True ([IO.File]::ReadAllText($secret) -ceq $before) 'Repeat deploy rotated credentials.'
    Assert-True ([IO.File]::ReadAllText((Join-Path $context.State 'secrets/client-secret')) -ceq $clientSecret) 'Repeat deploy changed the Entra secret.'
    Assert-True (($script:Calls -join "`n") -notlike "*$before*") 'Secret leaked to command arguments.'
    Assert-True (-not ($script:Calls -join "`n").Contains($clientSecret)) 'Entra secret leaked to command arguments.'
    Assert-True (($script:Calls -join "`n").Contains($testRoot)) 'Paths containing spaces were not preserved.'
    Assert-True (-not (($script:Calls -join "`n") -match 'down\|--volumes')) 'Normal deployment reset the volume.'
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
        foreach ($answer in @($otherTenant,$otherClient,'other-fixture-secret','14392')) { $script:Answers.Enqueue($answer) }
        Initialize-LocalState $target $false -Onboard 6>$null
        Initialize-LocalState $target $true -Onboard 6>$null
        Assert-True ($script:Prompts.Count -eq $promptCount+4) 'Default/named project onboarding or reuse failed.'
        Assert-True ([IO.File]::ReadAllText((Join-Path $target.State 'compose.env')).Contains("TENANT_ID=$otherTenant")) 'Project received the wrong identity.'
        $reloaded=New-LocalContext $testRoot $target.Project
        Assert-True ($reloaded.Port -eq 14392 -and $reloaded.Url -ceq 'http://localhost:14392') 'Project did not load its saved port.'
    }
    Assert-True ([IO.File]::ReadAllText((Join-Path $context.State 'settings.json')).Contains($tenant)) 'Another project changed the original identity.'
    Assert-True ([IO.File]::ReadAllText((Join-Path $customerContext.State 'secrets/postgres-app')) -cne $before) 'Projects shared generated database credentials.'

    $editContext=New-FixtureContext 'editable-project'
    foreach ($answer in @($tenant,$client,"  $clientSecret  ")) { $script:Answers.Enqueue($answer) }
    Initialize-LocalState $editContext $false -Onboard 6>$null
    $script:Volumes.Add($editContext.Volume) | Out-Null
    $editSettings=Join-Path $editContext.State 'settings.json'
    $editSecret=Join-Path $editContext.State 'secrets/client-secret'
    [IO.File]::WriteAllText($editSettings,("{`n  `"port`":14391,`n  `"tenantId`":`"$tenant`",`n  `"clientId`":`"$client`",`n  `"note`":`"preserve me`"`n}"))
    [IO.File]::WriteAllText($editSecret," $clientSecret`n")
    foreach ($relative in (Get-ConfigSnapshot $editContext).Keys) {
        [IO.File]::SetLastWriteTimeUtc((Join-Path $editContext.State $relative),[DateTime]::new(2001,1,1,0,0,0,[DateTimeKind]::Utc))
    }
    $snapshot=Get-ConfigSnapshot $editContext
    $callsBefore=$script:Calls.Count
    foreach ($answer in @('','','','','')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot
    Assert-True ($script:Calls.Count -eq $callsBefore+3) 'No-op edit stopped containers or made unnecessary Docker changes.'
    foreach ($answer in @($tenant,$client,$clientSecret,'14391','')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot

    foreach ($answer in @('','','','14393','')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot @('settings.json','compose.env')
    $edited=Get-Content -LiteralPath $editSettings -Raw | ConvertFrom-Json
    Assert-True ($edited.port -eq 14393 -and $edited.note -ceq 'preserve me' -and $edited.tenantId -ceq $tenant -and $edited.clientId -ceq $client) 'Port-only edit changed unrelated settings.'
    Assert-True ($editContext.Url -ceq 'http://localhost:14393' -and (New-LocalContext $testRoot 'editable-project').Port -eq 14393) 'Edited port was not applied to saved/new contexts.'
    Assert-True ($script:Calls[$script:Calls.Count-1] -match '\|stop\|--timeout\|130\|app$') 'Configuration changed before stopping/draining the app.'
    Assert-True (Test-Path -LiteralPath (Join-Path $editContext.State 'control/maintenance')) 'Edited project was not left in maintenance.'

    $snapshot=Get-ConfigSnapshot $editContext
    foreach ($answer in @('','','replacement-fixture-secret','','')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot @('secrets/client-secret')
    Assert-True ([IO.File]::ReadAllText($editSecret) -ceq 'replacement-fixture-secret') 'Secret-only edit did not save the new secret.'
    $reauthenticate=Join-Path $editContext.State 'control/reauthenticate'
    Assert-True (-not (Test-Path -LiteralPath $reauthenticate)) 'Port/secret-only edits unnecessarily scheduled session deletion.'

    $snapshot=Get-ConfigSnapshot $editContext
    foreach ($answer in @('',$otherClient,'','','')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot @('settings.json','compose.env')
    Assert-True ((Get-Content -LiteralPath $editSettings -Raw | ConvertFrom-Json).clientId -ceq $otherClient) 'Client-ID-only edit was not saved.'
    Assert-True (Test-Path -LiteralPath $reauthenticate) 'Changed application ID did not schedule reauthentication.'
    Assert-True (-not ($script:Prompts -join "`n").Contains('replacement-fixture-secret')) 'Edit wizard displayed the saved secret.'
    Assert-True (-not ($script:Calls -join "`n").Contains('replacement-fixture-secret')) 'Edited secret leaked to Docker arguments.'

    $snapshot=Get-ConfigSnapshot $editContext
    foreach ($answer in @($otherTenant,'','','','')) { $script:Answers.Enqueue($answer) }
    Assert-Fails { Invoke-LocalDeployment $editContext 'EditConfig' 6>$null } 'retained data'
    Assert-ConfigUnchanged $editContext $snapshot
    foreach ($answer in @('','',"first`nsecond")) { $script:Answers.Enqueue($answer) }
    Assert-Fails { Invoke-LocalDeployment $editContext 'EditConfig' 6>$null } 'Configuration requires'
    Assert-ConfigUnchanged $editContext $snapshot
    foreach ($answer in @('','','unsaved-secret','14394','')) { $script:Answers.Enqueue($answer) }
    $script:Failure='\|stop\|--timeout\|130\|app$'
    Assert-Fails { Invoke-LocalDeployment $editContext 'EditConfig' 6>$null } 'Simulated'
    $script:Failure=''
    Assert-ConfigUnchanged $editContext $snapshot

    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $listener.Start()
    try {
        foreach ($answer in @('','','',"$($listener.LocalEndpoint.Port)",'')) { $script:Answers.Enqueue($answer) }
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
    foreach ($answer in (@('','','','') + $invalidUrls + @(" $tunnelUrl "))) { $script:Answers.Enqueue($answer) }
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
    foreach ($answer in @('','','','','')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot
    Assert-True ($script:Calls.Count -eq $callsBefore+3) 'No-op public URL edit stopped the app.'
    foreach ($answer in @('','','','','https://replacement.devtunnels.ms')) { $script:Answers.Enqueue($answer) }
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

    foreach ($answer in @('','','','14394','')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-True ($editContext.PublicUrl -ceq $tunnelUrl -and $editContext.Url -ceq 'http://localhost:14394') 'Port edit altered the explicit public origin.'
    foreach ($answer in @('','','','','local')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    $reloaded=New-LocalContext $testRoot 'editable-project'
    Assert-True ($reloaded.PublicUrl -ceq 'http://localhost:14394' -and (Read-LocalSettings $editContext.State).publicUrl -ceq '') 'Reset did not restore automatic localhost origin.'
    $compose=[IO.File]::ReadAllText((Join-Path $editContext.State 'compose.env'))
    foreach ($expected in @('FRONTEND_ORIGIN=http://localhost:14394','REDIRECT_URI=http://localhost:14394/api/auth/callback','TRUST_PROXY=0')) {
        Assert-True ($compose.Contains($expected)) "Reset configuration omitted $expected."
    }
    $snapshot=Get-ConfigSnapshot $editContext
    foreach ($answer in @('','','','','')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $editContext 'EditConfig' 6>$null
    Assert-ConfigUnchanged $editContext $snapshot

    $invalidPublic=New-FixtureContext 'invalid-public-url'
    foreach ($value in @($null,42,@{},'http://remote.example','https://remote.example/path')) {
        [IO.File]::WriteAllText((Join-Path $invalidPublic.State 'settings.json'),(@{port=14391;publicUrl=$value} | ConvertTo-Json))
        Assert-Fails { New-LocalContext $testRoot 'invalid-public-url' } 'Saved publicUrl'
    }

    $unstarted=New-LocalContext $testRoot 'unstarted-project'
    foreach ($answer in @($tenant,$client,$clientSecret,'14394',$tunnelUrl)) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $unstarted 'EditConfig' 6>$null
    foreach ($answer in @($otherTenant,'','','','')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $unstarted 'EditConfig' 6>$null
    Assert-True ((Get-Content -LiteralPath (Join-Path $unstarted.State 'settings.json') -Raw | ConvertFrom-Json).tenantId -ceq $otherTenant) 'Tenant correction before first deployment was rejected.'
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
        foreach ($answer in @('','','','14395','')) { $script:Answers.Enqueue($answer) }
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
        foreach ($answer in @('','','','','')) { $script:Answers.Enqueue($answer) }
        Invoke-LocalDeployment $portOnly 'EditConfig' 6>$null
        Assert-True ([IO.File]::ReadAllText($settingsPath) -ceq $settingsBefore -and (Get-Item -LiteralPath $settingsPath).LastWriteTimeUtc.Ticks -eq $modified) 'No-op edit rewrote incomplete settings.'
        $script:Answers.Enqueue('')
        Assert-Fails { Invoke-LocalDeployment $portOnly 'Deploy' 6>$null } 'Configuration requires'
    }

    $newPortOnly=New-LocalContext $testRoot 'new-port-only'
    foreach ($answer in @('','','','14395','')) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $newPortOnly 'EditConfig' 6>$null
    $newSettings=Get-Content -LiteralPath (Join-Path $newPortOnly.State 'settings.json') -Raw | ConvertFrom-Json -AsHashtable
    Assert-True ($newSettings.Count -eq 1 -and $newSettings.port -eq 14395) 'New port-only configuration saved unwanted identity fields.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $newPortOnly.State 'secrets/client-secret'))) 'New port-only configuration created an unset client secret.'
    foreach ($answer in @($tenant,$client,$clientSecret)) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $newPortOnly 'Deploy' 6>$null
    Assert-True ($newPortOnly.Port -eq 14395 -and [IO.File]::ReadAllText((Join-Path $newPortOnly.State 'secrets/client-secret')) -ceq $clientSecret) 'Start did not complete identity setup while retaining the edited port.'

    $shellValues=@{}
    try {
        foreach ($name in @('LOCAL_STATE_DIR','APP_PORT','APP_UID','APP_GID','APP_IMAGE','TENANT_ID','CLIENT_ID','FRONTEND_ORIGIN','REDIRECT_URI','TRUST_PROXY')) {
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
        if ($missing -in @('port','all')) { $script:Answers.Enqueue('14391') }
        Initialize-LocalState $partial $true -Onboard 6>$null
        $expected=if ($missing -eq 'all') { 4 } else { 1 }
        Assert-True ($script:Prompts.Count -eq $promptCount+$expected) "Partial project $missing prompted for already saved values."
        $updated=Get-Content -LiteralPath $partialSettings -Raw | ConvertFrom-Json
        Assert-True ($updated.tenantId -ceq $tenant -and $updated.clientId -ceq $client -and [IO.File]::ReadAllText($partialSecret) -ceq $clientSecret) "Partial project $missing was not completed."
        foreach ($name in $hashes.Keys) {
            Assert-True ((Get-FileHash -LiteralPath (Join-Path $partial.State "secrets/$name")).Hash -ceq $hashes[$name]) "Onboarding rotated $name."
        }
    }

    $invalidContext=New-LocalContext $testRoot 'invalid-input'
    foreach ($answer in @('not-a-guid'," $tenant ",$client,$clientSecret,'abc','1023','65536','14391')) { $script:Answers.Enqueue($answer) }
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
    foreach ($answer in @($tenant,$client,$clientSecret)) { $script:Answers.Enqueue($answer) }
    Invoke-LocalDeployment $maintenanceContext 'Start' 6>$null
    Assert-True ($script:Prompts.Count -eq $promptCount+3) 'Start did not onboard an existing unconfigured project.'
    Assert-True ($script:Answers.Count -eq 0) 'Not all expected wizard answers were consumed.'

    $entryRoot=Join-Path $testRoot 'entrypoint'
    [IO.Directory]::CreateDirectory((Join-Path $entryRoot 'scripts')) | Out-Null
    Copy-Item -LiteralPath $entry.Source -Destination (Join-Path $entryRoot 'deploy-local.ps1')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'local-deployment.ps1') -Destination (Join-Path $entryRoot 'scripts/local-deployment.ps1')
    $entryPath=Join-Path $entryRoot 'deploy-local.ps1'
    $entryState=Join-Path $entryRoot '.local'
    $retainedContext=$context
    foreach ($projectArguments in @(@{},@{Project='newCustomer'})) {
        $promptCount=$script:Prompts.Count
        foreach ($answer in @($tenant,$client,$clientSecret,'14391')) { $script:Answers.Enqueue($answer) }
        $script:WizardTrace.Clear()
        $messages=. $entryPath @projectArguments 6>&1 | ForEach-Object { $script:WizardTrace.Add([string]$_); $_ }
        $trace=$script:WizardTrace -join "`n"
        Assert-True ($trace.IndexOf('Registered app permissions and setup') -ge 0 -and $trace.IndexOf('Registered app permissions and setup') -lt $trace.IndexOf('PROMPT:')) 'Registration guidance must appear before the first wizard prompt.'
        Assert-True ($script:Prompts.Count -eq $promptCount+4) 'Public entry point did not onboard the selected project.'
        Assert-True (-not ($messages -join "`n").Contains($clientSecret)) 'Public entry point printed the client secret.'
        $messages=. $entryPath start @projectArguments 6>&1
        Assert-True (-not ($messages -join "`n").Contains('Registered app permissions and setup')) 'Configured start unnecessarily repeated onboarding guidance.'
        Assert-True ($script:Prompts.Count -eq $promptCount+4) 'Public entry point did not reuse saved onboarding values.'
        $projectName=if ($projectArguments.Project) { 'newcustomer' } else { 'agent-control' }
        Assert-True (Test-Path -LiteralPath (Join-Path $entryState "$projectName/settings.json")) 'Entry point did not save the selected project folder.'
        $messages=. $entryPath stop @projectArguments 6>&1
        Assert-True (-not ($messages -join "`n").Contains('Registered app permissions and setup')) 'Stop unexpectedly displayed onboarding guidance.'
        Assert-True (Test-Path -LiteralPath (Join-Path $entryState "$projectName/control/maintenance")) 'Explicit stop did not close admissions.'
        foreach ($answer in @('','','','',$tunnelUrl)) { $script:Answers.Enqueue($answer) }
        $messages=. $entryPath -Action edit-config @projectArguments 6>&1
        Assert-True (($messages -join "`n").Contains($guidance)) 'Edit-config did not display the complete registration guidance.'
        Assert-True (-not ($messages -join "`n").Contains($clientSecret)) 'Edit-config displayed the saved client secret.'
        Assert-True ($script:Prompts.Count -eq $promptCount+9) 'Explicit edit-config did not prompt for all settings.'
        $entrySettings=Read-LocalSettings (Join-Path $entryState $projectName)
        Assert-True ($entrySettings.publicUrl -ceq $tunnelUrl -and $entrySettings.port -eq 14391) '-Action edit-config did not persist the public URL independently of the port.'
        $messages=. $entryPath -Action start @projectArguments 6>&1
        Assert-True ($script:Prompts.Count -eq $promptCount+9 -and ($messages -join "`n").Contains("Open $tunnelUrl to sign in")) '-Action start did not reuse the saved public URL.'
    }
    $context=$retainedContext
    Assert-True ($script:Answers.Count -eq 0) 'Entry-point wizard did not consume the expected answers.'
    Assert-Fails { . $entryPath -Port 3001 } 'parameter.*Port'
    Assert-Fails { . $entryPath -StateRoot $testRoot } 'parameter.*StateRoot'
    Assert-Fails { . $entryPath -Action Reset } 'ValidateSet|validation|not belong'

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