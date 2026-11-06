#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
. (Join-Path $PSScriptRoot 'local-mcp-fixture.ps1')
$repository = Split-Path $PSScriptRoot -Parent
$root = Join-Path $repository "artifacts/test-scratch/mcp-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($root) | Out-Null
Copy-Item -LiteralPath (Join-Path $repository 'compose.yaml') -Destination $root
Copy-Item -LiteralPath (Join-Path $repository 'compose.mcp.yaml') -Destination $root
Copy-Item -LiteralPath (Join-Path $repository 'compose.mcp-metadata.yaml') -Destination $root
$script:checks = 0
$script:calls = [Collections.Generic.List[string]]::new()
$script:running = $false
$script:failStart = $false
$script:preserveMcpPort = $false
$script:mountDetails = $null
$script:ready = $true
$script:volume = $false
$script:recordingVolume = $false
$script:recordingVolumeOverrides = @{}
$script:endpoint = "unix://$HOME/.docker/run/docker.sock"
$script:image = 'sha256:' + ('a'*64)
$script:container = 'b'*64
$script:dependencyImage = 'sha256:' + ('c'*64)
$script:dependencyPlatform = 'linux/arm64'
$script:dependencyHashes = @{}
$script:dependencyInspectionFailure = $false
$script:changeDependencyDuringBuild = $false
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
    if ($Arguments[0] -eq 'image') {
        if ($Arguments[3] -ceq '{{.Os}}/{{.Architecture}}') { return $script:dependencyPlatform }
        return $script:dependencyImage
    }
    if ($Arguments[0] -eq 'run' -and $Arguments -contains '/opt/mcp/.venv/bin/python') {
        if ($script:dependencyInspectionFailure) { throw 'Installed MCP dependencies are inconsistent.' }
        return $script:dependencyHashes | ConvertTo-Json -Compress
    }
    if ($Arguments[0] -eq 'build') {
        $identityFile = $Arguments[[Array]::IndexOf($Arguments,'--iidfile')+1]
        [IO.File]::WriteAllText($identityFile,$script:image)
        if ($script:changeDependencyDuringBuild) { $script:dependencyImage='sha256:' + ('d'*64) }
        return
    }
    if ($Arguments[0] -eq 'context') {
        if ($Arguments[1] -eq 'show') { return 'desktop-linux' }
        return $script:endpoint
    }
    if ($Arguments[0] -eq 'volume') {
        if ($Arguments[1] -eq 'ls') {
            if ($script:volume) { $context.McpVolume }
            if ($script:recordingVolume) { $context.McpRecordingVolume }
            return
        }
        if ($Arguments[1] -eq 'create') {
            if ($Arguments[-1] -ceq $context.McpRecordingVolume) { $script:recordingVolume=$true;return $context.McpRecordingVolume }
            $script:volume=$true;return $context.McpVolume
        }
        if ($Arguments[1] -eq 'inspect') {
            if ($Arguments[-1] -ceq $context.McpRecordingVolume) {
                $details=@{name=$context.McpRecordingVolume;driver='local';labels=@{'com.docker.compose.project'=$context.Project;'com.docker.compose.volume'='mcp-recordings';'io.agent-control.purpose'='mcp-session-recordings'}}
                foreach ($key in $script:recordingVolumeOverrides.Keys) {
                    if ($key -cin @('name','driver')) { $details[$key]=$script:recordingVolumeOverrides[$key] }
                    else { $details.labels[$key]=$script:recordingVolumeOverrides[$key] }
                }
                return $details | ConvertTo-Json -Compress
            }
            return (@{name=$context.McpVolume;driver='local';createdAt='synthetic-created-at';labels=@{'com.docker.compose.project'=$context.Project;'com.docker.compose.volume'='mcp-oauth';'io.agent-control.purpose'='encrypted-oauth-state'}} | ConvertTo-Json -Compress)
        }
    }
    if ($Arguments[0] -eq 'inspect') { return $script:mountDetails | ConvertTo-Json -Depth 8 -Compress }
    if ($Arguments[0] -eq 'compose') {
        Assert (-not [Environment]::GetEnvironmentVariable('MCP_PUBLIC_URL')) 'Shell MCP configuration replaced project authority.'
        Assert (-not [Environment]::GetEnvironmentVariable('MCP_CLIENT_SECRET_FILE')) 'Shell MCP credentials replaced project secret mounts.'
        if ($script:failStart) { throw 'Simulated MCP start failure.' }
        $script:running=$true
        if ($script:mountDetails -and -not $script:preserveMcpPort) { $script:mountDetails.ports['8000/tcp'][0].HostPort=[string]$context.Mcp.port }
    }
}
function Get-OwnedLocalContainers {
    param($Context)
    if ($script:running) { @{Id=$script:container;Service='mcp';Image=$script:image;State=@{Running=$true;Health=@{Status=$(if ($script:ready) {'healthy'} else {'unhealthy'})}}} }
}
function New-McpSetupFixture {
    param([string]$Name,[object[]]$Profiles,[int]$Port=8001,[string]$Project='mcp-test')
    $directory = Join-Path $root $Name
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    foreach ($file in @('compose.yaml','compose.mcp.yaml','compose.mcp-metadata.yaml')) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $directory }
    $fixture = New-LocalContext $directory $Project
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
    if ($Text.Count) { foreach ($answer in @('','')) { $script:textAnswers.Enqueue($answer) } }
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
    Fails { Invoke-LocalMcpFixturePython 'mutable:tag' $root 'print(1)' } 'immutable built image'
    $before=$script:calls.Count
    Invoke-LocalMcpFixturePython $script:image $root 'print(1)' | Out-Null
    $pythonCall=$script:calls[-1]
    Assert ($script:calls.Count -eq $before + 3) 'Fixture Python did not verify its exact local engine.'
    Assert ($pythonCall.Contains('|--network|none|') -and $pythonCall.Contains('|--read-only|--cap-drop|ALL|')) 'Fixture Python lost network/filesystem isolation.'
    Assert ($pythonCall.Contains("|--mount|type=bind,source=$root,target=/work|--entrypoint|python|$script:image|-c|print(1)|/work")) 'Fixture Python did not use its immutable genuine container interpreter.'
    Assert (Test-LocalBindSource '/Users/fixture/key' '/Users/fixture/key') 'Exact bind source was refused.'
    Assert (-not (Test-LocalBindSource '/host_mnt/Users/other/key' '/Users/fixture/key')) 'Foreign mapped bind source was accepted.'
    if (-not $IsWindows) {
        Assert (Test-LocalBindSource '/host_mnt/Users/fixture/key' '/Users/fixture/key') 'Verified Docker Desktop mapping was refused.'
        $script:endpoint='ssh://remote.invalid'
        Assert (-not (Test-LocalBindSource '/host_mnt/Users/fixture/key' '/Users/fixture/key')) 'Remote daemon alias was accepted.'
        $script:endpoint="unix://$HOME/.docker/run/docker.sock"
    }
    $context = New-LocalContext $root 'mcp-test'
    $buildSource = Join-Path $root 'mcp'
    [IO.Directory]::CreateDirectory($buildSource) | Out-Null
    foreach ($path in @('pyproject.toml','uv.lock')) {
        Copy-Item -LiteralPath (Join-Path $repository "mcp/$path") -Destination $buildSource
        $script:dependencyHashes[$path]=(Get-FileHash (Join-Path $buildSource $path)).Hash.ToLowerInvariant()
    }
    $snapshot=@{Root=$root;Directory=$root}
    $context.SourceHash='e'*64
    $savedDependencyImage=[Environment]::GetEnvironmentVariable('AGENT_CONTROL_MCP_DEPENDENCY_IMAGE')
    try {
        Remove-Item Env:AGENT_CONTROL_MCP_DEPENDENCY_IMAGE -ErrorAction SilentlyContinue
        $script:calls.Clear()
        Assert ((Build-LocalMcpArtifact $context $snapshot) -ceq $script:image) 'MCP build did not return its immutable image.'
        $buildCall=@($script:calls | Where-Object { $_ -like 'build|*' })[0]
        Assert ($buildCall.Contains("|--label|io.agent-control.source-sha256=$($context.SourceHash)|") -and
            -not $buildCall.Contains('REUSE_INSTALLED_DEPENDENCIES') -and
            -not @($script:calls | Where-Object { $_ -like 'run|*' }).Count) 'Ordinary MCP build lost source provenance or inspected an unrequested dependency image.'
        $env:AGENT_CONTROL_MCP_DEPENDENCY_IMAGE='cached-mcp:test'
        $script:calls.Clear()
        Assert ((Build-LocalMcpArtifact $context $snapshot) -ceq $script:image) 'Offline MCP build failed.'
        $buildCall=@($script:calls | Where-Object { $_ -like 'build|*' })[0]
        $inspection=@($script:calls | Where-Object { $_ -like 'run|*' })[0]
        Assert ($buildCall.Contains('|--network|none|--platform|linux/arm64|--build-arg|MCP_DEPENDENCY_BASE=cached-mcp:test|--build-arg|REUSE_INSTALLED_DEPENDENCIES=1|') -and
            $context.McpDependencyImageId -ceq $script:dependencyImage -and $context.McpDependencyPlatform -ceq 'linux/arm64') 'Offline MCP build did not bind verified installed dependencies and platform.'
        Assert ($inspection.Contains("|--entrypoint|/opt/mcp/.venv/bin/python|$($script:dependencyImage)|") -and
            $inspection.Contains('|--network|none|--read-only|') -and
            $inspection.EndsWith('|runtime') -and -not $inspection.Contains('secrets/')) 'MCP dependency verification used a mutable image or production authority.'
        Assert (@($script:calls | Where-Object { $_ -like 'image|inspect|*' -and $_ -notlike '*{{.Os}}*' }).Count -eq 3) 'MCP dependency identity was not checked before and after the build.'
        $script:calls.Clear()
        Build-LocalMcpArtifact $context $snapshot -Target test | Out-Null
        Assert (@($script:calls | Where-Object { $_ -like 'run|*' })[0].EndsWith('|test')) 'MCP test builds did not require their development dependency layout.'
        foreach ($path in @('pyproject.toml','uv.lock')) {
            $expected=$script:dependencyHashes[$path]
            $script:dependencyHashes[$path]='f'*64
            $script:calls.Clear()
            Fails { Build-LocalMcpArtifact $context $snapshot } 'dependency manifests differ'
            Assert (-not @($script:calls | Where-Object { $_ -like 'build|*' }).Count) 'Mismatched MCP dependencies reached the build.'
            $script:dependencyHashes[$path]=$expected
        }
        $script:dependencyHashes['unexpected']='f'*64
        Fails { Build-LocalMcpArtifact $context $snapshot } 'manifest inventory'
        $script:dependencyHashes.Remove('unexpected')
        $script:dependencyInspectionFailure=$true
        $script:calls.Clear()
        Fails { Build-LocalMcpArtifact $context $snapshot } 'dependencies are inconsistent'
        Assert (-not @($script:calls | Where-Object { $_ -like 'build|*' }).Count) 'Invalid Python/dependency layout reached the build.'
        $script:dependencyInspectionFailure=$false
        $script:changeDependencyDuringBuild=$true
        Fails { Build-LocalMcpArtifact $context $snapshot } 'dependency image changed'
        $script:changeDependencyDuringBuild=$false
        $script:dependencyImage='invalid-image-identity'
        Fails { Build-LocalMcpArtifact $context $snapshot } 'dependency image identity'
        $script:dependencyImage='sha256:' + ('c'*64)
        $script:dependencyPlatform='windows/amd64'
        Fails { Build-LocalMcpArtifact $context $snapshot } 'dependency image platform'
        $script:dependencyPlatform='linux/arm64'
        $env:AGENT_CONTROL_MCP_DEPENDENCY_IMAGE="invalid`nreference"
        $script:calls.Clear()
        Fails { Build-LocalMcpArtifact $context $snapshot } 'dependency image reference'
        Assert ($script:calls.Count -eq 0) 'Invalid MCP image reference reached Docker.'
    } finally {
        if ($null -eq $savedDependencyImage) { Remove-Item Env:AGENT_CONTROL_MCP_DEPENDENCY_IMAGE -ErrorAction SilentlyContinue }
        else { $env:AGENT_CONTROL_MCP_DEPENDENCY_IMAGE=$savedDependencyImage }
        $script:dependencyInspectionFailure=$false
        $script:changeDependencyDuringBuild=$false
    }
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
    foreach ($name in @('hide_employee_details','hide_champion_employee')) {
        foreach ($value in @($null,'true',0,1)) {
            $invalid=$mcp.Clone();$invalid[$name]=$value
            Fails { Assert-LocalMcpSettings $invalid 14391 } 'must be a boolean'
        }
    }
    foreach ($name in @('tenantId','clientId','apiClientId','publicUrl','redirectUris','port')) {
        $bad=$mcp.Clone();$bad.Remove($name)
        Fails { Assert-LocalMcpSettings $bad 14391 } 'configuration'
    }
    foreach ($name in @('tenantId','clientId','apiClientId')) {
        foreach ($suffix in @("`n","`r`n",' ',"`0")) {
            $bad=$mcp.Clone();$bad[$name]=$mcp[$name]+$suffix
            Fails { Assert-LocalMcpSettings $bad 14391 } 'exact lowercase GUIDs'
        }
    }
    foreach ($url in @('http://mcp.example.test/mcp','https://mcp.example.test/mcp/','https://mcp.example.test/mcp*','https://mcp.example.test/internal/mcp-metadata','https://mcp.example.test/mcp?tenant=x','https://mcp.example.test/mcp#x','https://mcp.example.test','https://MCP.example.test/mcp')) {
        $bad=$mcp.Clone();$bad.publicUrl=$url
        Fails { Assert-LocalMcpSettings $bad 14391 } 'publicUrl'
    }
    foreach ($value in @($null,0,14391,65536,'14392')) {
        $bad=$mcp.Clone();$bad.port=$value
        Fails { Assert-LocalMcpSettings $bad 14391 } 'loopback port'
    }
    foreach ($callback in @('https://*.example.test/callback','http://remote.example.test/callback','https://client.example.test/callback?x=1',
        'https://client.example.test/a//callback','https://client.example.test:0/callback','http://127.0.0.1:0/callback')) {
        $bad=$mcp.Clone();$bad.redirectUris=@($callback)
        Fails { Assert-LocalMcpSettings $bad 14391 } 'callbacks'
    }
    foreach ($callback in @('http://127.0.0.1:53110/','http://127.0.0.1:19876/mcp/oauth/callback','https://client.example.test/',
        'https://client.example.test:1/callback','http://[::1]:65535/callback')) {
        $native=$mcp.Clone();$native.redirectUris=@($callback)
        Assert-LocalMcpSettings $native 14391
        Assert ($native.redirectUris[0] -ceq $callback) 'Exact native callback was changed.'
    }
    foreach ($field in @('publicUrl','redirectUris')) {
        $prefix = if ($field -eq 'publicUrl') { 'https://mcp.example.test/' } else { 'https://client.example.test/' }
        $boundary = $prefix + ('a'*(2048-$prefix.Length))
        $bounded=$mcp.Clone()
        if ($field -eq 'publicUrl') { $bounded.publicUrl=$boundary } else { $bounded.redirectUris=@($boundary) }
        Assert-LocalMcpSettings $bounded 14391
        if ($field -eq 'publicUrl') { $bounded.publicUrl=$boundary+'a' } else { $bounded.redirectUris=@($boundary+'a') }
        Fails { Assert-LocalMcpSettings $bounded 14391 } '2048 characters'
    }
    $exactCallbacks=$mcp.Clone()
    $exactCallbacks.redirectUris=@('https://client.example.test/Callback','https://client.example.test/callback')
    Assert-LocalMcpSettings $exactCallbacks 14391
    $exactCallbacks.redirectUris=@('https://client.example.test/callback','https://client.example.test/callback')
    Fails { Assert-LocalMcpSettings $exactCallbacks 14391 } 'distinct exact'
    $secretDirectory=Join-Path $context.State 'secrets'
    [IO.Directory]::CreateDirectory($secretDirectory) | Out-Null
    foreach ($name in @('mcp-client','mcp-signing','mcp-encryption','session','postgres-app','postgres-admin')) {
        Write-LocalText (Join-Path $secretDirectory $name) "synthetic-independent-$name"
    }
    $signing=[Convert]::ToBase64String([byte[]](1..32)).Replace('+','-').Replace('/','_')
    $encryption=[Convert]::ToBase64String([byte[]](33..64)).Replace('+','-').Replace('/','_')
    $caseKeyUpper=('A'*43)+'='
    $caseKeyLower=('a'*42)+'A='
    $caseValues=@{'mcp-client'='synthetic-distinct-client-secret';'mcp-signing'=$signing
        'mcp-encryption'=(ConvertTo-Json -InputObject @($caseKeyUpper,$caseKeyLower) -Compress)}
    Assert-LocalMcpSecretValues $caseValues
    $caseValues['mcp-encryption']=ConvertTo-Json -InputObject @($caseKeyUpper,$caseKeyUpper) -Compress
    Fails { Assert-LocalMcpSecretValues $caseValues } 'independent encryption keys'
    Write-LocalText (Join-Path $secretDirectory 'mcp-signing') $signing
    Write-LocalText (Join-Path $secretDirectory 'mcp-encryption') (ConvertTo-Json -InputObject @($encryption) -Compress)
    Write-LocalText (Join-Path $context.State 'settings.json') ($settings | ConvertTo-Json -Depth 8)
    $plan=Get-LocalMcpPlan $context $settings @($profile)
    Assert ($plan.Inputs.Count -eq 3) 'MCP did not select only three independent protected inputs.'
    $wrong=$profile.Clone();$wrong.integration=@{clientId='44444444-4444-4444-4444-444444444444';audience=$mcp.apiClientId;scope='AgentControl.Access'}
    Fails { Get-LocalMcpPlan $context $settings @($wrong) } 'explicitly match'
    Fails { Get-LocalMcpPlan $context $settings @() } 'explicitly match'
    Save-LocalMcpConfiguration $context $plan
    $metadataPath = Join-Path $secretDirectory 'mcp-metadata'
    Assert (Test-LocalMcpMetadataCredential $context) 'Normal existing-project start did not provision the independent metadata credential.'
    $originalHashes = @('mcp-client','mcp-signing','mcp-encryption','session','postgres-app','postgres-admin') | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $secretDirectory $_)).Hash }
    $metadataHash = (Get-FileHash -LiteralPath $metadataPath).Hash
    Save-LocalMcpConfiguration $context $plan
    Assert ((Get-FileHash -LiteralPath $metadataPath).Hash -ceq $metadataHash) 'Restart rotated the metadata credential.'
    foreach ($kind in @('invalid','link','mode','unreadable')) {
        Remove-Item -LiteralPath $metadataPath
        if ($kind -eq 'link') { New-Item -ItemType SymbolicLink -Path $metadataPath -Target (Join-Path $secretDirectory 'mcp-signing') | Out-Null }
        else {
            Write-LocalText $metadataPath $(if ($kind -eq 'invalid') {'invalid'} else {[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).Replace('+','-').Replace('/','_')})
            if ($kind -eq 'mode' -and -not $IsWindows) { [IO.File]::SetUnixFileMode($metadataPath,[IO.UnixFileMode]420) }
            if ($kind -eq 'unreadable' -and -not $IsWindows) { [IO.File]::SetUnixFileMode($metadataPath,[IO.UnixFileMode]0) }
        }
        Initialize-LocalMcpMetadataCredential $context 3>$null
        Sync-LocalMcpContext $context $settings
        Assert (-not (Test-LocalMcpMetadataCredential $context) -and $context.Compose -notcontains (Join-Path $root 'compose.mcp-metadata.yaml')) "Invalid metadata ($kind) became a mandatory/broken mount or was silently replaced."
    }
    Remove-Item -LiteralPath $metadataPath
    Initialize-LocalMcpMetadataCredential $context
    Assert (Test-LocalMcpMetadataCredential $context) 'Missing independent metadata key did not recover automatically.'
    $afterHashes = @('mcp-client','mcp-signing','mcp-encryption','session','postgres-app','postgres-admin') | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $secretDirectory $_)).Hash }
    Assert (($originalHashes -join ',') -ceq ($afterHashes -join ',')) 'Metadata recovery changed existing OAuth/session credentials.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $context.State 'mcp/oauth'))) 'MCP incorrectly created a host bind store instead of a dedicated named volume.'
    if (-not $IsWindows) {
        Assert ([int][IO.File]::GetUnixFileMode((Join-Path $secretDirectory 'mcp-client')) -eq 384) 'Secret input is not 0600.'
        [IO.File]::SetUnixFileMode((Join-Path $secretDirectory 'mcp-client'),[IO.UnixFileMode]420)
        Fails { Get-LocalMcpPlan $context $settings @($profile) } '0600'
        Protect-LocalPath (Join-Path $secretDirectory 'mcp-client')
    }
    Sync-LocalMcpContext $context $settings
    Sync-LocalMcpContext $context $settings
    Assert ($context.McpRecordingVolume -ceq 'mcp-test_mcp-recordings' -and
        $context.McpRecordingVolume -cne $context.McpVolume) 'Recording diagnostics reused OAuth state or another project volume.'
    Assert (@($context.Compose | Where-Object { $_ -ceq (Join-Path $root 'compose.mcp.yaml') }).Count -eq 1) 'Compose MCP overlay duplicated.'
    $context.Port=14391;$context.Url='http://localhost:14391';$context.PublicUrl=$context.Url;$context.McpImageId=$script:image
    Write-LocalComposeEnvironment $context
    $environment=[IO.File]::ReadAllText((Join-Path $context.State 'compose.env'))
    foreach ($value in @('MCP_API_CLIENT_ID=22222222-2222-2222-2222-222222222222','MCP_PUBLIC_URL=https://mcp.example.test/mcp','MCP_PORT=14392',"MCP_IMAGE=$script:image")) { Assert ($environment.Contains($value)) "Missing exact environment setting $value." }
    Assert (-not $environment.Contains('synthetic-independent')) 'Secret content entered Compose environment.'
    foreach ($employee in @($false,$true)) {
        foreach ($champion in @($false,$true)) {
            $context.Mcp.hide_employee_details=$employee
            $context.Mcp.hide_champion_employee=$champion
            $settings.mcp=$context.Mcp
            Write-LocalText (Join-Path $context.State 'settings.json') ($settings | ConvertTo-Json -Depth 8)
            $roundTrip=Read-LocalSettings $context.State
            Assert ($roundTrip.mcp.hide_employee_details -ceq $employee -and $roundTrip.mcp.hide_champion_employee -ceq $champion) 'Privacy persistence lost an explicit boolean.'
            Write-LocalComposeEnvironment $context
            $emitted=[IO.File]::ReadAllText((Join-Path $context.State 'compose.env'))
            Assert ($emitted.Contains("MCP_HIDE_EMPLOYEE_DETAILS=$($employee.ToString().ToLowerInvariant())") -and
                $emitted.Contains("MCP_HIDE_CHAMPION_EMPLOYEE=$($champion.ToString().ToLowerInvariant())")) 'Independent API privacy runtime values differ.'
        }
    }
    $context.Mcp.hide_employee_details=$false
    $context.Mcp.hide_champion_employee=$false
    $run=Get-LocalMcpRunArguments $context
    Assert ($run -contains '--read-only' -and $run -contains '--pids-limit' -and @($run | Where-Object { $_ -like 'type=bind,*readonly' }).Count -eq 4) 'MCP preflight mounts/security differ.'
    Assert ($run -contains "type=volume,source=$($context.McpVolume),target=/var/lib/agent-control-mcp/oauth,volume-nocopy" -and
        $run -contains "type=volume,source=$($context.McpRecordingVolume),target=/var/lib/agent-control-mcp/recordings,volume-nocopy" -and
        @($run | Where-Object { $_ -like 'type=volume,*' }).Count -eq 2 -and
        $run -contains 'MCP_RECORDING_STORAGE_PATH=/var/lib/agent-control-mcp/recordings') 'MCP preflight did not isolate the two writable nocopy volumes.'
    Assert (@($run | Where-Object { $_ -cmatch '^MCP_RECORDING_' }).Count -eq 1) 'Deployment enabled tracing instead of leaving Docker admin controls off by default.'
    Assert (-not (($run -join '|') -match 'tenants.json|postgres|PGPASSWORD|SESSION_SECRET')) 'MCP inherited API/database authority.'
    $stateFiles=@(Get-ChildItem -LiteralPath $context.State -File | ForEach-Object Name) -join '|'
    $script:calls.Clear()
    Initialize-LocalMcpRecordingStorage $context
    $initialization=@($script:calls | Where-Object { $_ -match '^run\|' })
    $uid=if ($IsWindows) {'1000'} else {(& id -u).Trim()}
    $gid=if ($IsWindows) {'1000'} else {(& id -g).Trim()}
    Assert ($initialization.Count -eq 1 -and
        $initialization[0].Contains('--network|none|--user|0:0|--read-only|--cap-drop|ALL|--cap-add|CHOWN|--cap-add|FOWNER') -and
        $initialization[0].Contains("--mount|type=volume,source=$($context.McpRecordingVolume),target=/var/lib/agent-control-mcp/recordings,volume-nocopy") -and
        $initialization[0].Contains('--env|MCP_RECORDING_STORAGE_PATH=/var/lib/agent-control-mcp/recordings') -and
        $initialization[0].EndsWith("|$($script:image)|-m|agent_control_mcp.recording|initialize|$uid|$gid") -and
        -not $initialization[0].Contains($context.McpVolume)) 'Recording initialization did not use the exact image, operator ownership and isolated diagnostics volume.'
    Assert (($script:calls -join "`n").Contains("com.docker.compose.project=$($context.Project)|--label|com.docker.compose.volume=mcp-recordings|--label|io.agent-control.purpose=mcp-session-recordings")) 'Recording volume was created without project/logical/purpose ownership.'
    Assert ((@(Get-ChildItem -LiteralPath $context.State -File | ForEach-Object Name) -join '|') -ceq $stateFiles) 'Fresh recorder initialization persisted a diagnostics receipt.'
    $script:calls.Clear()
    Initialize-LocalMcpRecordingStorage $context
    Assert (-not (($script:calls -join "`n") -match '^volume\|create\|' ) -and
        (@(Get-ChildItem -LiteralPath $context.State -File | ForEach-Object Name) -join '|') -ceq $stateFiles) 'Disposable recorder initialization created durable receipts or replaced existing volume ownership.'
    foreach ($override in @(
        @{name='foreign-recordings'},@{driver='foreign-driver'},@{'com.docker.compose.project'='other-project'},
        @{'com.docker.compose.volume'='mcp-oauth'},@{'io.agent-control.purpose'='encrypted-oauth-state'}
    )) {
        $script:recordingVolumeOverrides=$override
        $script:calls.Clear()
        Fails { Initialize-LocalMcpRecordingStorage $context } 'recording volume ownership/purpose'
        Assert (-not (($script:calls -join "`n") -match '^run\|')) 'Foreign diagnostics state was mutated before ownership validation.'
    }
    $script:recordingVolumeOverrides=@{}
    $script:mountDetails=@{user="$((& id -u).Trim()):$((& id -g).Trim())";ports=@{'8000/tcp'=@(@{HostIp='127.0.0.1';HostPort='14392'})};networks=@{$context.Network=@{}}
        mounts=@(@{Destination='/run/secrets/mcp-client';Source=(Join-Path $secretDirectory 'mcp-client');Type='bind';RW=$false},
            @{Destination='/run/secrets/mcp-signing';Source=(Join-Path $secretDirectory 'mcp-signing');Type='bind';RW=$false},
            @{Destination='/run/secrets/mcp-encryption';Source=(Join-Path $secretDirectory 'mcp-encryption');Type='bind';RW=$false},
            @{Destination='/var/lib/agent-control-mcp/oauth';Name=$context.McpVolume;Type='volume';RW=$true},
            @{Destination='/var/lib/agent-control-mcp/recordings';Name=$context.McpRecordingVolume;Type='volume';RW=$true})}
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
    $oauthReceiptHash=(Get-FileHash -LiteralPath (Join-Path $context.State 'mcp-storage.json')).Hash
    $script:recordingVolume=$false
    $script:calls.Clear()
    Initialize-LocalMcpStorage $context
    Assert ($script:recordingVolume -and
        @($script:calls | Where-Object { $_ -match '^volume\|create\|' }).Count -eq 1 -and
        (Get-FileHash -LiteralPath (Join-Path $context.State 'mcp-storage.json')).Hash -ceq $oauthReceiptHash) 'Missing disposable diagnostics could not recover independently of retained OAuth state.'
    Assert (-not (($script:calls -join "`n") -match 'agent_control_mcp.recording\|(start|enable)\|')) 'Ordinary startup activated recording.'
    Fails { Invoke-LocalMcpChecks $context $null -Image 'mutable:tag' } 'immutable image'
    $script:calls.Clear()
    Invoke-LocalMcpChecks $context $null -Image $script:image
    Assert ($script:calls.Count -eq 1 -and $script:calls[0].Contains('--network|none') -and
        $script:calls[0].Contains('--env|TMPDIR=/work') -and
        $script:calls[0].Contains('--tmpfs|/work:rw,noexec,nosuid,size=64m,uid=') -and
        $script:calls[0].Contains(',mode=0700') -and -not $script:calls[0].Contains('--mount') -and
        $script:calls[0].Contains("--entrypoint|python|$script:image|-m|pytest")) 'Bounded non-root image checks did not use private Linux work tmpfs.'
    Assert-LocalMcpContainer $context $script:container
    $context.Mcp.port=14393
    Assert-LocalMcpContainer $context $script:container
    Fails { Assert-LocalMcpContainer $context $script:container -RequireConfiguredPort } 'user/network'
    $previousDeployment=[IO.File]::ReadAllText((Join-Path $context.State 'mcp-deployment.json'))
    $script:preserveMcpPort=$true
    Fails { Start-LocalMcp $context } 'user/network'
    Assert ([IO.File]::ReadAllText((Join-Path $context.State 'mcp-deployment.json')) -ceq $previousDeployment -and
        ([IO.File]::ReadAllText((Join-Path $context.State 'mcp-operation.json')) | ConvertFrom-Json).step -ceq 'prepared') 'MCP port mismatch was recorded as verified.'
    $script:preserveMcpPort=$false
    $script:calls.Clear()
    Start-LocalMcp $context
    Assert ($script:mountDetails.ports['8000/tcp'][0].HostPort -ceq '14393' -and
        ($script:calls -join "`n") -match 'force-recreate') 'Saved MCP port change could not replace the retained container.'
    Assert-LocalMcpContainer $context $script:container -RequireConfiguredPort
    $context.Mcp.port=14392
    Start-LocalMcp $context
    foreach ($port in @('0','1023','65536','invalid')) {
        $script:mountDetails.ports['8000/tcp'][0].HostPort=$port
        Fails { Assert-LocalMcpContainer $context $script:container } 'user/network'
    }
    $script:mountDetails.ports['8000/tcp'][0].HostPort='14392'
    foreach ($field in @('Name','Type','RW')) {
        $saved=$script:mountDetails.mounts[-1][$field]
        $script:mountDetails.mounts[-1][$field]=if ($field -eq 'RW') {$false} elseif ($field -eq 'Type') {'bind'} else {$context.McpVolume}
        Fails { Assert-LocalMcpContainer $context $script:container } 'volume identity'
        $script:mountDetails.mounts[-1][$field]=$saved
    }
    $script:recordingVolumeOverrides=@{'com.docker.compose.project'='other-project'}
    Fails { Assert-LocalMcpContainer $context $script:container } 'recording volume ownership/purpose'
    $script:recordingVolumeOverrides=@{}
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
    $namedProfile=$profile.Clone();$namedProfile.displayName='Primary tenant'
    $wizard=New-McpSetupFixture 'wizard' @($namedProfile,$other) -Project 'seha'
    $foreignProfile=$other.Clone();$foreignProfile.displayName='Other project only';$foreignProfile.domains=@('foreign.invalid')
    $foreign=New-McpSetupFixture 'wizard' @($foreignProfile) -Project 'other-project'
    $foreignSettings=[IO.File]::ReadAllText((Join-Path $foreign.State 'settings.json'))
    $foreignRegistry=[IO.File]::ReadAllText((Join-Path $foreign.State 'secrets/tenants.json'))
    Set-SetupAnswers
    Save-LocalConfiguration $wizard (Read-LocalConfiguration $wizard $false -Onboard)
    $wizard.ConfigureMcp=$true
    $wizardClient='66666666-6666-6666-6666-666666666666'
    $wizardSecret='synthetic-new-mcp-credential'
    Set-SetupAnswers @('2',$wizardClient,'','   ',$mcp.publicUrl,'https://client.example.test/callback,http://127.0.0.1:8585/oauth/callback','') @($wizardSecret)
    $wizardOutput=Join-Path $root 'wizard-output.txt'
    $wizardWarnings=Join-Path $root 'wizard-warnings.txt'
    $setup=Read-LocalConfiguration $wizard $true -Edit 6>$wizardOutput 3>$wizardWarnings
    $wizardMessages=[IO.File]::ReadAllText($wizardOutput)
    Assert ($wizardMessages.Contains("Configure MCP for local project 'seha'.") -and
        $wizardMessages.Contains('Only tenant configurations saved in this project are listed.')) 'Wizard did not explain the selected project boundary.'
    Assert ($wizardMessages.Contains('1: Primary tenant') -and $wizardMessages.Contains('2: other.invalid')) 'Wizard omitted the tenant name or its domain fallback.'
    Assert ($wizardMessages.Contains("Entra tenant ID: $($other.tenantId)") -and
        $wizardMessages.Contains("Existing Agent Control application (client) ID: $($other.clientId)")) 'Wizard did not label the existing tenant/API identities.'
    Assert (-not $wizardMessages.Contains('Other project only') -and -not $wizardMessages.Contains('foreign.invalid')) 'Wizard listed a tenant from another project.'
    Assert ($wizardMessages.Contains('separate MCP server Entra registration, not the existing Agent Control registration above.')) 'Wizard did not distinguish the new MCP registration from the existing API.'
    Assert ($script:prompts[0].text -ceq 'Choose a configuration number [default: 1; press Enter to select]') 'First-time configuration selection did not explain the default.'
    Assert ($wizardMessages.Contains('including its resource path (for example https://mcp.example.com/mcp), not just the base URL.')) 'Wizard did not explain the full MCP endpoint URL.'
    $urlPrompts=@($script:prompts | Where-Object { $_.text.StartsWith('MCP public HTTPS resource URL') })
    Assert ($urlPrompts.Count -eq 3 -and
        @($urlPrompts | Where-Object { $_.text -cne 'MCP public HTTPS resource URL (required; for example https://mcp.example.com/mcp)' }).Count -eq 0) 'First-time URL setup offered an empty default or accepted blank input.'
    Assert ([regex]::Matches([IO.File]::ReadAllText($wizardWarnings),'MCP public HTTPS resource URL is required').Count -eq 2) 'Blank URL inputs did not produce explicit validation warnings.'
    Assert ($setup.McpPlan.Settings.publicUrl -ceq $mcp.publicUrl) 'Wizard did not retain the entered full MCP endpoint.'
    Assert ($setup.McpPlan.Settings.tenantId -ceq $other.tenantId -and $setup.McpPlan.Settings.apiClientId -ceq $other.clientId) 'Wizard selected the wrong API tenant profile.'
    Assert ($setup.McpPlan.Settings.port -eq 8002) 'Wizard default conflicts with the API port.'
    Assert ($setup.McpPlan.Settings.redirectUris.Count -eq 2) 'Wizard lost an exact client callback.'
    Assert ($setup.RegistryChanged -and $setup.IdentityChanged -and $setup.SettingsChanged -and -not $setup.ApplicationSettingsChanged) 'Integration binding was added after metadata/change detection.'
    Assert ($setup.Profiles[0].integration.clientId -ceq $profile.integration.clientId -and $setup.Profiles[1].integration.clientId -ceq $wizardClient) 'Wizard overwrote another tenant integration.'
    Assert ($setup.Profiles[1].integration.audience -ceq $other.clientId -and $setup.Profiles[1].integration.scope -ceq 'AgentControl.Access') 'Wizard broadened API audience or scope.'
    Assert ($script:prompts.Count -eq 10 -and @($script:prompts | Where-Object secure).Count -eq 1 -and $script:prompts[-1].text.StartsWith('MCP Entra client secret')) 'Wizard exposed a credential or re-prompted for API secrets.'
    foreach ($name in @('mcp-client','mcp-signing','mcp-encryption')) {
        Assert (-not (Test-Path -LiteralPath (Join-Path $wizard.State "secrets/$name"))) 'Planning persisted MCP secrets before successful validation.'
    }
    $generatedSigning=$setup.McpPlan.SecretValues['mcp-signing']
    $generatedEncryption=@(ConvertFrom-Json -InputObject $setup.McpPlan.SecretValues['mcp-encryption'])
    Assert-LocalMcpKey $generatedSigning
    Assert-LocalMcpKey $generatedEncryption[0]
    Assert ($generatedEncryption.Count -eq 1 -and $generatedSigning -cne $generatedEncryption[0] -and $generatedSigning -cne $wizardSecret) 'First setup reused secret/key material.'
    Save-LocalConfiguration $wizard $setup
    Assert ([IO.File]::ReadAllText((Join-Path $foreign.State 'settings.json')) -ceq $foreignSettings -and
        [IO.File]::ReadAllText((Join-Path $foreign.State 'secrets/tenants.json')) -ceq $foreignRegistry -and
        -not (Test-Path -LiteralPath (Join-Path $foreign.State 'secrets/mcp-client'))) 'MCP setup changed another project configuration or credentials.'
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
    Assert ($script:prompts[0].text -ceq 'Choose a configuration number [default: 2; press Enter to select]' -and
        $unchanged.McpPlan.Settings.apiClientId -ceq $other.clientId) 'Enter did not select the saved tenant configuration.'
    Assert ($script:prompts[2].text -ceq "MCP public HTTPS resource URL [$($mcp.publicUrl); Enter to keep]" -and
        $unchanged.McpPlan.Settings.publicUrl -ceq $mcp.publicUrl) 'Saved URL was not shown or retained when Enter was pressed.'
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
    $privacyImport=Join-Path $import.Root 'privacy-import.json'
    $privacyInput=[IO.File]::ReadAllText((Join-Path $repository 'mcp/examples/local-settings.example.json')) | ConvertFrom-Json -AsHashtable
    $import.McpConfigInput=$privacyImport
    foreach ($employee in @($false,$true)) {
        foreach ($champion in @($false,$true)) {
            $privacyInput.hide_employee_details=$employee
            $privacyInput.hide_champion_employee=$champion
            Write-LocalText $privacyImport ($privacyInput | ConvertTo-Json)
            $privacyPlan=Read-LocalConfiguration $import $false -Onboard
            Assert ($privacyPlan.McpPlan.Settings.hide_employee_details -ceq $employee -and
                $privacyPlan.McpPlan.Settings.hide_champion_employee -ceq $champion -and
                -not $privacyPlan.McpPlan.SecretsChanged -and -not $privacyPlan.IdentityChanged) 'Privacy import changed identity/secrets or lost independent booleans.'
            Save-LocalConfiguration $import $privacyPlan
            $privacyInput.Remove('hide_employee_details');$privacyInput.Remove('hide_champion_employee')
            Write-LocalText $privacyImport ($privacyInput | ConvertTo-Json)
            $preserved=Read-LocalConfiguration $import $false -Onboard
            Assert ($preserved.McpPlan.Settings.hide_employee_details -ceq $employee -and
                $preserved.McpPlan.Settings.hide_champion_employee -ceq $champion -and -not $preserved.SettingsChanged) 'Omitted imported flags reset saved privacy on redeploy.'
        }
    }
    foreach ($key in @('hide_employee_details','hide_champion_employee')) {
        $privacyInput[$key]='true'
        Write-LocalText $privacyImport ($privacyInput | ConvertTo-Json)
        Fails { Read-LocalConfiguration $import $false -Onboard } 'must be a boolean'
        $privacyInput.Remove($key)
    }
    Write-LocalText $privacyImport ($privacyInput | ConvertTo-Json)
    $import.ConfigureMcp=$true
    Set-SetupAnswers @('','','','','','TRUE','false','true') @('')
    $privacyWizard=Read-LocalConfiguration $import $false -Edit
    Assert ($privacyWizard.McpPlan.Settings.hide_employee_details -ceq $false -and
        $privacyWizard.McpPlan.Settings.hide_champion_employee -ceq $true -and
        $privacyWizard.ApplicationSettingsChanged -and -not $privacyWizard.IdentityChanged -and
        -not $privacyWizard.McpPlan.SecretsChanged) 'Privacy wizard failed to target the API configuration without changing credentials.'
    Save-LocalConfiguration $import $privacyWizard
    Set-SetupAnswers @('','','','','') @('')
    $keptPrivacy=Read-LocalConfiguration $import $false -Edit
    Assert ($keptPrivacy.McpPlan.Settings.hide_employee_details -ceq $false -and
        $keptPrivacy.McpPlan.Settings.hide_champion_employee -ceq $true -and
        -not $keptPrivacy.ApplicationSettingsChanged) 'Enter did not retain explicit privacy settings.'
    $import.ConfigureMcp=$false
    $import.McpConfigInput=Join-Path $repository 'mcp/examples/local-settings.example.json'

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
    Assert ($firstPlan.McpPlan.Settings.tenantId -ceq $mcp.tenantId -and
        $firstPlan.McpPlan.Settings.apiClientId -ceq $mcp.apiClientId -and
        @($script:prompts | Where-Object { $_.text -ceq 'Choose a configuration number [default: 1; press Enter to select]' }).Count -eq 1) 'Single-tenant setup did not accept Enter to select the project configuration.'
    Assert ($firstPlan.Port -eq 8001 -and $firstPlan.McpPlan.Settings.port -eq 8002 -and 8001 -in $script:portChecks) 'Combined first-run wizard lost API port validation or MCP port separation.'
    Assert ($firstPlan.Profiles[0].clientSecret -ceq 'synthetic-first-api-credential' -and
        $firstPlan.McpPlan.SecretValues['mcp-client'] -ceq 'synthetic-first-mcp-credential') 'Combined wizard copied the API credential into MCP.'
    Assert (@($script:prompts | Where-Object secure).Count -eq 2 -and $script:textAnswers.Count -eq 0 -and $script:secretAnswers.Count -eq 0) 'Combined first-run wizard did not consume the expected API/MCP prompts.'
    Save-LocalConfiguration $firstRun $firstPlan
    $firstRun.ConfigureMcp=$false
    Set-SetupAnswers
    $nextStart=Read-LocalConfiguration $firstRun $true -Onboard
    Assert (-not $nextStart.RegistryChanged -and -not $nextStart.SettingsChanged -and -not $nextStart.McpPlan.SecretsChanged -and $script:prompts.Count -eq 0) 'Ordinary start cannot reuse complete first-run wizard configuration.'
    $hostExecutable=(Get-Command pwsh -CommandType Application | Select-Object -First 1).Source
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
