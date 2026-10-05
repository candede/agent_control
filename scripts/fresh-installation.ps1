function Assert-FreshInstallationContext {
    param($Context,[string]$Directory)
    if ($Context.Project -cnotmatch '^ac-ltdp-install-[a-f0-9]{12}$' -or
        $Context.State -cne (Join-Path $Context.Root ".local/$($Context.Project)") -or
        $Context.Volume -cne "$($Context.Project)_data" -or $Context.Network -cne "$($Context.Project)_default" -or
        $Context.Image -cne "$($Context.Project)-app:local" -or $Context.Operator -cne "$($Context.Project)-operator:local" -or $Context.Checks -cne "$($Context.Project)-checks:local" -or
        $Context.Port -in @(3001,3002) -or $Context.Port -lt 1024 -or $Context.Port -gt 65535 -or
        -not ([IO.Path]::GetFullPath($Directory).StartsWith((Join-Path $Context.Root 'artifacts') + [IO.Path]::DirectorySeparatorChar))) {
        throw 'Fresh installation requires its exact synthetic project, state, images, resources and non-retained loopback port.'
    }
    foreach ($path in @($Context.State,$Directory,(Join-Path $Context.Root '.local'),(Join-Path $Context.Root 'artifacts'),(Split-Path $Directory -Parent))) {
        if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path -Force).LinkType) { throw 'Fresh installation paths must not be links.' }
    }
}

function Assert-FreshInstallationAbsent {
    param($Context,[string]$Directory)
    Assert-FreshInstallationContext $Context $Directory
    if (Test-Path -LiteralPath $Context.State) { throw 'Fresh installation state already exists; never reuse an installation.' }
    foreach ($receipt in @(Get-ChildItem -LiteralPath (Join-Path $Context.Root 'artifacts/large-tenant-data-platform') -Filter ownership.json -Recurse -File -ErrorAction SilentlyContinue)) {
        if ((Get-Content -LiteralPath $receipt.FullName -Raw | ConvertFrom-Json).project -ceq $Context.Project) {
            throw 'Fresh installation identity was previously used; allocate a new identity.'
        }
    }
    foreach ($kind in @('volume','network')) {
        $expected = if ($kind -eq 'volume') { $Context.Volume } else { $Context.Network }
        $names = Invoke-DockerCommand @($kind,'ls','--format','{{.Name}}') -Capture
        if ($expected -in ($names -split "`n")) { throw 'Fresh installation resource already exists.' }
    }
    $ids = Invoke-DockerCommand @('ps','-aq','--filter',"label=com.docker.compose.project=$($Context.Project)") -Capture
    $names = Invoke-DockerCommand @('ps','-a','--format','{{.Names}}') -Capture
    if ($ids -or @($names -split "`n" | Where-Object { $_ -like "$($Context.Project)-*" }).Count) { throw 'Fresh installation containers already exist.' }
    $tags = Invoke-DockerCommand @('image','ls','--format','{{.Repository}}:{{.Tag}}') -Capture
    if ($Context.Image -in ($tags -split "`n") -or $Context.Operator -in ($tags -split "`n") -or $Context.Checks -in ($tags -split "`n")) { throw 'Fresh installation images already exist.' }
    Assert-LocalPort $Context.Port
}

function Assert-FreshInstallationContainer {
    param($Context,$Container)
    $labels = $Container.Config.Labels
    $service = $labels.'com.docker.compose.service'
    $composeFiles = if ($Context.AppliedComposeFiles) { $Context.AppliedComposeFiles } else { @((Join-Path $Context.Root 'compose.yaml'),$Context.FixtureCompose) }
    if ($labels.'com.docker.compose.project' -cne $Context.Project -or $service -notin @('app','postgres') -or
        $labels.'com.docker.compose.project.working_dir' -cne $Context.Root -or
        $Container.Name -cne "/$($Context.Project)-$service-1" -or
        $Container.Id -cnotmatch '^[a-f0-9]{64}$' -or
        $labels.'com.docker.compose.project.config_files' -cne ($composeFiles -join ',')) {
        throw 'Fresh installation container metadata differs; cleanup refused.'
    }
    $expected = if ($service -eq 'postgres') {
        @{ '/var/lib/postgresql/data'=$Context.Volume; '/run/secrets/postgres-admin'=(Join-Path $Context.State 'secrets/postgres-admin') }
    } else {
        @{ '/run/control'=(Join-Path $Context.State 'control'); '/run/secrets/tenants.json'=(Join-Path $Context.State 'secrets/tenants.json')
            '/run/secrets/session'=(Join-Path $Context.State 'secrets/session'); '/run/secrets/postgres-app'=(Join-Path $Context.State 'secrets/postgres-app') }
    }
    if (@($Container.Mounts).Count -ne $expected.Count) { throw 'Fresh installation mount count differs; cleanup refused.' }
    foreach ($mount in $Container.Mounts) {
        if (-not $expected.ContainsKey($mount.Destination)) { throw 'Unexpected fresh installation mount; cleanup refused.' }
        if ($mount.Destination -eq '/var/lib/postgresql/data') {
            if ($mount.Type -cne 'volume' -or $mount.Name -cne $expected[$mount.Destination]) { throw 'Fresh installation requires its exact owned disk-backed data volume.' }
        } elseif ($mount.Type -cne 'bind' -or $mount.RW -or $mount.Source -cne $expected[$mount.Destination]) {
            throw 'Fresh installation has an unexpected configuration mount; cleanup refused.'
        }
    }
    $ports = $Container.HostConfig.PortBindings
    if ($service -eq 'app') {
        if ($labels.'io.agent-control.fixture' -cne $Context.Project -or
            $labels.'io.agent-control.source-sha256' -cne $Context.SourceHash) { throw 'Fresh runtime source identity differs.' }
        if (@($ports.PSObject.Properties).Count -ne 1 -or @($ports.'3001/tcp').Count -ne 1 -or
            $ports.'3001/tcp'[0].HostIp -cne '127.0.0.1' -or $ports.'3001/tcp'[0].HostPort -cne [string]$Context.Port -or
            $Container.HostConfig.Memory -ne 1610612736 -or $Container.HostConfig.NanoCpus -ne 1500000000) {
            throw 'Fresh application port or fixed resource budget differs.'
        }
    } elseif (@($ports.PSObject.Properties).Count -or $Container.HostConfig.Memory -ne 1073741824 -or $Container.HostConfig.NanoCpus -ne 500000000) {
        throw 'Fresh PostgreSQL port or fixed resource budget differs.'
    }
    if (@($Container.NetworkSettings.Networks.PSObject.Properties).Count -ne 1 -or
        -not $Container.NetworkSettings.Networks.PSObject.Properties[$Context.Network]) { throw 'Fresh installation network differs.' }
}

function Get-FreshInstallationResources {
    param($Context,[string]$Directory)
    Assert-FreshInstallationContext $Context $Directory
    $containers = @()
    $ids = Invoke-DockerCommand @('ps','-aq','--no-trunc','--filter',"label=com.docker.compose.project=$($Context.Project)") -Capture
    foreach ($id in ($ids -split "`n" | Where-Object { $_ })) {
        # Exclude environment variables and secret values from persisted evidence.
        $container = Invoke-DockerCommand @('inspect','--format',
            '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"Config":{"Labels":{{json .Config.Labels}}},"State":{{json .State}},"RestartCount":{{json .RestartCount}},"Mounts":{{json .Mounts}},"HostConfig":{"Memory":{{json .HostConfig.Memory}},"NanoCpus":{{json .HostConfig.NanoCpus}},"PortBindings":{{json .HostConfig.PortBindings}}},"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}}}}',$id) -Capture | ConvertFrom-Json
        Assert-FreshInstallationContainer $Context $container
        $containers += $container
    }
    if ($containers.Count -gt 2) { throw 'Unexpected extra containers; cleanup refused.' }
    $resources = @{}
    foreach ($kind in @('volume','network')) {
        $expected = if ($kind -eq 'volume') { $Context.Volume } else { $Context.Network }
        $names = Invoke-DockerCommand @($kind,'ls','--format','{{.Name}}') -Capture
        $owned = Invoke-DockerCommand @($kind,'ls','--filter',"label=com.docker.compose.project=$($Context.Project)",'--format','{{.Name}}') -Capture
        if (@($owned -split "`n" | Where-Object { $_ -and $_ -cne $expected }).Count) { throw 'Unexpected owned resource; cleanup refused.' }
        if ($expected -in ($names -split "`n")) {
            $labels = Invoke-DockerCommand @($kind,'inspect','--format','{{json .Labels}}',$expected) -Capture | ConvertFrom-Json
            $key = if ($kind -eq 'volume') { 'com.docker.compose.volume' } else { 'com.docker.compose.network' }
            $logical = if ($kind -eq 'volume') { 'data' } else { 'default' }
            if ($labels.'com.docker.compose.project' -cne $Context.Project -or $labels.$key -cne $logical) { throw 'Fresh resource ownership differs; cleanup refused.' }
            if ($kind -eq 'network') {
                if ((Invoke-DockerCommand @('network','inspect','--format','{{.Internal}}',$expected) -Capture) -cne 'true') { throw 'Fresh installation requires an internal network.' }
                $members = Invoke-DockerCommand @('network','inspect','--format','{{json .Containers}}',$expected) -Capture | ConvertFrom-Json
                if (@($members.PSObject.Properties | Where-Object { $_.Name -notin $containers.Id }).Count) { throw 'Foreign network member; cleanup refused.' }
            }
            $resources[$kind] = $expected
        }
    }
    return @{containers=$containers;resources=$resources}
}

function Write-FreshInstallationEvidence {
    param($Context,[string]$Directory,[string]$Stage)
    $snapshot = Get-FreshInstallationResources $Context $Directory
    Write-LocalText (Join-Path $Directory "$Stage-resources.json") ($snapshot | ConvertTo-Json -Depth 15)
    foreach ($container in $snapshot.containers) {
        Write-LocalText (Join-Path $Directory "$Stage-$($container.Id).log") (Get-RedactedFixtureLog $container.Id '500')
        if ($container.State.Running) {
            $metrics = Invoke-DockerCommand @('exec',$container.Id,'sh','-c',
                'for f in memory.current memory.peak memory.max memory.events; do printf "%s\n" "$f"; cat "/sys/fs/cgroup/$f"; done') -Capture
            Write-LocalText (Join-Path $Directory "$Stage-$($container.Id)-cgroup.log") $metrics
        }
    }
    return $snapshot
}

function Wait-FreshInstallationHealth {
    param($Context,[string]$Directory)
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        $snapshot = Get-FreshInstallationResources $Context $Directory
        if ($snapshot.containers.Count -ne 2 -or @($snapshot.containers | Where-Object { $_.State.OOMKilled }).Count) {
            throw 'Fresh installation lost a container or observed an OOM during restart.'
        }
        if (-not @($snapshot.containers | Where-Object { $_.State.Health.Status -cne 'healthy' }).Count) { return }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Fresh installation did not regain health within the existing 90-second readiness bound.'
}

function Get-FreshLifecycleProgress {
    param($Context)
    return Invoke-DockerCommand ($Context.Compose + @('exec','-T','postgres','psql','-U','agentcontrol_admin','-d','agentcontrol','-At','-v','ON_ERROR_STOP=1','-c',
        'SELECT json_agg(p ORDER BY worker) FROM (SELECT worker,slices,rows_collected,bytes_collected FROM data_lifecycle_progress) p;')) -Capture | ConvertFrom-Json
}

function Assert-FreshRestartPersistence {
    param($Before,$After,$ProgressBefore,$ProgressAfter)
    if ($Before.schemaFingerprint -cnotmatch '^[a-f0-9]{64}$' -or $Before.schemaFingerprint -cne $After.schemaFingerprint) {
        throw 'Fresh schema fingerprint changed across restart or is invalid.'
    }
    $names = @($Before.tables.PSObject.Properties.Name | Sort-Object)
    if (($names -join ',') -cne (@($After.tables.PSObject.Properties.Name | Sort-Object) -join ',')) { throw 'Fresh table inventory changed across restart.' }
    foreach ($name in $names) {
        $left = $Before.tables.$name; $right = $After.tables.$name
        if ($left.count -ne $right.count -or ($name -cne 'data_lifecycle_progress' -and $left.hash -cne $right.hash)) {
            throw "Fresh persisted table changed across restart: $name."
        }
    }
    if (@($ProgressBefore).Count -ne 6 -or @($ProgressAfter).Count -ne 6) { throw 'Lifecycle progress worker inventory changed.' }
    for ($index=0; $index -lt 6; $index++) {
        $left=$ProgressBefore[$index]; $right=$ProgressAfter[$index]
        $slices = $right.slices - $left.slices
        $rows = $right.rows_collected - $left.rows_collected
        $bytes = $right.bytes_collected - $left.bytes_collected
        if ($left.worker -cne $right.worker -or $slices -lt 0 -or $rows -lt 0 -or $bytes -lt 0 -or
            $rows -gt 1000*$slices -or $bytes -gt 1048576*$slices) {
            throw 'Fresh lifecycle progress regressed or exceeded its existing per-slice bounds.'
        }
    }
}

function Remove-FreshInstallation {
    param($Context,[string]$Directory,$Images)
    $snapshot = Write-FreshInstallationEvidence $Context $Directory 'final'
    if ($snapshot.containers.Count -or $snapshot.resources.Count) {
        Invoke-DockerCommand ($Context.Compose + @('down','--volumes','--timeout','130'))
    }
    $remaining = Get-FreshInstallationResources $Context $Directory
    if ($remaining.containers.Count -or $remaining.resources.Count) { throw 'Fresh installation resources remain after cleanup.' }
    foreach ($tag in $Images.Keys) {
        if ((Invoke-DockerCommand @('image','inspect','--format','{{.Id}}',$tag) -Capture) -cne $Images[$tag]) { throw 'Fresh image changed before cleanup; removal refused.' }
        Invoke-DockerCommand @('image','rm',$tag)
    }
    if ((Get-Item -LiteralPath $Context.State).LinkType) { throw 'Fresh state changed to a link; removal refused.' }
    Remove-Item -LiteralPath $Context.State -Recurse -Force
    Write-LocalText (Join-Path $Directory 'cleanup.json') (@{project=$Context.Project;containers=0;volumes=0;networks=0;stateRemoved=$true;imagesRemoved=@($Images.Keys);at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json)
}

function Invoke-FreshInstallation {
    param([string]$Root,[string]$Directory,[string]$Baseline)
    $project = "ac-ltdp-install-$([Guid]::NewGuid().ToString('N').Substring(0,12))"
    $context = New-LocalContext $Root $project
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    try { $listener.Start(); $context.Port = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
    Assert-FreshInstallationAbsent $context $Directory
    Write-LocalText (Join-Path $Directory 'ownership.json') (@{project=$project;state=$context.State;port=$context.Port;createdAt=[DateTime]::UtcNow.ToString('o');priorResourcesAbsent=$true} | ConvertTo-Json)
    New-Item -ItemType Directory -Path $context.State -ErrorAction Stop | Out-Null
    Protect-LocalPath $context.State -Directory
    $images = @{}
    $failures = [Collections.Generic.List[Exception]]::new()
    try {
        $profile = @{tenantId=[Guid]::NewGuid().ToString();clientId=[Guid]::NewGuid().ToString();clientSecret='synthetic-installation-client-secret';domains=@('example.invalid');displayName='Synthetic installation'}
        [IO.Directory]::CreateDirectory((Join-Path $context.State 'secrets')) | Out-Null
        Protect-LocalPath (Join-Path $context.State 'secrets') -Directory
        Write-LocalText (Join-Path $context.State 'secrets/tenants.json') (ConvertTo-Json -InputObject @($profile) -Depth 5)
        Write-LocalText (Join-Path $context.State 'settings.json') (@{port=$context.Port;publicUrl='';tenants=@(Get-LocalTenantMetadata @($profile))} | ConvertTo-Json -Depth 5)
        $context.FixtureCompose = Join-Path $Directory 'fresh.yaml'
        Write-LocalText $context.FixtureCompose @'
services:
  postgres:
    mem_limit: 1024m
    cpus: 0.5
    command: [postgres, -c, shared_buffers=32MB, -c, min_wal_size=32MB, -c, max_wal_size=1GB]
  app:
    mem_limit: 1536m
    cpus: 1.5
    environment:
      NODE_OPTIONS: --max-old-space-size=768
networks:
  default:
    internal: true
'@
        $context.Compose += @('-f',$context.FixtureCompose)
        $context.SourceEvidenceFile = Join-Path $Directory 'source.json'
        $context.DependencyImage = $Baseline
        $context.DependencyImageId = Invoke-DockerCommand @('image','inspect','--format','{{.Id}}',$Baseline) -Capture
        $context.DependencyHashes = Get-LocalDependencyManifests $context.DependencyImageId
        $context.BuildArguments = @('--network','none','--build-arg',"DEPENDENCY_BASE=$Baseline",'--build-arg','REUSE_INSTALLED_DEPENDENCIES=1','--label',"io.agent-control.fixture=$project")
        $context.OperatorArguments = @('--memory','1536m','--cpus','1.5','-e','NODE_OPTIONS=--max-old-space-size=768')
        $context.IsolatedHealthContainer = "$project-app-1"
        Write-Host "Fresh installation: $project; evidence: $Directory; loopback port: $($context.Port)"
        Invoke-LocalDeployment -Context $context -Action Deploy -ForceChecks
        $snapshot = Write-FreshInstallationEvidence $context $Directory 'ready'
        if ($snapshot.containers.Count -ne 2 -or @($snapshot.containers | Where-Object { $_.State.Health.Status -cne 'healthy' -or $_.State.OOMKilled }).Count) { throw 'Fresh installation is not healthy.' }
        $schema = Invoke-LocalOperator $context @('backend/scripts/database.ts','preflight') -Capture | ConvertFrom-Json
        if ($schema.state -cne 'current' -or $schema.targetFingerprint -cnotmatch '^[a-f0-9]{64}$' -or
            $schema.currentFingerprint -cne $schema.targetFingerprint) { throw 'Fresh installation does not match the compiled schema fingerprint.' }
        Write-LocalText (Join-Path $Directory 'schema.json') ($schema | ConvertTo-Json)
        $runtimeFiles = Invoke-DockerCommand @('exec',"$project-app-1",'node','-e',
            'const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),out={};function visit(p){for(const e of fs.readdirSync(p,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const f=path.join(p,e.name);if(e.isDirectory())visit(f);else if(e.isFile())out[f]=crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");}}visit("backend/dist");visit("frontend/dist");console.log(JSON.stringify(out));') -Capture
        Write-LocalText (Join-Path $Directory 'runtime-files.json') $runtimeFiles
        $observations = @()
        foreach ($route in @('/api/ready','/api/auth/status','/api/agents')) {
            $response = Get-IsolatedLocalHttp $context.IsolatedHealthContainer $route
            $expected = if ($route -eq '/api/agents') { 401 } else { 200 }
            if ($response.status -ne $expected) { throw "Fresh runtime status mismatch: $route ($($response.status))." }
            $observations += @{route=$route;status=$response.status;body=$response.body;transport='actual runtime HTTP inside isolated network; host publication unavailable on this Docker engine'}
        }
        Write-LocalText (Join-Path $Directory 'http.json') ($observations | ConvertTo-Json -Depth 5)
        $backup = Join-Path $context.State 'backups/fresh.dump'
        $progressBefore = @(Get-FreshLifecycleProgress $context)
        Invoke-LocalDeployment -Context $context -Action Backup -BackupFile $backup
        $before = Get-Content -LiteralPath "$backup.json" -Raw | ConvertFrom-Json
        if ($before.schemaFingerprint -cne $schema.targetFingerprint -or $before.tables.app_schema.count -ne 1) {
            throw 'Fresh backup does not record the exact compiled schema and singleton marker.'
        }
        Copy-Item -LiteralPath "$backup.json" -Destination (Join-Path $Directory 'backup-before.json')
        Invoke-DockerCommand ($context.Compose + @('restart','--timeout','130','app','postgres'))
        Wait-FreshInstallationHealth $context $Directory
        $health = Get-LocalHealth $context.Url -IsolatedContainer $context.IsolatedHealthContainer
        if (-not $health.authConfigured) { throw 'Fresh sign-in configuration did not persist.' }
        $afterBackup = Join-Path $context.State 'backups/restarted.dump'
        Invoke-LocalDeployment -Context $context -Action Backup -BackupFile $afterBackup
        $after = Get-Content -LiteralPath "$afterBackup.json" -Raw | ConvertFrom-Json
        $progressAfter = @(Get-FreshLifecycleProgress $context)
        Copy-Item -LiteralPath "$afterBackup.json" -Destination (Join-Path $Directory 'backup-restarted.json')
        Write-LocalText (Join-Path $Directory 'restart-progress.json') (@{before=$progressBefore;after=$progressAfter;interpretation='Only scheduled lifecycle metadata may advance within existing 1000-row/1-MiB slice bounds; all other table fingerprints and all row counts must match.'} | ConvertTo-Json -Depth 5)
        Assert-FreshRestartPersistence $before $after $progressBefore $progressAfter
        $restore = 'agentcontrol_restore_' + ($project -replace '^ac-ltdp-install-','')
        Invoke-LocalDeployment -Context $context -Action Restore -BackupFile $backup -RestoreDatabase $restore
        Write-LocalText (Join-Path $Directory 'result.json') (@{suite='fresh-installation';project=$project;deploy='passed';reset=$false;schemaFingerprint=$schema.targetFingerprint;tables=@($before.tables.PSObject.Properties).Count;restartFingerprints='passed';restore=$restore;authenticatedWorkflow='separate isolated gate fixtures; no real sign-in';syntheticSoak='waived by user';at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json)
    } catch { $failures.Add($_.Exception) }
    finally {
        foreach ($tag in @($context.Operator,$context.Image,$context.Checks)) {
            $tags = Invoke-DockerCommand @('image','ls','--format','{{.Repository}}:{{.Tag}}') -Capture
            if ($tag -in ($tags -split "`n")) {
                $label = Invoke-DockerCommand @('image','inspect','--format','{{index .Config.Labels "io.agent-control.fixture"}}',$tag) -Capture
                if ($label -cne $project) { $failures.Add([Exception]::new('Fresh image ownership changed; cleanup refused.')); continue }
                $images[$tag] = Invoke-DockerCommand @('image','inspect','--format','{{.Id}}',$tag) -Capture
            }
        }
        Write-LocalText (Join-Path $Directory 'images.json') ($images | ConvertTo-Json)
        try { Remove-FreshInstallation $context $Directory $images } catch { $failures.Add($_.Exception) }
    }
    if ($failures.Count) {
        Write-LocalText (Join-Path $Directory 'failures.json') (ConvertTo-Json -InputObject @($failures | ForEach-Object { Get-FixtureFailureMessages $_ }))
        throw [AggregateException]::new('Fresh installation failed; inspect preserved evidence.',$failures)
    }
    Write-Host "Fresh installation and exact-owned cleanup passed: $Directory"
}
