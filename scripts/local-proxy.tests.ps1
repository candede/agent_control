#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
$repository = Split-Path $PSScriptRoot -Parent
$root = Join-Path $repository "artifacts/test-scratch/proxy-$([Guid]::NewGuid().ToString('N'))"
$script:checks = 0
$script:calls = [Collections.Generic.List[string]]::new()
$script:missing = $false
$script:missingNetworkName = ''
$script:endpoint = $null
$script:network = @{
    Name='agent-control-local-ingress'; Id=('a'*64); Driver='bridge'; Scope='local'
    Internal=$false; Ingress=$false; ConfigOnly=$false; Containers=@{}; Options=@{}
    Labels=@{'io.shared-proxy.managed'='true';'io.shared-proxy.instance'='independent-edge';'io.shared-proxy.owner'='/another/infrastructure'}
}
$realDocker = ${function:Invoke-DockerCommand}
function Assert($Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:checks++ }
function Fails([scriptblock]$Action,[string]$Pattern) {
    try { & $Action; throw 'Expected failure did not occur.' }
    catch { Assert ($_.Exception.Message -match $Pattern) "Unexpected failure: $($_.Exception.Message)" }
}
function Read-Host { throw 'Saved configured ingress must not prompt.' }
function Invoke-DockerCommand {
    param([string[]]$Arguments,[switch]$Capture,[switch]$CaptureError)
    $script:calls.Add(($Arguments -join '|'))
    if ($Arguments[0] -eq 'network' -and $Arguments[1] -eq 'inspect') {
        if ($script:missing -or $Arguments[-1] -ceq $script:missingNetworkName) { throw 'synthetic missing network' }
        return $script:network | ConvertTo-Json -Depth 10 -Compress
    }
    if ($Arguments[0] -eq 'volume' -and $Arguments[1] -eq 'ls') { return $context.Volume }
    if ($Arguments[0] -eq 'ps') { return '' }
    if ($Arguments[0] -eq 'inspect') { return $script:endpoint | ConvertTo-Json -Depth 10 -Compress }
    if ($Arguments[0] -eq 'compose' -and $Arguments -contains 'config') { return & $realDocker @PSBoundParameters }
    throw "Unexpected Docker operation in code-only test: $($Arguments[0])"
}
try {
    [IO.Directory]::CreateDirectory($root) | Out-Null
    foreach ($file in @('compose.yaml','compose.mcp.yaml','compose.mcp-metadata.yaml','compose.proxy.yaml','compose.mcp-proxy.yaml','Dockerfile')) {
        Copy-Item -LiteralPath (Join-Path $repository $file) -Destination (Join-Path $root $file)
    }
    $context = New-LocalContext $root 'proxy-test'
    [IO.Directory]::CreateDirectory((Join-Path $context.State 'secrets')) | Out-Null
    $profiles = @(@{tenantId='11111111-1111-4111-8111-111111111111';clientId='22222222-2222-4222-8222-222222222222'
        clientSecret='synthetic-proxy-client-secret';domains=@('example.invalid')})
    & {
        $answers = [Collections.Generic.Queue[string]]::new()
        foreach ($answer in @($profiles[0].tenantId,$profiles[0].clientId,$profiles[0].clientSecret,'example.invalid','14433')) {
            $answers.Enqueue($answer)
        }
        function Read-Host {
            param([string]$Prompt,[switch]$AsSecureString)
            if (-not $answers.Count) { throw 'Unexpected first-run prompt.' }
            $answer = $answers.Dequeue()
            if ($AsSecureString) { return ConvertTo-SecureString $answer -AsPlainText -Force }
            return $answer
        }
        $onboarding = New-LocalContext $root 'proxy-first-run'
        $onboarding.PublicUrlInput = 'https://first-run.example.invalid'
        $onboarding.ProxyNetworkInput = $script:network.Name
        $output = @(Read-LocalConfiguration $onboarding $false -Onboard 6>&1)
        $registration = @($output | Where-Object {
            $_ -is [Management.Automation.InformationRecord] -and $_.ToString().StartsWith('Register ')
        })
        Assert ($registration.Count -eq 1 -and $registration[0].ToString() -ceq
            "Register $($onboarding.PublicUrlInput)/api/auth/callback as every configured application's Web reply URL. Begin sign-in at $($onboarding.PublicUrlInput).") 'First-run callback guidance ignored the supplied public URL.'
        $plan = @($output | Where-Object { $_ -is [Collections.IDictionary] })[0]
        Assert ($plan.PublicUrl -ceq $onboarding.PublicUrlInput -and $plan.Settings.proxyNetwork -ceq $script:network.Name) 'First-run ingress planning changed the supplied origin or network.'
        Assert ($answers.Count -eq 0 -and -not (Test-Path -LiteralPath $onboarding.State)) 'First-run planning left prompts unanswered or wrote project state.'
        Save-LocalConfiguration $onboarding $plan
        $environment = [IO.File]::ReadAllText((Join-Path $onboarding.State 'compose.env'))
        foreach ($line in @("FRONTEND_ORIGIN=$($onboarding.PublicUrlInput)",
            "REDIRECT_URI=$($onboarding.PublicUrlInput)/api/auth/callback",'TRUST_PROXY=1')) {
            Assert ($environment.Contains($line)) 'First-run saved configuration disagreed with its registration guidance.'
        }
        $reloaded = New-LocalContext $root $onboarding.Project
        $reused = Read-LocalConfiguration $reloaded $true -Onboard
        Assert ($reused.PublicUrl -ceq $onboarding.PublicUrlInput -and -not $reused.SettingsChanged -and
            -not $reused.RegistryChanged) 'Configured ingress did not reuse first-run settings without prompting.'
    }
    $settings = [ordered]@{port=14431;publicUrl='https://existing.example.invalid';tenants=(Get-LocalTenantMetadata $profiles)}
    Write-LocalText (Join-Path $context.State 'settings.json') ($settings | ConvertTo-Json -Depth 10)
    Write-LocalText (Join-Path $context.State 'secrets/tenants.json') (ConvertTo-Json -InputObject $profiles -Depth 10)
    Initialize-LocalState $context $false
    $context = New-LocalContext $root 'proxy-test'
    Assert (-not $context.ProxyNetwork -and $context.Compose -notcontains (Join-Path $root 'compose.proxy.yaml')) 'Standalone was not the default.'
    $hashes = @{}
    foreach ($file in @('secrets/postgres-admin','secrets/postgres-app','secrets/session','secrets/tenants.json')) {
        $hashes[$file] = (Get-FileHash -LiteralPath (Join-Path $context.State $file)).Hash
    }
    $before = [IO.File]::ReadAllText((Join-Path $context.State 'settings.json'))
    $context.ProxyNetworkInput = $script:network.Name
    $plan = Read-LocalConfiguration $context $true -Onboard
    $editPlan = Read-LocalConfiguration $context $true -Edit
    Assert ($editPlan.Settings.proxyNetwork -ceq $script:network.Name) 'Ingress-only edit required the unrelated tenant wizard.'
    Assert ([IO.File]::ReadAllText((Join-Path $context.State 'settings.json')) -ceq $before) 'Planning ingress changed saved configuration.'
    Assert ($plan.PublicUrl -ceq $settings.publicUrl -and $plan.ApplicationSettingsChanged) 'Ingress did not reuse the saved public origin.'
    Save-LocalConfiguration $context $plan
    $context = New-LocalContext $root 'proxy-test'
    Assert ($context.ProxyNetwork -ceq $script:network.Name) 'Shared ingress was not persisted/reloaded.'
    $environment = [IO.File]::ReadAllText((Join-Path $context.State 'compose.env'))
    foreach ($line in @("PROXY_NETWORK=$($script:network.Name)","FRONTEND_ORIGIN=$($settings.publicUrl)",
        "REDIRECT_URI=$($settings.publicUrl)/api/auth/callback",'TRUST_PROXY=1','APP_PORT=14431')) {
        Assert ($environment.Contains($line)) "Generated environment omitted $line."
    }
    foreach ($file in $hashes.Keys) {
        Assert ((Get-FileHash -LiteralPath (Join-Path $context.State $file)).Hash -ceq $hashes[$file]) 'Ingress rotated protected credentials.'
    }
    $settingsHash = (Get-FileHash -LiteralPath (Join-Path $context.State 'settings.json')).Hash
    Initialize-LocalState $context $true -Onboard
    Assert ((Get-FileHash -LiteralPath (Join-Path $context.State 'settings.json')).Hash -ceq $settingsHash) 'Unchanged ingress rewrote saved settings.'
    foreach ($value in @('bridge','host','none','../escape',"bad`nname",'bad/name','-option',('a'*64),42,$null)) {
        Assert (-not (Test-LocalProxyNetworkName $value)) 'Unsafe network name was accepted.'
    }
    Fails { Assert-LocalProxyNetwork $context $context.Network } 'project-private'
    $script:missing = $true
    Fails { Read-LocalConfiguration $context $true -Onboard } 'must create it first'
    $script:missing = $false
    & {
        function New-LocalBuildSnapshot { throw 'synthetic stop after ingress planning' }
        $savedNetwork = $script:network
        $script:missingNetworkName = $context.ProxyNetwork
        $settingsHash = (Get-FileHash -LiteralPath (Join-Path $context.State 'settings.json')).Hash
        try {
            foreach ($target in @('none','replacement-ingress')) {
                $recovery = New-LocalContext $root $context.Project
                $recovery.ProxyNetworkInput = $target
                $recovery.PublicUrlInput = if ($target -ceq 'none') { 'local' } else { $settings.publicUrl }
                $script:network = $savedNetwork.Clone()
                if ($target -cne 'none') { $script:network.Name = $target }
                $beforeCalls = $script:calls.Count
                Fails { Invoke-LocalApplication $recovery } 'synthetic stop after ingress planning'
                Assert ($recovery.ProxyNetwork -ceq $(if ($target -ceq 'none') { '' } else { $target })) 'Startup ignored the explicit replacement ingress configuration.'
                Assert (-not @($script:calls | Select-Object -Skip $beforeCalls | Where-Object {
                    $_ -ceq "network|inspect|--format|{{json .}}|$script:missingNetworkName"
                }).Count) 'Replacing ingress still required the missing previous network.'
            }
            $recovery = New-LocalContext $root $context.Project
            $recovery.ProxyNetworkInput = 'replacement-ingress'
            $script:missing = $true
            Fails { Invoke-LocalApplication $recovery } 'must create it first'
            Assert ((Get-FileHash -LiteralPath (Join-Path $context.State 'settings.json')).Hash -ceq $settingsHash) 'Interrupted ingress planning wrote saved configuration.'
        } finally {
            $script:missing = $false
            $script:missingNetworkName = ''
            $script:network = $savedNetwork
        }
    }
    foreach ($change in @(@{Driver='overlay'},@{Scope='swarm'},@{Internal=$true},@{Ingress=$true},@{ConfigOnly=$true},
        @{Labels=@{}},@{Labels=@{'io.shared-proxy.managed'='false'}},
        @{Options=@{'com.docker.network.bridge.default_bridge'='true'}},
        @{Options=@{'com.docker.network.bridge.enable_icc'='false'}})) {
        $saved = $script:network
        $script:network = $saved.Clone()
        foreach ($key in $change.Keys) { $script:network[$key]=$change[$key] }
        Fails { Assert-LocalProxyNetwork $context $context.ProxyNetwork } 'foreign or unsafe'
        $script:network = $saved
    }
    $script:network.Labels['com.docker.compose.project']='foreign-edge'
    Fails { Assert-LocalProxyNetwork $context $context.ProxyNetwork } 'foreign or unsafe'
    $script:network.Labels.Remove('com.docker.compose.project')
    Assert-LocalIngressReady $context
    $script:network.Id='b'*64
    Fails { Assert-LocalIngressReady $context } 'identity changed'
    $script:network.Id='a'*64
    $private = @{$context.Network=@{}}
    $joined = @{$context.Network=@{};$context.ProxyNetwork=@{Aliases=@('proxy-test-app')}}
    Assert-LocalContainerNetworks $context $joined 'app'
    Fails { Assert-LocalContainerNetworks $context $private 'app' } 'differs from saved'
    Fails { Assert-LocalContainerNetworks $context $joined 'postgres' } 'never join'
    Fails { Assert-LocalContainerNetworks $context @{$context.ProxyNetwork=@{}} 'app' } 'retain'
    $joined[$context.ProxyNetwork].Aliases=@('foreign-app')
    Fails { Assert-LocalContainerNetworks $context $joined 'app' } 'project-derived'
    $joined[$context.ProxyNetwork].Aliases=@('proxy-test-mcp')
    Assert-LocalContainerNetworks $context $joined 'mcp' -AllowRetainedIngress
    Assert-LocalContainerNetworks $context $private 'mcp' -AllowRetainedIngress
    $script:network.Containers=@{('c'*64)=@{}}
    $script:endpoint=@{labels=@{'com.docker.compose.project'=$context.Project;'com.docker.compose.service'='postgres'};networks=@{}}
    Fails { Assert-LocalProxyNetwork $context $context.ProxyNetwork } 'already exposed'
    $script:endpoint=@{labels=@{'com.docker.compose.project'='foreign'};networks=@{$context.ProxyNetwork=@{Aliases=@('proxy-test-app')}}}
    Fails { Assert-LocalProxyNetwork $context $context.ProxyNetwork } 'another installation'
    $script:network.Containers=@{}
    $context.PublicUrlInput='http://unsafe.example.invalid'
    Fails { Read-LocalConfiguration $context $true -Onboard } 'canonical HTTPS'
    $context.PublicUrlInput='local'
    Fails { Read-LocalConfiguration $context $true -Onboard } 'requires a saved HTTPS'
    $context.PublicUrlInput='https://changed.example.invalid'
    $plan=Read-LocalConfiguration $context $true -Onboard
    Save-LocalConfiguration $context $plan
    Assert ($context.PublicUrl -ceq 'https://changed.example.invalid') 'Explicit public URL was not applied.'
    $context.Mcp=@{tenantId=$profiles[0].tenantId;clientId='33333333-3333-4333-8333-333333333333';apiClientId=$profiles[0].clientId
        publicUrl='https://mcp.example.invalid/mcp';redirectUris=@('https://client.example.invalid/callback');port=14432}
    Write-LocalComposeEnvironment $context
    $composeBefore=$context.Compose -join '|'
    Write-LocalComposeEnvironment $context
    Assert (($context.Compose -join '|') -ceq $composeBefore) 'Repeated synchronization duplicated/reordered Compose inputs.'
    $databaseCompose=@(Get-LocalDatabaseCompose $context.Compose)
    Assert (-not @($databaseCompose | Where-Object { $_ -match 'compose\.(mcp|proxy)' }).Count) 'Database bootstrap acquired shared ingress or uncommitted MCP configuration.'
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        $savedEnvironment=[Environment]::GetEnvironmentVariable('PROXY_NETWORK')
        try {
            $env:PROXY_NETWORK='foreign-shell-override'
            $config=Invoke-DockerCommand ($context.Compose + @('config','--format','json')) -Capture | ConvertFrom-Json -AsHashtable
            Assert ($config.networks.'shared-ingress'.external -eq $true -and $config.networks.'shared-ingress'.name -ceq $script:network.Name) 'Compose did not use the project-owned external network setting.'
            foreach ($service in @('app','mcp')) {
                Assert ($config.services[$service].networks.Count -eq 2 -and $config.services[$service].networks.Contains('default') -and
                    "proxy-test-$service" -cin $config.services[$service].networks.'shared-ingress'.aliases -and
                    "proxy-test-$service" -cin $config.services[$service].networks.default.aliases) 'Compose lost private networking or the project-derived ingress alias.'
            }
            Assert ($config.services.postgres.networks.Count -eq 1 -and $config.services.postgres.networks.Contains('default')) 'PostgreSQL joined ingress.'
            Assert ($config.services.app.ports[0].host_ip -ceq '127.0.0.1' -and $config.services.mcp.ports[0].host_ip -ceq '127.0.0.1') 'Shared ingress removed loopback diagnostics.'
            Assert ($config.services.app.environment.TRUST_PROXY -ceq '1' -and
                $config.services.app.environment.REDIRECT_URI -ceq 'https://changed.example.invalid/api/auth/callback') 'Compose changed callback/proxy trust.'
            Assert ($config.services.mcp.environment.MCP_API_ORIGIN -ceq 'http://proxy-test-app:3001' -and
                $config.services.app.environment.MCP_METADATA_ORIGIN -ceq 'http://proxy-test-mcp:8000' -and
                $config.services.mcp.environment.MCP_PUBLIC_URL -ceq $context.Mcp.publicUrl) 'Ingress lost unambiguous project-private MCP origins or changed public authentication.'
        } finally {
            if ($null -eq $savedEnvironment) { Remove-Item Env:PROXY_NETWORK }
            else { $env:PROXY_NETWORK=$savedEnvironment }
        }
    }
    $context.Mcp=$null
    $context.ProxyNetworkInput='none';$context.PublicUrlInput='local'
    $plan=Read-LocalConfiguration $context $true -Onboard
    Save-LocalConfiguration $context $plan
    Assert (-not $context.ProxyNetwork -and $context.PublicUrl -ceq $context.Url -and
        $context.Compose -notcontains (Join-Path $root 'compose.proxy.yaml')) 'Explicit standalone reset did not remove only ingress configuration.'
    Assert ([IO.File]::ReadAllText((Join-Path $context.State 'compose.env')).Contains('TRUST_PROXY=0')) 'Local public URL reset retained proxy trust.'
    Assert (-not @($script:calls | Where-Object { $_ -match '^network\|(create|rm|connect|disconnect)|\|(up|down|stop|reset)\|' }).Count) 'Code-only ingress configuration managed shared resources or the database.'
    $sources=@(Get-LocalSourceFiles $repository)
    foreach ($path in @('deploy-local.sh','scripts/local-launcher.Dockerfile','scripts/local-launcher-inputs.ps1','scripts/local-proxy.ps1','compose.proxy.yaml','compose.mcp-proxy.yaml')) {
        Assert ($path -cin $sources) "Source inventory omitted $path."
    }
    $hostExecutable = (Get-Command pwsh -CommandType Application | Select-Object -First 1).Source
    foreach ($arguments in @(
        @('stop','-ProxyNetwork','agent-control-local-ingress'),
        @('check','-PublicUrl','https://control.example.invalid'),
        @('start','-ProxyNetwork','agent-control-local-ingress','-Candidate','artifacts/not-a-candidate.json'),
        @('start','-PublicUrl','https://control.example.invalid','-ReadOnly')
    )) {
        $output = @(& $hostExecutable -NoLogo -NoProfile -File (Join-Path $repository 'deploy-local.ps1') @arguments 2>&1)
        Assert ($LASTEXITCODE -eq 1 -and ($output -join "`n") -match 'supported only|cannot change pinned configuration') 'Entry point failed to reject unsupported/pinned ingress changes before accessing Docker.'
    }
    Write-Host "Local shared ingress tests passed ($script:checks assertions; Docker Compose rendering only, no container changes)."
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
