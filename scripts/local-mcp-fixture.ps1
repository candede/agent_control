function Assert-LocalMcpFixtureEngine {
    if ((Invoke-DockerCommand @('context','show') -Capture) -cne 'desktop-linux' -or
        (Invoke-DockerCommand @('context','inspect','--format','{{.Endpoints.docker.Host}}') -Capture) -cne "unix://$HOME/.docker/run/docker.sock" -or
        [Environment]::GetEnvironmentVariable('DOCKER_HOST') -or [Environment]::GetEnvironmentVariable('DOCKER_CONTEXT')) {
        throw 'MCP fixture requires the explicitly authorized local desktop-linux Unix socket without environment overrides.'
    }
}

function Get-LocalMcpFixtureContainers {
    param($Context,[string]$Directory,$Images)
    Assert-LocalMcpFixtureEngine
    if ($Context.Project -cnotmatch '^ac-mcp-fixture-[a-f0-9]{24}$' -or
        $Context.State -cne (Join-Path $Context.Root ".local/$($Context.Project)") -or
        -not $Directory.StartsWith((Join-Path $Context.Root 'artifacts/large-tenant-data-platform/'),[StringComparison]::Ordinal)) { throw 'MCP fixture ownership paths differ.' }
    $ids = Invoke-DockerCommand @('ps','-aq','--no-trunc','--filter',"label=com.docker.compose.project=$($Context.Project)") -Capture
    foreach ($id in ($ids -split "`n" | Where-Object { $_ })) {
        if ($id -cnotmatch '^[a-f0-9]{64}$') { throw 'Unexpected MCP fixture container identity.' }
        $details = Invoke-DockerCommand @('inspect','--format',
            '{"id":{{json .Id}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"state":{{json .State}},"user":{{json .Config.User}},"memory":{{json .HostConfig.Memory}},"cpus":{{json .HostConfig.NanoCpus}},"pids":{{json .HostConfig.PidsLimit}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"logs":{{json .HostConfig.LogConfig}},"ports":{{json .HostConfig.PortBindings}},"networks":{{json .NetworkSettings.Networks}}}',$id) -Capture | ConvertFrom-Json -AsHashtable
        $service = $details.labels['com.docker.compose.service']
        if ($service -cnotin @('mcp','app') -or $details.labels['com.docker.compose.project'] -cne $Context.Project -or
            $details.labels['com.docker.compose.project.working_dir'] -cne $Context.Root -or
            $details.labels['io.agent-control.fixture'] -cne $Context.Project -or
            $details.image -cnotin @($Images.Values) -or $details.user -cne "$((& id -u).Trim()):$((& id -g).Trim())" -or
            $details.networks.Count -ne 1 -or -not $details.networks.Contains($Context.Network)) { throw 'MCP fixture image/user/purpose/network ownership differs.' }
        $expected = @{ '/fixture/key.json'=(Join-Path $Directory 'key.json') }
        if ($service -ceq 'mcp') {
            foreach ($name in @('mcp-client','mcp-signing','mcp-encryption')) { $expected["/run/secrets/$name"] = Join-Path $Context.State "secrets/$name" }
            $expected['/var/lib/agent-control-mcp/oauth'] = $Context.McpVolume
            if ($details.memory -ne 536870912 -or $details.cpus -ne 500000000 -or $details.pids -ne 128 -or
                -not $details.readOnly -or ($details.capDrop -join ',') -cne 'ALL' -or
                ($details.securityOpt -join ',') -cne 'no-new-privileges:true' -or
                $details.logs.Type -cne 'json-file' -or $details.logs.Config['max-size'] -cne '5m' -or
                $details.logs.Config['max-file'] -cne '2' -or
                $details.ports.Count -ne 1 -or $details.ports['8000/tcp'].Count -ne 1 -or
                $details.ports['8000/tcp'][0].HostIp -cne '127.0.0.1' -or $details.ports['8000/tcp'][0].HostPort -cne [string]$Context.Mcp.port) { throw 'MCP fixture resource/loopback contract differs.' }
        } elseif ($details.ports -and $details.ports.Count) { throw 'Synthetic API must not publish host ports.' }
        if ($details.mounts.Count -ne $expected.Count) { throw 'MCP fixture has extra mounts.' }
        foreach ($mount in $details.mounts) {
            if ($mount.Destination -ceq '/var/lib/agent-control-mcp/oauth') {
                if ($mount.Type -cne 'volume' -or $mount.Name -cne $Context.McpVolume -or -not $mount.RW) { throw 'MCP fixture exact volume differs.' }
            } elseif (-not $expected.ContainsKey($mount.Destination) -or $mount.Type -cne 'bind' -or
                -not (Test-LocalBindSource $mount.Source $expected[$mount.Destination]) -or $mount.RW) { throw 'MCP fixture exact mount/access differs.' }
        }
        $details
    }
}

function Invoke-LocalMcpFixture {
    param([string]$Root,[string]$Directory)
    foreach ($name in @([Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -cmatch '^(PG|APP_PG|TENANT|CLIENT_|SESSION_SECRET|MCP_)' })) {
        if ([Environment]::GetEnvironmentVariable($name)) { throw "MCP fixture rejects inherited $name." }
    }
    Assert-LocalMcpFixtureEngine
    $project = "ac-mcp-fixture-$([Guid]::NewGuid().ToString('N').Substring(0,24))"
    $context = New-LocalContext $Root $project
    if (Test-Path -LiteralPath $context.State) { throw 'MCP fixture state must be absent.' }
    foreach ($kind in @('volume','network')) {
        $owned = Invoke-DockerCommand @($kind,'ls','--filter',"label=com.docker.compose.project=$project",'--format','{{.Name}}') -Capture
        if ($owned) { throw 'MCP fixture resources already exist.' }
    }
    $owned = Invoke-DockerCommand @('ps','-aq','--filter',"label=com.docker.compose.project=$project") -Capture
    if ($owned) { throw 'MCP fixture containers already exist.' }
    foreach ($tag in @("$project-mcp:local","$project-mcp:local-test")) {
        if ($tag -in ((Invoke-DockerCommand @('image','ls','--format','{{.Repository}}:{{.Tag}}') -Capture) -split "`n")) { throw 'MCP fixture image tag already exists.' }
    }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    try { $listener.Start(); $port=$listener.LocalEndpoint.Port } finally { $listener.Stop() }
    if ($port -in @(3001,3002)) { throw 'MCP fixture cannot use retained application ports.' }
    $images = @{}
    $snapshot = $null
    $failures = [Collections.Generic.List[Exception]]::new()
    $started = $false
    $drainId = $null
    $cleanupFailures = 0
    $journeys = @()
    $ownership=@{project=$project;state=$context.State;network=$context.Network;port=$port;context='desktop-linux';endpoint="unix://$HOME/.docker/run/docker.sock";purpose='synthetic MCP container qualification';priorResourcesAbsent=$true}
    Write-LocalText (Join-Path $Directory 'mcp-ownership.json') ($ownership | ConvertTo-Json)
    try {
        [IO.Directory]::CreateDirectory((Join-Path $context.State 'secrets')) | Out-Null
        foreach ($path in @($context.State,(Join-Path $context.State 'secrets'))) { Protect-LocalPath $path -Directory }
        & (Join-Path $Root 'mcp/.venv/bin/python') -c 'import json,sys;from pathlib import Path;from joserfc.jwk import RSAKey;from cryptography.fernet import Fernet;p=Path(sys.argv[1]);p.joinpath("key.json").write_text(json.dumps(RSAKey.generate_key(parameters={"kid":"fixture-key"}).as_dict(private=True)));p.joinpath("signing").write_text(Fernet.generate_key().decode());p.joinpath("encryption").write_text(json.dumps([Fernet.generate_key().decode()]));[x.chmod(0o600) for x in p.iterdir() if x.is_file()]' $Directory
        if ($LASTEXITCODE -ne 0) { throw 'Synthetic key generation failed.' }
        Write-LocalText (Join-Path $context.State 'secrets/mcp-client') 'synthetic-confidential-client-secret'
        Write-LocalText (Join-Path $context.State 'secrets/mcp-signing') ([IO.File]::ReadAllText((Join-Path $Directory 'signing')))
        Write-LocalText (Join-Path $context.State 'secrets/mcp-encryption') ([IO.File]::ReadAllText((Join-Path $Directory 'encryption')))
        $profile = @{tenantId='11111111-1111-1111-1111-111111111111';clientId='22222222-2222-2222-2222-222222222222';clientSecret='synthetic-api-secret';domains=@('example.invalid')
            integration=@{clientId='33333333-3333-3333-3333-333333333333';audience='22222222-2222-2222-2222-222222222222';scope='AgentControl.Access'}}
        $settings = @{port=14391;publicUrl='';tenants=@(Get-LocalTenantMetadata @($profile))
            mcp=@{tenantId=$profile.tenantId;apiClientId=$profile.clientId;clientId=$profile.integration.clientId;port=$port;publicUrl='https://mcp.example.test/mcp';redirectUris=@('https://client.example.test/callback')}}
        Write-LocalText (Join-Path $context.State 'settings.json') ($settings | ConvertTo-Json -Depth 8)
        Write-LocalText (Join-Path $context.State 'secrets/tenants.json') (ConvertTo-Json -InputObject @($profile) -Depth 8)
        Initialize-LocalState $context $false
        $context.SourceEvidenceFile = Join-Path $Directory 'mcp-source.json'
        $snapshot = New-LocalBuildSnapshot $context
        $ownership.snapshot=$snapshot.Directory
        Write-LocalText (Join-Path $Directory 'mcp-ownership.json') ($ownership | ConvertTo-Json)
        $context.McpImageId = Build-LocalMcpArtifact $context $snapshot
        $images[$context.McpImage] = $context.McpImageId
        $fixtureImage = Build-LocalMcpArtifact $context $snapshot -Target fixture
        $images["$($context.McpImage)-test"] = $fixtureImage
        Invoke-LocalMcpChecks $context $snapshot -Image $fixtureImage
        Test-LocalMcpConfiguration $context
        $fixture = Join-Path $Directory 'mcp-fixture.yaml'
        $keyPath = (Join-Path $Directory 'key.json')
        Write-LocalText $fixture @"
services:
  app:
    image: $fixtureImage
    entrypoint: [python, tests/container_service.py]
    command: [api]
    labels:
      io.agent-control.fixture: $project
    environment: !reset {}
    ports: !reset []
    secrets: !reset []
    volumes: !override
      - type: bind
        source: $keyPath
        target: /fixture/key.json
        read_only: true
    tmpfs: !reset []
    depends_on: !reset {}
    healthcheck:
      test: [CMD, python, -c, "import urllib.request;urllib.request.urlopen('http://127.0.0.1:3001/api/ready',timeout=3)"]
  mcp:
    labels:
      io.agent-control.fixture: $project
    volumes:
      - type: bind
        source: $keyPath
        target: /fixture/key.json
        read_only: true
networks:
  default:
    internal: true
"@
        $context.Compose += @('-f',$fixture)
        Write-LocalComposeEnvironment $context
        # First start the unmodified production runtime image, not fixture authentication.
        $started = $true
        Invoke-DockerCommand ($context.Compose + @('up','-d','--no-build','--no-deps','--wait','--wait-timeout','90','app','mcp'))
        $cold = @(Get-LocalMcpFixtureContainers $context $Directory $images)
        Write-LocalText (Join-Path $Directory 'mcp-production-image.json') ($cold | ConvertTo-Json -Depth 12)
        if ($cold.Count -ne 2 -or @($cold | Where-Object { $_.state.Health.Status -cne 'healthy' }).Count) { throw 'Production-image cold readiness failed.' }
        $runtime = @($cold | Where-Object { $_.labels['com.docker.compose.service'] -ceq 'mcp' })[0]
        Invoke-DockerCommand @('exec',$runtime.id,'python','-c','import os,stat;from agent_control_mcp.config import Settings;from agent_control_mcp.storage import inspect_storage;s=Settings.from_env();assert os.getuid()!=0;assert stat.S_IMODE(s.storage_path.stat().st_mode)==0o700;inspect_storage(s.storage_path);print("non-root protected production runtime passed")')
        # Only this test image injects synthetic upstream signature/OAuth responses.
        $authOverlay = Join-Path $Directory 'mcp-auth.yaml'
        Write-LocalText $authOverlay @"
services:
  mcp:
    image: $fixtureImage
    entrypoint: [python, tests/container_service.py]
    command: [mcp]
"@
        $context.Compose += @('-f',$authOverlay)
        Invoke-DockerCommand ($context.Compose + @('up','-d','--no-build','--no-deps','--wait','--wait-timeout','90','mcp'))
        function Invoke-Journey([string]$Mode) {
            @(Get-LocalMcpFixtureContainers $context $Directory $images) | Out-Null
            $result = Invoke-DockerCommand @('run','--rm','--network',$context.Network,'--user',"$((& id -u).Trim()):$((& id -g).Trim())",
                '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--cpus','0.5',
                '--mount',"type=bind,source=$Directory,target=/work",'--entrypoint','python',$fixtureImage,'tests/container_journey.py',$Mode) -Capture -CaptureError
            [IO.File]::AppendAllText((Join-Path $Directory 'mcp-journeys.jsonl'),"$result`n")
            Protect-LocalPath (Join-Path $Directory 'mcp-journeys.jsonl')
            return $result
        }
        $journeys += Invoke-Journey 'cold'
        $journeys += Invoke-Journey 'capacity'
        $loaded = @(Get-LocalMcpFixtureContainers $context $Directory $images | Where-Object { $_.labels['com.docker.compose.service'] -ceq 'mcp' })[0]
        $loadResources = Invoke-DockerCommand @('exec',$loaded.id,'python','-c','import json;from pathlib import Path;p=Path("/sys/fs/cgroup");names=["memory.peak","memory.max","memory.events","cpu.max","cpu.stat","pids.current","pids.peak","pids.max"];print(json.dumps({name:(p.joinpath(name).read_text().strip() if p.joinpath(name).exists() else None) for name in names}))') -Capture
        Write-LocalText (Join-Path $Directory 'mcp-load-resources.json') $loadResources
        @(Get-LocalMcpFixtureContainers $context $Directory $images) | Out-Null
        Invoke-DockerCommand ($context.Compose + @('restart','--timeout','75','mcp'))
        Invoke-DockerCommand ($context.Compose + @('up','-d','--no-build','--no-deps','--wait','--wait-timeout','90','mcp'))
        $journeys += Invoke-Journey 'restart'
        # Retain old decryption material while independently rotating only encryption.
        $keyFile = Join-Path $context.State 'secrets/mcp-encryption'
        $keys = @([IO.File]::ReadAllText($keyFile) | ConvertFrom-Json)
        $newKey = & (Join-Path $Root 'mcp/.venv/bin/python') -c 'from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())'
        Write-LocalText $keyFile (ConvertTo-Json -InputObject @($newKey,$keys[0]) -Compress)
        Invoke-DockerCommand ($context.Compose + @('up','-d','--no-build','--no-deps','--force-recreate','--wait','--wait-timeout','90','mcp'))
        $journeys += Invoke-Journey 'encryption-rotation'
        Write-LocalText (Join-Path $context.State 'secrets/mcp-client') 'synthetic-independently-rotated-client-secret'
        Invoke-DockerCommand ($context.Compose + @('up','-d','--no-build','--no-deps','--force-recreate','--wait','--wait-timeout','90','mcp'))
        $journeys += Invoke-Journey 'confidential-rotation'
        @(Get-LocalMcpFixtureContainers $context $Directory $images) | Out-Null
        Invoke-DockerCommand ($context.Compose + @('restart','--timeout','75','app'))
        Invoke-DockerCommand ($context.Compose + @('up','-d','--no-build','--no-deps','--wait','--wait-timeout','90','app'))
        $journeys += Invoke-Journey 'api-restart'
        $journeys += Invoke-Journey 'revoke'
        Invoke-DockerCommand ($context.Compose + @('restart','--timeout','75','mcp'))
        Invoke-DockerCommand ($context.Compose + @('up','-d','--no-build','--no-deps','--wait','--wait-timeout','90','mcp'))
        $journeys += Invoke-Journey 'revoked'
        $journeys += Invoke-Journey 'reconnect'
        $signing = & (Join-Path $Root 'mcp/.venv/bin/python') -c 'from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())'
        Write-LocalText (Join-Path $context.State 'secrets/mcp-signing') $signing
        Invoke-DockerCommand ($context.Compose + @('up','-d','--no-build','--no-deps','--force-recreate','--wait','--wait-timeout','90','mcp'))
        $journeys += Invoke-Journey 'revoked'
        $journeys += Invoke-Journey 'reconnect'
        $resources = @(Get-LocalMcpFixtureContainers $context $Directory $images)
        $mcp = @($resources | Where-Object { $_.labels['com.docker.compose.service'] -ceq 'mcp' })[0]
        $stats = Invoke-DockerCommand @('stats','--no-stream','--format','{{json .}}',$mcp.id) -Capture
        Write-LocalText (Join-Path $Directory 'mcp-stats.json') $stats
        $measured = Invoke-DockerCommand @('exec',$mcp.id,'python','-c','import json;from pathlib import Path;from agent_control_mcp.config import Settings;from agent_control_mcp.storage import inspect_storage;s=Settings.from_env();files=list(s.storage_path.rglob("*"));assert all(p.stat().st_mode&0o077==0 for p in files);assert all(b"synthetic-upstream-refresh" not in p.read_bytes() and b"synthetic-confidential-client-secret" not in p.read_bytes() for p in files if p.is_file());print(json.dumps({"storage":inspect_storage(s.storage_path),"memoryPeakBytes":int(Path("/sys/fs/cgroup/memory.peak").read_text()),"memoryMax":Path("/sys/fs/cgroup/memory.max").read_text().strip(),"cpuMax":Path("/sys/fs/cgroup/cpu.max").read_text().strip()}))') -Capture
        Write-LocalText (Join-Path $Directory 'mcp-measured.json') $measured
        $drainId = Invoke-DockerCommand @('run','-d','--name',"$project-drain",'--label',"io.agent-control.fixture=$project",
            '--network',$context.Network,'--user',"$((& id -u).Trim()):$((& id -g).Trim())",'--read-only',
            '--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--cpus','0.5',
            '--mount',"type=bind,source=$Directory,target=/work",'--entrypoint','python',$fixtureImage,'tests/container_journey.py','drain') -Capture
        if ($drainId -cnotmatch '^[a-f0-9]{64}$') { throw 'Drain fixture did not return an exact container ID.' }
        $driver = Invoke-DockerCommand @('inspect','--format',
            '{"image":{{json .Image}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}}',$drainId) -Capture | ConvertFrom-Json -AsHashtable
        if ($driver.image -cne $fixtureImage -or $driver.labels['io.agent-control.fixture'] -cne $project -or
            $driver.mounts.Count -ne 1 -or $driver.mounts[0].Type -cne 'bind' -or $driver.mounts[0].Destination -cne '/work' -or
            -not (Test-LocalBindSource $driver.mounts[0].Source $Directory) -or -not $driver.mounts[0].RW -or
            $driver.networks.Count -ne 1 -or -not $driver.networks.Contains($context.Network)) { throw 'Drain fixture exact image/mount/network identity differs.' }
        Write-LocalText (Join-Path $Directory 'mcp-drain-client.json') ($driver | ConvertTo-Json -Depth 6)
        $deadline=[DateTime]::UtcNow.AddSeconds(20)
        while (-not (Test-Path -LiteralPath (Join-Path $Directory 'drain-started.json'))) {
            if ([DateTime]::UtcNow -ge $deadline) { throw 'Drain request did not start within its deadline.' }
            Start-Sleep -Milliseconds 100
        }
        Start-Sleep -Milliseconds 500
        $clock = [Diagnostics.Stopwatch]::StartNew()
        Invoke-DockerCommand ($context.Compose + @('stop','--timeout','75','mcp'))
        $clock.Stop()
        $exitCode = Invoke-DockerCommand @('wait',$drainId) -Capture
        $drain = Invoke-DockerCommand @('logs',$drainId) -Capture -CaptureError
        Write-LocalText (Join-Path $Directory 'mcp-drain.json') $drain
        if ($exitCode -cne '0' -or $clock.Elapsed.TotalSeconds -lt 1 -or $clock.Elapsed.TotalSeconds -gt 75) { throw 'In-flight authenticated MCP call did not finish within bounded graceful shutdown.' }
        $drainOwner = Invoke-DockerCommand @('inspect','--format','{{index .Config.Labels "io.agent-control.fixture"}}',$drainId) -Capture
        if ($drainOwner -cne $project) { throw 'Drain client ownership changed.' }
        Invoke-DockerCommand @('rm',$drainId) | Out-Null
        $drainId=$null
        $resources = @(Get-LocalMcpFixtureContainers $context $Directory $images)
        if (@($resources | Where-Object { $_.labels['com.docker.compose.service'] -ceq 'mcp' -and ($_.state.Running -or $_.state.ExitCode -ne 0 -or $_.state.OOMKilled) }).Count) { throw 'MCP did not drain cleanly.' }
        $app = @($resources | Where-Object { $_.labels['com.docker.compose.service'] -ceq 'app' })[0]
        Invoke-DockerCommand @('exec',$app.id,'python','-c','import urllib.request;assert urllib.request.urlopen("http://127.0.0.1:3001/api/ready").status==200;assert urllib.request.urlopen("http://127.0.0.1:3001/").status==200;print("independent synthetic API/web passed with MCP stopped")')
        $secret = Join-Path $context.State 'secrets/mcp-signing'
        [IO.File]::SetUnixFileMode($secret,[IO.UnixFileMode]420)
        $denied = $false
        try { Test-LocalMcpConfiguration $context } catch { if ($_.Exception.Message -notmatch 'Secret file must be an owned 0600 regular file') { throw }; $denied=$true }
        Write-LocalText $secret ([IO.File]::ReadAllText($secret))
        if (-not $denied) { throw 'Production image accepted a world-readable signing credential.' }
        Invoke-DockerCommand (@('run','--rm','--network','none') + (Get-LocalMcpRunArguments $context) +
            @('--entrypoint','python',$context.McpImageId,'-c','from pathlib import Path;Path("/var/lib/agent-control-mcp/oauth").chmod(0o755)'))
        $denied = $false
        try { Test-LocalMcpConfiguration $context } catch { if ($_.Exception.Message -notmatch 'Existing OAuth volume ownership/mode differs') { throw }; $denied=$true }
        Invoke-DockerCommand (@('run','--rm','--network','none') + (Get-LocalMcpRunArguments $context) +
            @('--entrypoint','python',$context.McpImageId,'-c','from pathlib import Path;Path("/var/lib/agent-control-mcp/oauth").chmod(0o700)'))
        if (-not $denied) { throw 'Production image accepted or silently repaired an insecure existing state volume.' }
        Test-LocalMcpConfiguration $context
        Write-LocalText (Join-Path $Directory 'mcp-denials.json') (@{unprotectedSecretRefused=$true;insecureStateRefused=$true;protectedConfigurationRecovered=$true} | ConvertTo-Json)
        Write-LocalText (Join-Path $Directory 'mcp-journeys.json') (@{journeys=$journeys;shutdownSeconds=$clock.Elapsed.TotalSeconds;outcome='passed'} | ConvertTo-Json -Depth 5)
    } catch { $cleanupFailures++; $failures.Add($_.Exception) }
    finally {
        if ($started) {
            try {
                if ($drainId) {
                    if ((Invoke-DockerCommand @('inspect','--format','{{index .Config.Labels "io.agent-control.fixture"}}',$drainId) -Capture) -cne $project -or
                        (Invoke-DockerCommand @('inspect','--format','{{.Image}}',$drainId) -Capture) -cne $fixtureImage) { throw 'Drain client identity differs; cleanup refused.' }
                    Invoke-DockerCommand @('stop','--time','10',$drainId) | Out-Null
                    Invoke-DockerCommand @('rm',$drainId) | Out-Null
                }
                $resources = @(Get-LocalMcpFixtureContainers $context $Directory $images)
                Write-LocalText (Join-Path $Directory 'mcp-final.json') ($resources | ConvertTo-Json -Depth 12)
                Invoke-DockerCommand ($context.Compose + @('logs','--no-color','--tail','150')) -Capture -CaptureError |
                    ForEach-Object { Write-LocalText (Join-Path $Directory 'mcp-logs.txt') (ConvertTo-RedactedFixtureLog $_) }
                $networkLabels = Invoke-DockerCommand @('network','inspect','--format','{{json .Labels}}',$context.Network) -Capture | ConvertFrom-Json -AsHashtable
                if ($networkLabels['com.docker.compose.project'] -cne $project -or $networkLabels['com.docker.compose.network'] -cne 'default' -or
                    (Invoke-DockerCommand @('network','inspect','--format','{{.Internal}}',$context.Network) -Capture) -cne 'true') { throw 'MCP fixture network identity changed; cleanup refused.' }
                Invoke-DockerCommand ($context.Compose + @('down','--timeout','75'))
                if (@(Get-LocalMcpFixtureContainers $context $Directory $images).Count) { throw 'MCP fixture containers remain.' }
            } catch { $failures.Add($_.Exception) }
        }
        try {
            Assert-LocalMcpFixtureEngine
            if ($context.McpVolume -in ((Invoke-DockerCommand @('volume','ls','--format','{{.Name}}') -Capture) -split "`n")) {
                $labels = Invoke-DockerCommand @('volume','inspect','--format','{{json .Labels}}',$context.McpVolume) -Capture | ConvertFrom-Json -AsHashtable
                if ($labels['com.docker.compose.project'] -cne $project -or $labels['com.docker.compose.volume'] -cne 'mcp-oauth' -or
                    $labels['io.agent-control.purpose'] -cne 'encrypted-oauth-state') { throw 'MCP fixture volume ownership changed; cleanup refused.' }
                Get-LocalMcpVolume $context | Out-Null
                Invoke-DockerCommand @('volume','rm',$context.McpVolume)
            }
            foreach ($tag in $images.Keys) {
                if ((Invoke-DockerCommand @('image','inspect','--format','{{.Id}}',$tag) -Capture) -cne $images[$tag]) { throw 'MCP fixture image changed; cleanup refused.' }
                Invoke-DockerCommand @('image','rm',$tag)
            }
            if ((Test-Path -LiteralPath $context.State) -and -not (Get-Item -LiteralPath $context.State -Force).LinkType) { Remove-Item -LiteralPath $context.State -Recurse -Force }
            foreach ($name in @('key.json','signing','encryption','connection.json')) {
                $path = Join-Path $Directory $name
                if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
            }
            if ($snapshot) { Remove-Item -LiteralPath $snapshot.Directory -Recurse -Force }
        } catch { $cleanupFailures++; $failures.Add($_.Exception) }
        Write-LocalText (Join-Path $Directory 'mcp-result.json') (@{project=$project;outcome=$(if ($failures.Count) {'failed'} else {'passed'});images=$images;failures=@($failures | ForEach-Object Message);cleaned=($cleanupFailures -eq 0)} | ConvertTo-Json -Depth 5)
    }
    if ($failures.Count) { throw [AggregateException]::new('MCP disposable integration failed.',$failures) }
    Write-Host "MCP container journeys passed; exact fixture cleaned. Evidence: $Directory"
}
