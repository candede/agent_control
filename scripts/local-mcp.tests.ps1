#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
$repository = Split-Path $PSScriptRoot -Parent
$root = Join-Path $repository "artifacts/test-scratch/mcp-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($root) | Out-Null
Copy-Item -LiteralPath (Join-Path $repository 'compose.yaml') -Destination $root
Copy-Item -LiteralPath (Join-Path $repository 'compose.mcp.yaml') -Destination $root
$script:checks = 0
$script:calls = [Collections.Generic.List[string]]::new()
$script:running = $false
$script:failStart = $false
$script:mountDetails = $null
$script:ready = $true
$script:volume = $false
$script:endpoint = "unix://$HOME/.docker/run/docker.sock"
$script:image = 'sha256:' + ('a'*64)
$script:container = 'b'*64
function Assert($Condition,[string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Fails([scriptblock]$Action,[string]$Pattern) {
    try { & $Action; throw 'Expected failure did not occur.' }
    catch { Assert ($_.Exception.Message -match $Pattern) "Unexpected failure: $($_.Exception.Message)" }
}
function docker {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
    $global:LASTEXITCODE = 0
    $script:calls.Add($Arguments -join '|')
    if ($Arguments[0] -eq 'context') {
        if ($Arguments[1] -eq 'show') { return 'desktop-linux' }
        return $script:endpoint
    }
    if ($Arguments[0] -eq 'volume') {
        if ($Arguments[1] -eq 'ls') { if ($script:volume) { return $context.McpVolume }; return '' }
        if ($Arguments[1] -eq 'create') { $script:volume=$true;return $context.McpVolume }
        if ($Arguments[1] -eq 'inspect') { return (@{name=$context.McpVolume;driver='local';createdAt='synthetic-created-at';labels=@{'com.docker.compose.project'=$context.Project;'com.docker.compose.volume'='mcp-oauth';'io.agent-control.purpose'='encrypted-oauth-state'}} | ConvertTo-Json -Compress) }
    }
    if ($Arguments[0] -eq 'inspect') { return $script:mountDetails | ConvertTo-Json -Depth 8 -Compress }
    if ($Arguments[0] -eq 'compose') {
        Assert (-not [Environment]::GetEnvironmentVariable('MCP_PUBLIC_URL')) 'Shell MCP configuration replaced project authority.'
        Assert (-not [Environment]::GetEnvironmentVariable('MCP_CLIENT_SECRET_FILE')) 'Shell MCP credentials replaced project secret mounts.'
        if ($script:failStart) { throw 'Simulated MCP start failure.' }
        $script:running=$true
    }
}
function Get-OwnedLocalContainers {
    param($Context)
    if ($script:running) { @{Id=$script:container;Service='mcp';Image=$script:image;State=@{Running=$true;Health=@{Status=$(if ($script:ready) {'healthy'} else {'unhealthy'})}}} }
}
function New-McpSetupFixture {
    param([string]$Name,[object[]]$Profiles,[int]$Port=8001)
    $directory = Join-Path $root $Name
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    foreach ($file in @('compose.yaml','compose.mcp.yaml')) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $directory }
    $fixture = New-LocalContext $directory 'mcp-test'
    $secrets = Join-Path $fixture.State 'secrets'
    [IO.Directory]::CreateDirectory($secrets) | Out-Null
    Protect-LocalPath $secrets -Directory
    Write-LocalText (Join-Path $secrets 'tenants.json') (ConvertTo-Json -InputObject @($Profiles) -Depth 20)
    Write-LocalText (Join-Path $fixture.State 'settings.json') (@{port=$Port;publicUrl='';tenants=(Get-LocalTenantMetadata $Profiles)} | ConvertTo-Json -Depth 20)
    return $fixture
}
$script:textAnswers = [Collections.Generic.Queue[string]]::new()
$script:secretAnswers = [Collections.Generic.Queue[string]]::new()
$script:prompts = [Collections.Generic.List[object]]::new()
$script:portChecks = [Collections.Generic.List[int]]::new()
function Assert-LocalPort {
    param([int]$Port)
    $script:portChecks.Add($Port)
}
function Set-SetupAnswers {
    param([string[]]$Text=@(),[string[]]$Secrets=@())
    $script:textAnswers.Clear(); $script:secretAnswers.Clear(); $script:prompts.Clear()
    foreach ($answer in $Text) { $script:textAnswers.Enqueue($answer) }
    foreach ($answer in $Secrets) { $script:secretAnswers.Enqueue($answer) }
}
function Read-Host {
    param([string]$Prompt,[switch]$AsSecureString)
    $script:prompts.Add(@{text=$Prompt;secure=[bool]$AsSecureString})
    if ($AsSecureString) {
        if (-not $script:secretAnswers.Count) { throw 'Unexpected secure prompt in setup test.' }
        $answer=$script:secretAnswers.Dequeue()
        if ($answer -eq '') { return [Security.SecureString]::new() }
        return ConvertTo-SecureString $answer -AsPlainText -Force
    }
    if (-not $script:textAnswers.Count) { throw 'Unexpected text prompt in setup test.' }
    return $script:textAnswers.Dequeue()
}
try {
    Assert (Test-LocalBindSource '/Users/fixture/key' '/Users/fixture/key') 'Exact bind source was refused.'
    Assert (-not (Test-LocalBindSource '/host_mnt/Users/other/key' '/Users/fixture/key')) 'Foreign mapped bind source was accepted.'
    if ($IsMacOS) {
        Assert (Test-LocalBindSource '/host_mnt/Users/fixture/key' '/Users/fixture/key') 'Verified Docker Desktop mapping was refused.'
        $script:endpoint='ssh://remote.invalid'
        Assert (-not (Test-LocalBindSource '/host_mnt/Users/fixture/key' '/Users/fixture/key')) 'Remote daemon alias was accepted.'
        $script:endpoint="unix://$HOME/.docker/run/docker.sock"
    }
    $context = New-LocalContext $root 'mcp-test'
    Assert (-not $context.Mcp -and $context.Compose -notcontains (Join-Path $root 'compose.mcp.yaml')) 'Missing optional configuration provisioned MCP.'
    $before=$script:calls.Count
    Start-LocalMcp $context
    Assert ($script:calls.Count -eq $before -and -not (Test-Path -LiteralPath $context.State)) 'Unconfigured MCP touched Docker or state.'
    $mcp = @{tenantId='11111111-1111-1111-1111-111111111111';apiClientId='22222222-2222-2222-2222-222222222222';clientId='33333333-3333-3333-3333-333333333333'
        publicUrl='https://mcp.example.test/mcp';redirectUris=@('https://client.example.test/callback');port=14392}
    $profile = @{tenantId=$mcp.tenantId;clientId=$mcp.apiClientId;domains=@('example.invalid');clientSecret='synthetic-api-secret'
        integration=@{clientId=$mcp.clientId;audience=$mcp.apiClientId;scope='AgentControl.Access'}}
    $settings = @{port=14391;publicUrl='';tenants=@(Get-LocalTenantMetadata @($profile));mcp=$mcp}
    Assert-LocalMcpSettings $mcp 14391
    foreach ($name in @('tenantId','clientId','apiClientId','publicUrl','redirectUris','port')) {
        $bad=$mcp.Clone();$bad.Remove($name)
        Fails { Assert-LocalMcpSettings $bad 14391 } 'configuration'
    }
    foreach ($url in @('http://mcp.example.test/mcp','https://mcp.example.test/mcp/','https://mcp.example.test/mcp?tenant=x','https://mcp.example.test/mcp#x','https://mcp.example.test','https://MCP.example.test/mcp')) {
        $bad=$mcp.Clone();$bad.publicUrl=$url
        Fails { Assert-LocalMcpSettings $bad 14391 } 'publicUrl'
    }
    foreach ($value in @($null,0,14391,65536,'14392')) {
        $bad=$mcp.Clone();$bad.port=$value
        Fails { Assert-LocalMcpSettings $bad 14391 } 'loopback port'
    }
    foreach ($callback in @('https://*.example.test/callback','http://remote.example.test/callback','https://client.example.test/callback?x=1')) {
        $bad=$mcp.Clone();$bad.redirectUris=@($callback)
        Fails { Assert-LocalMcpSettings $bad 14391 } 'callbacks'
    }
    foreach ($callback in @('http://127.0.0.1:53110/','http://127.0.0.1:19876/mcp/oauth/callback','https://client.example.test/')) {
        $native=$mcp.Clone();$native.redirectUris=@($callback)
        Assert-LocalMcpSettings $native 14391
        Assert ($native.redirectUris[0] -ceq $callback) 'Exact native callback was changed.'
    }
    $secretDirectory=Join-Path $context.State 'secrets'
    [IO.Directory]::CreateDirectory($secretDirectory) | Out-Null
    foreach ($name in @('mcp-client','mcp-signing','mcp-encryption','session')) {
        Write-LocalText (Join-Path $secretDirectory $name) "synthetic-independent-$name"
    }
    $signing=[Convert]::ToBase64String([byte[]](1..32)).Replace('+','-').Replace('/','_')
    $encryption=[Convert]::ToBase64String([byte[]](33..64)).Replace('+','-').Replace('/','_')
    Write-LocalText (Join-Path $secretDirectory 'mcp-signing') $signing
    Write-LocalText (Join-Path $secretDirectory 'mcp-encryption') (ConvertTo-Json -InputObject @($encryption) -Compress)
    Write-LocalText (Join-Path $context.State 'settings.json') ($settings | ConvertTo-Json -Depth 8)
    $plan=Get-LocalMcpPlan $context $settings @($profile)
    Assert ($plan.Inputs.Count -eq 3) 'MCP did not select only three independent protected inputs.'
    $wrong=$profile.Clone();$wrong.integration=@{clientId='44444444-4444-4444-4444-444444444444';audience=$mcp.apiClientId;scope='AgentControl.Access'}
    Fails { Get-LocalMcpPlan $context $settings @($wrong) } 'explicitly match'
    Fails { Get-LocalMcpPlan $context $settings @() } 'explicitly match'
    Save-LocalMcpConfiguration $context $plan
    Assert (-not (Test-Path -LiteralPath (Join-Path $context.State 'mcp/oauth'))) 'MCP incorrectly created a host bind store instead of a dedicated named volume.'
    if (-not $IsWindows) {
        Assert ([int][IO.File]::GetUnixFileMode((Join-Path $secretDirectory 'mcp-client')) -eq 384) 'Secret input is not 0600.'
        [IO.File]::SetUnixFileMode((Join-Path $secretDirectory 'mcp-client'),[IO.UnixFileMode]420)
        Fails { Get-LocalMcpPlan $context $settings @($profile) } '0600'
        Protect-LocalPath (Join-Path $secretDirectory 'mcp-client')
    }
    Sync-LocalMcpContext $context $settings
    Sync-LocalMcpContext $context $settings
    Assert (@($context.Compose | Where-Object { $_ -ceq (Join-Path $root 'compose.mcp.yaml') }).Count -eq 1) 'Compose MCP overlay duplicated.'
    $context.Port=14391;$context.Url='http://localhost:14391';$context.PublicUrl=$context.Url;$context.McpImageId=$script:image
    Write-LocalComposeEnvironment $context
    $environment=[IO.File]::ReadAllText((Join-Path $context.State 'compose.env'))
    foreach ($value in @('MCP_API_CLIENT_ID=22222222-2222-2222-2222-222222222222','MCP_PUBLIC_URL=https://mcp.example.test/mcp','MCP_PORT=14392',"MCP_IMAGE=$script:image")) { Assert ($environment.Contains($value)) "Missing exact environment setting $value." }
    Assert (-not $environment.Contains('synthetic-independent')) 'Secret content entered Compose environment.'
    $run=Get-LocalMcpRunArguments $context
    Assert ($run -contains '--read-only' -and $run -contains '--pids-limit' -and @($run | Where-Object { $_ -like 'type=bind,*readonly' }).Count -eq 3) 'MCP preflight mounts/security differ.'
    Assert (-not (($run -join '|') -match 'tenants.json|postgres|PGPASSWORD|SESSION_SECRET')) 'MCP inherited API/database authority.'
    $env:MCP_PUBLIC_URL='https://wrong.example.test/mcp';$env:MCP_CLIENT_SECRET_FILE='/wrong'
    Start-LocalMcp $context
    Assert ($env:MCP_PUBLIC_URL -ceq 'https://wrong.example.test/mcp') 'MCP shell configuration was not restored after Compose.'
    $receipt=[IO.File]::ReadAllText((Join-Path $context.State 'mcp-deployment.json')) | ConvertFrom-Json
    Assert ($receipt.step -ceq 'verified' -and $receipt.image -ceq $script:image) 'MCP did not persist exact ready image receipt.'
    $script:calls.Clear()
    Start-LocalMcp $context
    Assert (-not (($script:calls -join "`n") -match 'force-recreate')) 'Unchanged MCP configuration forced a restart.'
    $rotatedKey=[Convert]::ToBase64String([byte[]](65..96)).Replace('+','-').Replace('/','_')
    Write-LocalText (Join-Path $secretDirectory 'mcp-encryption') (ConvertTo-Json -InputObject @($rotatedKey,$encryption) -Compress)
    $script:calls.Clear()
    Start-LocalMcp $context
    Assert (($script:calls -join "`n") -match 'force-recreate') 'Independent encryption rotation failed to replace stale secret bind inodes.'
    $rotated=[IO.File]::ReadAllText((Join-Path $context.State 'mcp-deployment.json')) | ConvertFrom-Json
    Assert ($rotated.identity -cne $receipt.identity) 'MCP receipt missed independent key rotation.'
    Assert (-not (($script:calls -join "`n") -match '\|app$|database.ts')) 'MCP rotation restarted API/database.'
    $script:failStart=$true
    Fails { Start-LocalMcp $context } 'Simulated'
    Assert (([IO.File]::ReadAllText((Join-Path $context.State 'mcp-operation.json')) | ConvertFrom-Json).step -ceq 'prepared') 'Interrupted MCP operation falsely completed.'
    $script:failStart=$false
    Start-LocalMcp $context
    Assert (([IO.File]::ReadAllText((Join-Path $context.State 'mcp-operation.json')) | ConvertFrom-Json).step -ceq 'verified') 'Ordinary same-identity retry did not recover.'
    $script:volume=$false
    Fails { Initialize-LocalMcpStorage $context } 'Recorded MCP state volume is missing'
    $script:volume=$true
    Fails { Invoke-LocalMcpChecks $context $null -Image 'mutable:tag' } 'immutable image'
    $script:calls.Clear()
    Invoke-LocalMcpChecks $context $null -Image $script:image
    Assert ($script:calls.Count -eq 1 -and $script:calls[0].Contains('--network|none') -and
        $script:calls[0].Contains('--env|TMPDIR=/work') -and
        $script:calls[0].Contains('--tmpfs|/work:rw,noexec,nosuid,size=64m,uid=') -and
        $script:calls[0].Contains(',mode=0700') -and -not $script:calls[0].Contains('--mount') -and
        $script:calls[0].Contains("--entrypoint|python|$script:image|-m|pytest")) 'Bounded non-root image checks did not use private Linux work tmpfs.'
    $script:mountDetails=@{user="$((& id -u).Trim()):$((& id -g).Trim())";ports=@{'8000/tcp'=@(@{HostIp='127.0.0.1';HostPort='14392'})};networks=@{$context.Network=@{}}
        mounts=@(@{Destination='/run/secrets/mcp-client';Source=(Join-Path $secretDirectory 'mcp-client');Type='bind';RW=$false},
            @{Destination='/run/secrets/mcp-signing';Source=(Join-Path $secretDirectory 'mcp-signing');Type='bind';RW=$false},
            @{Destination='/run/secrets/mcp-encryption';Source=(Join-Path $secretDirectory 'mcp-encryption');Type='bind';RW=$false},
            @{Destination='/var/lib/agent-control-mcp/oauth';Name=$context.McpVolume;Type='volume';RW=$true})}
    Assert-LocalMcpContainer $context $script:container
    $script:mountDetails.mounts[0].RW=$true
    Fails { Assert-LocalMcpContainer $context $script:container } 'mount identity'
    $script:mountDetails.mounts[0].RW=$false
    $script:mountDetails.user='0:0'
    Fails { Assert-LocalMcpContainer $context $script:container } 'user/network'
    $script:mountDetails.user='1000:1000';$script:mountDetails.ports['8000/tcp'][0].HostIp='0.0.0.0'
    Fails { Assert-LocalMcpContainer $context $script:container } 'user/network'
    $context.McpConfigInput=Join-Path $root 'mcp-config.json'
    $input=$mcp.Clone();$input.untrusted='value'
    Write-LocalText $context.McpConfigInput ($input | ConvertTo-Json)
    Fails { Get-LocalMcpPlan $context $settings @($profile) } 'Unknown MCP'
    $input.Remove('untrusted')
    Write-LocalText $context.McpConfigInput ($input | ConvertTo-Json)
    Assert ((Get-LocalMcpPlan $context $settings @($profile)).Settings.publicUrl -ceq $mcp.publicUrl) 'Explicit setup/edit config did not retain the exact MCP resource.'
    $bad=$mcp.Clone();$bad.clientId='*'
    Fails { Assert-LocalMcpSettings $bad 14391 } 'exact lowercase GUIDs'

    $script:volume=$false
    $unbound=$profile.Clone();$unbound.Remove('integration')
    $other=@{tenantId='44444444-4444-4444-4444-444444444444';clientId='55555555-5555-5555-5555-555555555555';clientSecret='synthetic-other-api-secret';domains=@('other.invalid')}
    $wizard=New-McpSetupFixture 'wizard' @($profile,$other)
    Set-SetupAnswers
    Save-LocalConfiguration $wizard (Read-LocalConfiguration $wizard $false -Onboard)
    $wizard.ConfigureMcp=$true
    $wizardClient='66666666-6666-6666-6666-666666666666'
    $wizardSecret='synthetic-new-mcp-credential'
    Set-SetupAnswers @('2',$wizardClient,$mcp.publicUrl,'https://client.example.test/callback,http://127.0.0.1:8585/oauth/callback','') @($wizardSecret)
    $setup=Read-LocalConfiguration $wizard $true -Edit
    Assert ($setup.McpPlan.Settings.tenantId -ceq $other.tenantId -and $setup.McpPlan.Settings.apiClientId -ceq $other.clientId) 'Wizard selected the wrong API tenant profile.'
    Assert ($setup.McpPlan.Settings.port -eq 8002) 'Wizard default conflicts with the API port.'
    Assert ($setup.McpPlan.Settings.redirectUris.Count -eq 2) 'Wizard lost an exact client callback.'
    Assert ($setup.RegistryChanged -and $setup.IdentityChanged -and $setup.SettingsChanged -and -not $setup.ApplicationSettingsChanged) 'Integration binding was added after metadata/change detection.'
    Assert ($setup.Profiles[0].integration.clientId -ceq $profile.integration.clientId -and $setup.Profiles[1].integration.clientId -ceq $wizardClient) 'Wizard overwrote another tenant integration.'
    Assert ($setup.Profiles[1].integration.audience -ceq $other.clientId -and $setup.Profiles[1].integration.scope -ceq 'AgentControl.Access') 'Wizard broadened API audience or scope.'
    Assert ($script:prompts.Count -eq 6 -and @($script:prompts | Where-Object secure).Count -eq 1 -and $script:prompts[-1].text.StartsWith('MCP Entra client secret')) 'Wizard exposed a credential or re-prompted for API secrets.'
    foreach ($name in @('mcp-client','mcp-signing','mcp-encryption')) {
        Assert (-not (Test-Path -LiteralPath (Join-Path $wizard.State "secrets/$name"))) 'Planning persisted MCP secrets before successful validation.'
    }
    $generatedSigning=$setup.McpPlan.SecretValues['mcp-signing']
    $generatedEncryption=@(ConvertFrom-Json -InputObject $setup.McpPlan.SecretValues['mcp-encryption'])
    Assert-LocalMcpKey $generatedSigning
    Assert-LocalMcpKey $generatedEncryption[0]
    Assert ($generatedEncryption.Count -eq 1 -and $generatedSigning -cne $generatedEncryption[0] -and $generatedSigning -cne $wizardSecret) 'First setup reused secret/key material.'
    Save-LocalConfiguration $wizard $setup
    Assert ((Test-Path -LiteralPath (Join-Path $wizard.State 'control/reauthenticate')) -and
        @($script:calls | Where-Object { $_ -match '\|stop\|--timeout\|130\|app$' }).Count -eq 1) 'First integration binding did not drain the retained API and invalidate old sessions.'
    $saved=Read-LocalSettings $wizard.State
    $savedProfiles=ConvertFrom-DeploymentTenantRegistry ([IO.File]::ReadAllText((Join-Path $wizard.State 'secrets/tenants.json')))
    Assert (($saved.tenants | ConvertTo-Json -Depth 20 -Compress) -ceq ((Get-LocalTenantMetadata $savedProfiles) | ConvertTo-Json -Depth 20 -Compress)) 'Protected API binding and saved metadata disagree after wizard save.'
    $times=@{}
    foreach ($name in @('mcp-client','mcp-signing','mcp-encryption')) {
        $path=Join-Path $wizard.State "secrets/$name"
        $times[$name]=(Get-Item -LiteralPath $path).LastWriteTimeUtc.Ticks
        if (-not $IsWindows) { Assert ([int][IO.File]::GetUnixFileMode($path) -eq 384) 'Generated secret is not 0600.' }
        foreach ($file in @('settings.json','compose.env')) {
            Assert (-not [IO.File]::ReadAllText((Join-Path $wizard.State $file)).Contains($setup.McpPlan.SecretValues[$name])) 'Wizard leaked secret material into public metadata/environment.'
        }
    }
    if (-not $IsWindows) { Assert ([int][IO.File]::GetUnixFileMode((Join-Path $wizard.State 'secrets')) -eq 448) 'Generated secret directory is not 0700.' }
    Set-SetupAnswers @('','','','','') @('')
    $unchanged=Read-LocalConfiguration $wizard $true -Edit
    Assert (-not $unchanged.RegistryChanged -and -not $unchanged.IdentityChanged -and -not $unchanged.SettingsChanged -and -not $unchanged.McpPlan.SecretsChanged) 'Enter-to-keep changed existing MCP authority.'
    Save-LocalConfiguration $wizard $unchanged
    foreach ($name in $times.Keys) {
        Assert ((Get-Item -LiteralPath (Join-Path $wizard.State "secrets/$name")).LastWriteTimeUtc.Ticks -eq $times[$name]) 'Unchanged wizard replaced a secret inode.'
    }
    Set-SetupAnswers @('','','','','') @('synthetic-rotated-mcp-credential')
    $rotation=Read-LocalConfiguration $wizard $true -Edit
    Assert ($rotation.McpPlan.SecretsChanged -and -not $rotation.SettingsChanged -and -not $rotation.RegistryChanged) 'Credential rotation was not identified independently.'
    $messages=@(Save-LocalConfiguration $wizard $rotation 6>&1)
    Assert (($messages -join "`n") -match 'Configuration saved') 'Successful credential rotation was reported unchanged.'
    Assert ([IO.File]::ReadAllText((Join-Path $wizard.State 'secrets/mcp-signing')) -ceq $generatedSigning -and
        [IO.File]::ReadAllText((Join-Path $wizard.State 'secrets/mcp-encryption')) -ceq $setup.McpPlan.SecretValues['mcp-encryption']) 'Credential rotation replaced internal OAuth keys.'
    Set-SetupAnswers @('','','','https://client.example.test/callback,http://127.0.0.1:8585/oauth/callback,http://127.0.0.1:53110/','') @('')
    $callbackEdit=Read-LocalConfiguration $wizard $true -Edit
    Assert ($callbackEdit.SettingsChanged -and -not $callbackEdit.RegistryChanged -and -not $callbackEdit.ApplicationSettingsChanged) 'MCP callback edit changed API configuration.'
    $before=$script:calls.Count
    Save-LocalConfiguration $wizard $callbackEdit
    Assert ($script:calls.Count -eq $before) 'MCP-only callback edit drained or restarted the API.'

    $wizard.ConfigureMcp=$false
    Set-SetupAnswers
    $ordinary=Read-LocalConfiguration $wizard $false -Onboard
    Assert (-not $ordinary.SettingsChanged -and -not $ordinary.McpPlan.SecretsChanged -and $script:prompts.Count -eq 0) 'Saved MCP requires wizard prompts on ordinary start.'
    Remove-Item -LiteralPath (Join-Path $wizard.State 'secrets/mcp-client')
    Fails { Read-LocalConfiguration $wizard $false -Onboard } 'credential is missing'
    $wizard.ConfigureMcp=$true
    Set-SetupAnswers @('','','','','') @($wizardSecret)
    $restoreCredential=Read-LocalConfiguration $wizard $false -Edit
    Save-LocalConfiguration $wizard $restoreCredential
    Assert ($restoreCredential.McpPlan.SecretValues['mcp-signing'] -ceq $generatedSigning) 'Credential recovery regenerated signing authority.'
    foreach ($keyName in @('mcp-signing','mcp-encryption')) {
        $keyPath=Join-Path $wizard.State "secrets/$keyName"
        $original=[IO.File]::ReadAllText($keyPath)
        Remove-Item -LiteralPath $keyPath
        Set-SetupAnswers @('','','','','')
        Fails { Read-LocalConfiguration $wizard $false -Edit } 'keys are not regenerated'
        Assert (-not (Test-Path -LiteralPath $keyPath)) 'Wizard silently regenerated a missing existing key.'
        Write-LocalText $keyPath $original
        Write-LocalText $keyPath 'corrupt-synthetic-key'
        Set-SetupAnswers @('','','','','') @('')
        Fails { Read-LocalConfiguration $wizard $false -Edit } 'MCP keys|JSON array'
        Assert ([IO.File]::ReadAllText($keyPath) -ceq 'corrupt-synthetic-key') 'Wizard replaced corrupt retained key material.'
        Write-LocalText $keyPath $original
    }
    $disabled=New-McpSetupFixture 'disabled' @($unbound)
    Set-SetupAnswers
    $before=$script:calls.Count
    $withoutMcp=Read-LocalConfiguration $disabled $false -Onboard
    Assert (-not $withoutMcp.McpPlan -and $script:prompts.Count -eq 0 -and $script:calls.Count -eq $before) 'Optional absence invoked MCP setup or Docker.'
    Assert (-not $withoutMcp.Profiles[0].integration -and -not (Test-Path -LiteralPath (Join-Path $disabled.State 'secrets/mcp-signing'))) 'Ordinary API setup enabled MCP.'

    $import=New-McpSetupFixture 'metadata-import' @($unbound) 14391
    $import.McpConfigInput=Join-Path $repository 'mcp/examples/local-settings.example.json'
    Set-SetupAnswers -Secrets @('synthetic-import-mcp-credential')
    $imported=Read-LocalConfiguration $import $false -Onboard
    Assert ($imported.RegistryChanged -and $imported.McpPlan.Settings.clientId -ceq $mcp.clientId -and $script:prompts.Count -eq 1 -and $script:prompts[0].secure) 'Metadata-only sample did not configure integration and prompt only for the secret.'
    Assert ($imported.McpPlan.SecretValues['mcp-signing'] -cne $generatedSigning -and
        $imported.McpPlan.SecretValues['mcp-encryption'] -cne $setup.McpPlan.SecretValues['mcp-encryption']) 'Independent first setups reused generated keys.'
    Save-LocalConfiguration $import $imported
    Set-SetupAnswers
    Assert (-not (Read-LocalConfiguration $import $false -Onboard).McpPlan.SecretsChanged) 'Reimporting metadata did not retain saved keys/credential.'

    foreach ($receiptName in @('mcp-storage.json','mcp-deployment.json','mcp-operation.json')) {
        $retained=New-McpSetupFixture ($receiptName -replace '\.','-') @($unbound) 14391
        $retained.McpConfigInput=$import.McpConfigInput
        Write-LocalText (Join-Path $retained.State $receiptName) '{}'
        Set-SetupAnswers
        Fails { Read-LocalConfiguration $retained $false -Onboard } 'keys are not regenerated'
        Assert (-not (Test-Path -LiteralPath (Join-Path $retained.State 'secrets/mcp-signing'))) 'Retained operation metadata allowed new keys.'
    }
    $orphan=New-McpSetupFixture 'orphan-oauth-volume' @($unbound) 14391
    $orphan.McpConfigInput=$import.McpConfigInput
    $script:volume=$true
    Fails { Read-LocalConfiguration $orphan $false -Onboard } 'existing MCP OAuth volume'
    $script:volume=$false
    Assert (-not (Test-Path -LiteralPath (Join-Path $orphan.State 'secrets/mcp-signing'))) 'Lost metadata orphaned an OAuth volume behind newly generated keys.'

    $advanced=New-McpSetupFixture 'advanced-import' @($unbound) 14391
    $advanced.McpConfigInput=Join-Path $advanced.Root 'private-import.json'
    $advancedInput=$mcp.Clone()
    $advancedInput.clientSecretFile=Join-Path $import.State 'secrets/mcp-client'
    $advancedInput.signingKeyFile=Join-Path $import.State 'secrets/mcp-signing'
    $advancedInput.encryptionKeyFile=Join-Path $import.State 'secrets/mcp-encryption'
    Write-LocalText $advanced.McpConfigInput ($advancedInput | ConvertTo-Json)
    Set-SetupAnswers
    $explicit=Read-LocalConfiguration $advanced $false -Onboard
    Assert ($script:prompts.Count -eq 0 -and $explicit.McpPlan.SecretValues['mcp-signing'] -ceq $imported.McpPlan.SecretValues['mcp-signing']) 'Protected-file import unexpectedly prompted or generated replacement keys.'
    $advancedInput.signingKeyFile=Join-Path $advanced.Root 'missing-key'
    Write-LocalText $advanced.McpConfigInput ($advancedInput | ConvertTo-Json)
    Fails { Read-LocalConfiguration $advanced $false -Onboard } 'existing absolute'
    $invalidValues=@{'mcp-client'=(([string][char]0x4E00)*3000);'mcp-signing'=$signing;'mcp-encryption'=(ConvertTo-Json -InputObject @($encryption) -Compress)}
    Fails { Assert-LocalMcpSecretValues $invalidValues } '8192 UTF-8 bytes'
    Fails { Assert-LocalMcpSecretValues $imported.McpPlan.SecretValues -ApiSecrets @($imported.McpPlan.SecretValues['mcp-client']) } 'must not reuse an API'

    $firstRun=New-McpSetupFixture 'first-run' @($unbound)
    Remove-Item -LiteralPath (Join-Path $firstRun.State 'settings.json')
    Remove-Item -LiteralPath (Join-Path $firstRun.State 'secrets/tenants.json')
    $firstRun.ConfigureMcp=$true
    Set-SetupAnswers @($mcp.tenantId,$mcp.apiClientId,'example.invalid','8001','',$mcp.clientId,$mcp.publicUrl,'https://client.example.test/callback','') @('synthetic-first-api-credential','synthetic-first-mcp-credential')
    $firstPlan=Read-LocalConfiguration $firstRun $false -Onboard
    Assert ($firstPlan.Port -eq 8001 -and $firstPlan.McpPlan.Settings.port -eq 8002 -and 8001 -in $script:portChecks) 'Combined first-run wizard lost API port validation or MCP port separation.'
    Assert ($firstPlan.Profiles[0].clientSecret -ceq 'synthetic-first-api-credential' -and
        $firstPlan.McpPlan.SecretValues['mcp-client'] -ceq 'synthetic-first-mcp-credential') 'Combined wizard copied the API credential into MCP.'
    Assert (@($script:prompts | Where-Object secure).Count -eq 2 -and $script:textAnswers.Count -eq 0 -and $script:secretAnswers.Count -eq 0) 'Combined first-run wizard did not consume the expected API/MCP prompts.'
    Save-LocalConfiguration $firstRun $firstPlan
    $firstRun.ConfigureMcp=$false
    Set-SetupAnswers
    $nextStart=Read-LocalConfiguration $firstRun $true -Onboard
    Assert (-not $nextStart.RegistryChanged -and -not $nextStart.SettingsChanged -and -not $nextStart.McpPlan.SecretsChanged -and $script:prompts.Count -eq 0) 'Ordinary start cannot reuse complete first-run wizard configuration.'
    $hostExecutable=(Get-Command pwsh -CommandType Application).Source
    foreach ($case in @(
        @{arguments=@('check','-ConfigureMcp');pattern='-ConfigureMcp is supported only with start'},
        @{arguments=@('stop','-ConfigureMcp');pattern='-ConfigureMcp is supported only with start'},
        @{arguments=@('start','-ConfigureMcp','-Candidate','unread-candidate.json');pattern='Configure MCP before preparing'}
    )) {
        $caseArguments=$case.arguments
        $messages=@(& $hostExecutable -NoLogo -NoProfile -File (Join-Path $repository 'deploy-local.ps1') @caseArguments 2>&1)
        Assert ($LASTEXITCODE -eq 1) 'CLI accepted an unsupported MCP setup operation.'
        Assert (($messages -join "`n") -match $case.pattern) "CLI guard diagnostic differs: $($messages -join "`n")"
    }
    Write-Host "Passed $script:checks MCP setup/lifecycle assertions (mocked Docker; no deployment)."
} finally {
    Remove-Item Env:MCP_PUBLIC_URL -ErrorAction SilentlyContinue
    Remove-Item Env:MCP_CLIENT_SECRET_FILE -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force
}
