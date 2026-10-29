function Get-LocalSourceFiles {
    param([string]$Root)
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required to snapshot tracked and untracked build inputs without copying local secrets or installed dependencies.' }
    $output = @(& git -C $Root ls-files -z --cached --others --exclude-standard -- backend frontend mcp scripts docs infra Dockerfile .dockerignore compose.yaml compose.mcp.yaml compose.large-tenant-test.yaml package.json package-lock.json knip.json deploy-local.ps1 deploy-azure.ps1 README.md)
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate deployment source files.' }
    foreach ($path in (($output -join "`n") -split "`0" | Where-Object { $_ } | Sort-Object -Unique)) {
        if ($path -match '[\\\r\n]' -or [IO.Path]::IsPathRooted($path) -or $path -match '(^|/)\.\.(/|$)') { throw 'Build input paths must remain inside the repository.' }
        if ($path -match '(^|/)(node_modules|dist|coverage|artifacts|backups|\.git|\.local|\.azure|\.venv|__pycache__|\.pytest_cache|\.ruff_cache|\.mypy_cache|tsx-[0-9]+)(/|$)|(^|/)\.env[^/]*$|(^|/)\.npmrc$|\.(pem|pfx|key|csv|pyc|db|sqlite[^/]*)$') { continue }
        $file = Join-Path $Root $path
        if (-not (Test-Path -LiteralPath $file)) { continue }
        if ((Get-Item -LiteralPath $file -Force).LinkType) { throw "Symbolic build input is not supported: $path." }
        if (Test-Path -LiteralPath $file -PathType Leaf) { $path }
    }
}

function New-LocalBuildSnapshot {
    param($Context)
    $directory = Join-Path $Context.Root "artifacts/local-builds/$([Guid]::NewGuid().ToString('N'))"
    $source = Join-Path $directory 'source'
    [IO.Directory]::CreateDirectory($source) | Out-Null
    Protect-LocalPath $directory -Directory
    try {
        $paths = @(Get-LocalSourceFiles $Context.Root)
        if ($paths -notcontains 'Dockerfile' -or $paths -notcontains 'compose.yaml') { throw 'Deployment source is missing Dockerfile or compose.yaml.' }
        $hashes = [ordered]@{}
        foreach ($path in $paths) {
            $destination = Join-Path $source $path
            [IO.Directory]::CreateDirectory((Split-Path $destination -Parent)) | Out-Null
            [IO.File]::Copy((Join-Path $Context.Root $path),$destination)
            $hashes[$path] = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
        }
        $currentPaths = @(Get-LocalSourceFiles $Context.Root)
        if (($paths -join "`n") -cne ($currentPaths -join "`n")) { throw 'Source files changed while preparing the deployment snapshot. Retry after saving your changes.' }
        foreach ($path in $paths) {
            if ($hashes[$path] -cne (Get-FileHash -LiteralPath (Join-Path $Context.Root $path) -Algorithm SHA256).Hash) {
                throw "Source changed while preparing the deployment snapshot: $path. Retry after saving your changes."
            }
        }
        $compose = @($Context.Compose)
        $composeFiles = @()
        for ($index = 0; $index -lt $compose.Count - 1; $index++) {
            if ($compose[$index] -ne '-f') { continue }
            $original = $compose[$index+1]
            $copy = if ([IO.Path]::GetFullPath($original) -cin @((Join-Path $Context.Root 'compose.yaml'),(Join-Path $Context.Root 'compose.mcp.yaml'))) { Join-Path $source ([IO.Path]::GetFileName($original)) }
                else { Join-Path $source "local-compose-$($composeFiles.Count).yaml" }
            if (-not (Test-Path -LiteralPath $copy)) { [IO.File]::Copy($original,$copy) }
            if ((Get-FileHash -LiteralPath $copy).Hash -cne (Get-FileHash -LiteralPath $original).Hash) { throw 'Compose inputs changed while preparing the deployment snapshot.' }
            $compose[$index+1] = $copy
            $composeFiles += $copy
            $hashes[[IO.Path]::GetFileName($copy)] = (Get-FileHash -LiteralPath $copy).Hash
        }
        if ($Context.SourceEvidenceFile) {
            Write-LocalText $Context.SourceEvidenceFile ($hashes | ConvertTo-Json)
            $Context.SourceHash = (Get-FileHash -LiteralPath $Context.SourceEvidenceFile).Hash.ToLowerInvariant()
            $Context.BuildArguments += @('--label',"io.agent-control.source-sha256=$($Context.SourceHash)")
        }
        return @{ Directory=$directory; Root=$source; Compose=$compose; ComposeFiles=$composeFiles }
    } catch {
        Remove-Item -LiteralPath $directory -Recurse -Force
        throw
    }
}

function Build-LocalArtifact {
    param($Context,$Snapshot,[string]$Target,[string]$Tag,[string[]]$BuildArguments)
    $identityFile = Join-Path $Snapshot.Directory "$Target.iid"
    Assert-LocalDependencyImage $Context
    # Timestamped default attestations otherwise change the index ID on an identical local rebuild.
    Invoke-DockerCommand (@('build','--provenance=false') + $BuildArguments + @('--target',$Target,'--iidfile',$identityFile,'-t',$Tag,$Snapshot.Root)) |
        ForEach-Object { Write-Host $_ }
    Assert-LocalDependencyImage $Context
    $identity = [IO.File]::ReadAllText($identityFile).Trim()
    if ($identity -cnotmatch '^sha256:[a-f0-9]{64}$') { throw "The $Target build did not produce an immutable image identity." }
    return $identity
}

function Get-LocalSha256 {
    param([string]$Value)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()
}

function Read-LocalCandidate {
    param($Context)
    $file = [IO.Path]::GetFullPath($Context.Candidate)
    if ($Context.CandidateSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        (Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant() -cne $Context.CandidateSha256) { throw 'Candidate digest mismatch.' }
    $candidate = [IO.File]::ReadAllText($file) | ConvertFrom-Json -AsHashtable
    if ($candidate.schemaContract -cne 'current-only' -or $candidate.ContainsKey('upgradeFiles') -or
        $candidate.schemaFingerprint -cnotmatch '^[a-f0-9]{64}$' -or
        $candidate.sourceManifestHash -cnotmatch '^[a-f0-9]{64}$' -or $candidate.builtFilesHash -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Candidate schema or content identity is invalid.'
    }
    foreach ($path in @($file,$candidate.sourceRoot,$candidate.sourceManifest)) {
        if ((Get-Item -LiteralPath $path -Force).LinkType -or
            -not ([IO.Path]::GetFullPath($path).StartsWith((Join-Path $Context.Root 'artifacts') + [IO.Path]::DirectorySeparatorChar,[StringComparison]::Ordinal))) {
            throw 'Candidate inputs must remain in this repository non-linked artifact tree.'
        }
    }
    if ((Get-FileHash -LiteralPath $candidate.sourceManifest).Hash.ToLowerInvariant() -cne $candidate.sourceManifestHash) { throw 'Candidate source manifest changed.' }
    $manifest = [IO.File]::ReadAllText($candidate.sourceManifest) | ConvertFrom-Json -AsHashtable
    if (-not $manifest.Count -or -not $manifest.Contains('compose.yaml') -or -not $manifest.Contains('deploy-local.ps1')) { throw 'Candidate source inventory is incomplete.' }
    foreach ($path in $manifest.Keys) {
        if ($path -match '(^|/)\.\.(/|$)|[\\\r\n]' -or [IO.Path]::IsPathRooted($path)) { throw 'Invalid candidate source path.' }
        $source = Join-Path $candidate.sourceRoot $path
        if ((Get-Item -LiteralPath $source -Force).LinkType -or
            (Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant() -cne ([string]$manifest[$path]).ToLowerInvariant()) { throw "Candidate source changed: $path." }
    }
    $actual = @(Get-ChildItem -LiteralPath $candidate.sourceRoot -Recurse -File -Force | ForEach-Object {
        [IO.Path]::GetRelativePath($candidate.sourceRoot,$_.FullName)
    } | Sort-Object)
    if (($actual -join "`n") -cne (@($manifest.Keys | Sort-Object) -join "`n")) { throw 'Candidate source file inventory changed.' }
    foreach ($path in @('deploy-local.ps1','scripts/local-deployment.ps1','scripts/local-runtime.ps1','scripts/local-mcp.ps1','compose.yaml') + $(if ($Context.Mcp) { @('compose.mcp.yaml','mcp/Dockerfile') })) {
        if ((Get-FileHash -LiteralPath (Join-Path $Context.Root $path)).Hash.ToLowerInvariant() -cne ([string]$manifest[$path]).ToLowerInvariant()) {
            throw 'Invoking deployment tooling differs from the qualified candidate.'
        }
    }
    foreach ($target in @('runtime','operator')) {
        $image = $candidate.images[$target]
        if ($image.id -cnotmatch '^sha256:[a-f0-9]{64}$' -or $image.sourceManifestHash -cne $candidate.sourceManifestHash -or
            (Invoke-DockerCommand @('image','inspect','--format','{{.Id}}',$image.tag) -Capture) -cne $image.id -or
            (Invoke-DockerCommand @('image','inspect','--format','{{index .Config.Labels "io.agent-control.source-sha256"}}',$image.id) -Capture) -cne $candidate.sourceManifestHash) {
            throw 'Candidate image/source identity mismatch.'
        }
    }
    $program = @'
const fs=require("node:fs"),crypto=require("node:crypto"),path=require("node:path"),files={};
const sha=x=>crypto.createHash("sha256").update(x).digest("hex");
function visit(dir){for(const name of fs.readdirSync(dir).sort()){const f=path.posix.join(dir,name),s=fs.lstatSync(f);
if(s.isSymbolicLink())throw Error("Built output link");if(s.isDirectory())visit(f);else files[f]=sha(fs.readFileSync(f));}}
for(const dir of ["backend/dist","frontend/dist"])visit(dir);
console.log(JSON.stringify({hash:sha(JSON.stringify(files)),count:Object.keys(files).length}));
'@
    $built = Invoke-DockerCommand @('run','--rm','--read-only','--network','none','--memory','1536m','--cpus','1.5',
        '--cap-drop','ALL','--security-opt','no-new-privileges:true','--entrypoint','node',$candidate.images.runtime.id,'-e',$program) -Capture | ConvertFrom-Json
    if ($built.hash -cne $candidate.builtFilesHash -or $built.count -ne $candidate.builtFileCount) { throw 'Candidate compiled output identity mismatch.' }
    $operator = Invoke-DockerCommand @('run','--rm','--read-only','--network','none','--memory','1536m','--cpus','1.5','-e','TENANTS_JSON=[]','--entrypoint','node',
        $candidate.images.operator.id,'--import','tsx','--input-type=module','-e',
        'import fs from "node:fs";import {createHash} from "node:crypto";import {schemaFingerprint} from "./backend/src/db/schema.ts";console.log(JSON.stringify({schemaFingerprint,cli:createHash("sha256").update(fs.readFileSync("backend/scripts/database.ts")).digest("hex")}));') -Capture | ConvertFrom-Json
    if ($operator.cli -cne $candidate.operatorCliSha256 -or $operator.schemaFingerprint -cne $candidate.schemaFingerprint) { throw 'Candidate packaged operator/schema identity differs.' }
    if ((Get-FileHash -LiteralPath (Join-Path $candidate.sourceRoot 'backend/scripts/database.ts')).Hash.ToLowerInvariant() -cne $candidate.operatorCliSha256) {
        throw 'Candidate operator bytes differ.'
    }
    $Context.RuntimeImageId = $candidate.images.runtime.id
    $Context.OperatorImageId = $candidate.images.operator.id
    if ($Context.Mcp) {
        $image = $candidate.images.mcp
        if ($image.id -cnotmatch '^sha256:[a-f0-9]{64}$' -or $image.sourceManifestHash -cne $candidate.sourceManifestHash -or
            (Invoke-DockerCommand @('image','inspect','--format','{{.Id}}',$image.id) -Capture) -cne $image.id -or
            (Invoke-DockerCommand @('image','inspect','--format','{{index .Config.Labels "io.agent-control.source-sha256"}}',$image.id) -Capture) -cne $candidate.sourceManifestHash) { throw 'Candidate MCP image/content identity differs.' }
        $Context.McpImageId = $image.id
    }
    $Context.SourceHash = $candidate.sourceManifestHash
    $Context.SchemaFingerprint = $candidate.schemaFingerprint
    return $candidate
}

function Get-LocalReleaseTarget {
    param($Context)
    $containers = @(Get-OwnedLocalContainers $Context)
    if ($containers.Count -notin @(2,3) -or @($containers | Where-Object Service -eq 'app').Count -ne 1 -or
        @($containers | Where-Object Service -eq 'mcp').Count -gt 1 -or
        (@($containers | Where-Object Service -eq 'mcp').Count -and -not $Context.Mcp) -or
        @($containers | Where-Object Service -eq 'postgres').Count -ne 1) { throw 'Pinned release requires the existing exact app/postgres installation.' }
    $identities = @()
    foreach ($container in @($containers | Sort-Object Service)) {
        $details = Invoke-DockerCommand @('inspect','--format',
            '{"name":{{json .Name}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}},"ports":{{json .HostConfig.PortBindings}},"memory":{{json .HostConfig.Memory}},"cpus":{{json .HostConfig.NanoCpus}}}',$container.Id) -Capture | ConvertFrom-Json -AsHashtable
        if ($details.name -cne "/$($Context.Project)-$($container.Service)-1" -or
            $details.networks.Count -ne 1 -or -not $details.networks.Contains($Context.Network)) { throw 'Release container network/name mismatch.' }
        $expected = if ($container.Service -eq 'postgres') {
            @{ '/var/lib/postgresql/data'=$Context.Volume; '/run/secrets/postgres-admin'=(Join-Path $Context.State 'secrets/postgres-admin') }
        } elseif ($container.Service -eq 'mcp') {
            @{ '/run/secrets/mcp-client'=(Join-Path $Context.State 'secrets/mcp-client')
                '/run/secrets/mcp-signing'=(Join-Path $Context.State 'secrets/mcp-signing')
                '/run/secrets/mcp-encryption'=(Join-Path $Context.State 'secrets/mcp-encryption')
                '/var/lib/agent-control-mcp/oauth'=$Context.McpVolume }
        } else {
            @{ '/run/control'=(Join-Path $Context.State 'control'); '/run/agent-sharing-diagnostics'=(Join-Path $Context.State 'agent-sharing-diagnostics')
                '/run/secrets/tenants.json'=(Join-Path $Context.State 'secrets/tenants.json'); '/run/secrets/session'=(Join-Path $Context.State 'secrets/session')
                '/run/secrets/postgres-app'=(Join-Path $Context.State 'secrets/postgres-app') }
        }
        if ($details.mounts.Count -ne $expected.Count) { throw 'Release mount inventory differs.' }
        foreach ($mount in $details.mounts) {
            if (-not $expected.ContainsKey($mount.Destination)) { throw 'Unexpected release mount.' }
            if ($mount.Destination -cin @('/var/lib/postgresql/data','/var/lib/agent-control-mcp/oauth')) {
                if ($mount.Type -cne 'volume' -or $mount.Name -cne $expected[$mount.Destination]) { throw 'Retained state volume identity mismatch.' }
            } elseif ($mount.Type -cne 'bind' -or -not (Test-LocalBindSource $mount.Source $expected[$mount.Destination]) -or
                $mount.RW -ne ($mount.Destination -cin @('/run/agent-sharing-diagnostics','/var/lib/agent-control-mcp/oauth'))) { throw 'Release bind identity/access mismatch.' }
        }
        if ($container.Service -eq 'postgres') {
            if ($details.ports -and $details.ports.Count) { throw 'Production database must not publish a port.' }
        } elseif ($container.Service -eq 'mcp') {
            Assert-LocalMcpContainer $Context $container.Id
        } elseif ($Context.IsolatedHealthContainer) {
            if ($Context.Project -cnotmatch '^ac-ltdp-install-[a-f0-9]{12}$' -or $Context.IsolatedHealthContainer -cne "$($Context.Project)-app-1" -or
                $Context.Port -in @(3001,3002) -or ($details.ports -and $details.ports.Count)) { throw 'Isolated release cannot publish ports or target a retained installation.' }
        } elseif ($details.ports.Count -ne 1 -or $details.ports['3001/tcp'].Count -ne 1 -or
            $details.ports['3001/tcp'][0].HostIp -cne '127.0.0.1' -or $details.ports['3001/tcp'][0].HostPort -cne [string]$Context.Port) { throw 'Release loopback origin/port mismatch.' }
        $identities += [ordered]@{ service=$container.Service; id=$container.Id; image=$container.Image; details=$details }
    }
    $resources = [ordered]@{}
    foreach ($kind in @('volume','network')) {
        $name = if ($kind -eq 'volume') { $Context.Volume } else { $Context.Network }
        $labels = Invoke-DockerCommand @($kind,'inspect','--format','{{json .Labels}}',$name) -Capture | ConvertFrom-Json -AsHashtable
        $logical = if ($kind -eq 'volume') { 'data' } else { 'default' }
        if ($labels['com.docker.compose.project'] -cne $Context.Project -or $labels["com.docker.compose.$kind"] -cne $logical) { throw 'Release volume/network ownership mismatch.' }
        $resources[$kind] = $name
    }
    $resources.networkId = Invoke-DockerCommand @('network','inspect','--format','{{.Id}}',$Context.Network) -Capture
    $resources.volumeCreatedAt = Invoke-DockerCommand @('volume','inspect','--format','{{.CreatedAt}}',$Context.Volume) -Capture
    if ($Context.IsolatedHealthContainer -and
        (Invoke-DockerCommand @('network','inspect','--format','{{.Internal}}',$Context.Network) -Capture) -cne 'true') { throw 'Isolated release network must be internal.' }
    $settings = Read-LocalSettings $Context.State
    $metadata = Get-LocalTenantMetadata (ConvertFrom-DeploymentTenantRegistry ([IO.File]::ReadAllText((Join-Path $Context.State 'secrets/tenants.json'))))
    if ((ConvertTo-Json -InputObject @($settings.tenants) -Depth 20 -Compress) -cne (ConvertTo-Json -InputObject @($metadata) -Depth 20 -Compress)) { throw 'Saved tenant registry binding differs.' }
    $postgres = @($containers | Where-Object Service -eq 'postgres')[0]
    $marker = Invoke-DockerCommand @('exec',$postgres.Id,'psql','-X','-qAt','-U','agentcontrol_admin','-d','agentcontrol','-v','ON_ERROR_STOP=1','-c',
        "BEGIN READ ONLY; SELECT to_regclass('public.app_schema') IS NOT NULL; COMMIT;") -Capture
    $schema = [ordered]@{ fingerprint=$null; mode=$null }
    if ($marker -ceq 't') {
        $sql = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT json_build_object('fingerprint',(SELECT fingerprint FROM app_schema WHERE singleton),'mode',(SELECT mode FROM operational_state WHERE singleton)); COMMIT;"
        $schema = Invoke-DockerCommand @('exec',$postgres.Id,'psql','-X','-qAt','-U','agentcontrol_admin','-d','agentcontrol','-v','ON_ERROR_STOP=1','-c',$sql) -Capture | ConvertFrom-Json -AsHashtable
    } elseif ($marker -cne 'f') { throw 'Starting database marker inspection failed.' }
    if ($Context.DatabaseAction -ne 'reset' -and $schema.fingerprint -and
        $schema.fingerprint -cne $Context.SchemaFingerprint) { throw 'Non-current starting schema; explicit reset or current-schema recovery required.' }
    $files = [ordered]@{}
    foreach ($path in @('settings.json','compose.env')) { $files[$path] = (Get-FileHash -LiteralPath (Join-Path $Context.State $path)).Hash.ToLowerInvariant() }
    $composeInputs = @(for ($index=0; $index -lt $Context.Compose.Count-1; $index++) {
        if ($Context.Compose[$index] -eq '-f') {
            $path = $Context.Compose[$index+1]
            [ordered]@{path=$path;sha256=(Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant()}
        }
    })
    $mcpSecrets = if ($Context.Mcp) {
        $key = [Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText((Join-Path $Context.State 'secrets/session')))
        $hmac = [Security.Cryptography.HMACSHA256]::new($key)
        try {
            $hashes = @('mcp-client','mcp-signing','mcp-encryption') | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $Context.State "secrets/$_")).Hash }
            [Convert]::ToHexString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($hashes -join "`n")))
        } finally { $hmac.Dispose(); [Array]::Clear($key,0,$key.Length) }
    } else { $null }
    return [ordered]@{
        version=1; project=$Context.Project; root=$Context.Root; state=$Context.State
        dockerContext=(Invoke-DockerCommand @('context','show') -Capture)
        engine=(Invoke-DockerCommand @('info','--format','{{.ID}}/{{.Name}}/{{.Architecture}}/{{.OSType}}') -Capture)
        endpoint=(Invoke-DockerCommand @('context','inspect','--format','{{.Endpoints.docker.Host}}') -Capture)
        origin=$Context.PublicUrl; port=$Context.Port; resources=$resources; containers=$identities
        configuration=$files; tenantRegistryHash=(Get-LocalSha256 (ConvertTo-Json -InputObject @($metadata) -Depth 20 -Compress))
        composeInputs=$composeInputs
        secretBinding=(Get-LocalDeploymentIdentity $Context @((Join-Path $Context.Root 'compose.yaml'))).secretConfiguration
        mcpSecretBinding=$mcpSecrets
        schema=$schema; candidate=$Context.CandidateSha256; databaseAction=$Context.DatabaseAction
    }
}

function Get-LocalReleaseObservations {
    param($Context)
    $containers = @(Get-OwnedLocalContainers $Context)
    if (@($containers | Where-Object { -not $_.State.Running -or $_.State.OOMKilled -or $_.State.Health.Status -cne 'healthy' }).Count) {
        if (-not (Test-Path -LiteralPath (Join-Path $Context.State 'deployment-operation.json'))) { throw 'Starting release health failed; investigate before drain.' }
    }
    $postgres = @($containers | Where-Object Service -eq 'postgres')[0]
    $bytes = Invoke-DockerCommand @('exec',$postgres.Id,'psql','-X','-qAt','-U','agentcontrol_admin','-d','agentcontrol',
        '-v','ON_ERROR_STOP=1','-c','BEGIN READ ONLY; SELECT pg_database_size(current_database()); COMMIT;') -Capture
    $disk = Invoke-DockerCommand @('exec',$postgres.Id,'df','-Pk','/var/lib/postgresql/data') -Capture
    $line = @($disk -split "`n" | Where-Object { $_.Trim() })[-1] -split '\s+'
    $available = 0L; $database = 0L
    if (-not [long]::TryParse($bytes,[ref]$database) -or $database -le 0 -or
        $line.Count -lt 6 -or -not [long]::TryParse($line[3],[ref]$available) -or
        $available*1024 -lt [Math]::Max(10GB,3*$database)) { throw 'Checkpoint disk headroom is unavailable or below 10GiB/three database sizes.' }
    $checkpointAvailable = [IO.DriveInfo]::new($Context.State).AvailableFreeSpace
    if ($checkpointAvailable -lt [Math]::Max(10GB,3*$database)) { throw 'Checkpoint host filesystem is below 10GiB/three database sizes.' }
    return [ordered]@{at=[DateTime]::UtcNow.ToString('o');databaseBytes=$database;dockerDiskAvailableBytes=$available*1024
        checkpointDiskAvailableBytes=$checkpointAvailable
        health=@($containers | ForEach-Object { [ordered]@{service=$_.Service;running=$_.State.Running;health=$_.State.Health.Status;oomKilled=$_.State.OOMKilled} })
        proposedBudgets=@{appMemory=1610612736;appCpus=1.5;postgresMemory=1073741824;postgresCpus=0.5;appConnections=4;nodeHeapMiB=768}}
}

function Get-OwnedLocalContainers {
    param($Context)
    $ids = Invoke-DockerCommand @('ps','-aq','--no-trunc','--filter',"label=com.docker.compose.project=$($Context.Project)") -Capture
    foreach ($id in ($ids -split "`n" | Where-Object { $_ })) {
        if ($id -cnotmatch '^[a-f0-9]{12,64}$') { throw 'Invalid local container identity.' }
        $labels = Invoke-DockerCommand @('inspect','--format','{{json .Config.Labels}}',$id) -Capture | ConvertFrom-Json
        if ($labels.'com.docker.compose.project' -cne $Context.Project -or
            $labels.'com.docker.compose.project.working_dir' -cne $Context.Root -or
            $labels.'com.docker.compose.service' -notin @('app','postgres','mcp')) {
            throw 'Local container ownership mismatch; operation refused.'
        }
        $state = Invoke-DockerCommand @('inspect','--format','{{json .State}}',$id) -Capture | ConvertFrom-Json
        $image = Invoke-DockerCommand @('inspect','--format','{{.Image}}',$id) -Capture
        if ($labels.'com.docker.compose.service' -ceq 'mcp') { Assert-LocalMcpContainer $Context $id }
        @{ Id=$id; Service=$labels.'com.docker.compose.service'; State=$state; Image=$image }
    }
}

function Stop-LocalProject {
    param($Context)
    $containers = @(Get-OwnedLocalContainers $Context)
    $control = Join-Path $Context.State 'control'
    [IO.Directory]::CreateDirectory($control) | Out-Null
    Protect-LocalPath $control -Directory
    Write-LocalText (Join-Path $control 'maintenance') 'maintenance'
    foreach ($service in @('mcp','app','postgres')) {
        foreach ($container in @($containers | Where-Object { $_.Service -eq $service -and $_.State.Running })) {
            Invoke-DockerCommand @('stop','--time','130',$container.Id)
        }
    }
    Write-Host '[STOP] Project stopped; data and saved configuration are retained.'
}

function Get-LocalDeploymentIdentity {
    param($Context,[string[]]$ComposeFiles)
    $configuration = [Collections.Generic.List[string]]::new()
    $database = [Collections.Generic.List[string]]::new()
    foreach ($path in @('compose.env','settings.json','secrets/tenants.json','secrets/session','secrets/postgres-admin','secrets/postgres-app')) {
        $hash = (Get-FileHash -LiteralPath (Join-Path $Context.State $path) -Algorithm SHA256).Hash
        $configuration.Add("$path=$hash")
        if ($path -in @('secrets/postgres-admin','secrets/postgres-app')) { $database.Add("$path=$hash") }
    }
    foreach ($file in $ComposeFiles) { $configuration.Add((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash) }
    $database.Add($Context.OperatorImageId)
    $key = [Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText((Join-Path $Context.State 'secrets/session')))
    $hmac = [Security.Cryptography.HMACSHA256]::new($key)
    try {
        return @{
            version=1
            runtimeImage=$Context.RuntimeImageId
            configuration=[Convert]::ToHexString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes(($configuration -join "`n"))))
            database=[Convert]::ToHexString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes(($database -join "`n"))))
            secretConfiguration=[Convert]::ToHexString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes(
                ((@($configuration | Where-Object { $_.StartsWith('secrets/') }) + $Context.OperatorImageId) -join "`n"))))
        }
    } finally { $hmac.Dispose(); [Array]::Clear($key,0,$key.Length) }
}

function Read-LocalDeploymentReceipt {
    param($Context)
    $path = Join-Path $Context.State 'deployment.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $receipt = [IO.File]::ReadAllText($path) | ConvertFrom-Json -AsHashtable
        if ($receipt.version -ne 1 -or $receipt.runtimeImage -cnotmatch '^sha256:[a-f0-9]{64}$' -or
            $receipt.configuration -cnotmatch '^[A-F0-9]{64}$' -or $receipt.database -cnotmatch '^[A-F0-9]{64}$') {
            throw 'Invalid deployment identity.'
        }
        return $receipt
    } catch { throw "Saved deployment receipt is invalid. Review or restore '$path' before retrying; no deployment was assumed to be current." }
}

function Assert-LocalRuntimeReady {
    param($Context)
    if ($Context.IsolatedHealthContainer) {
        if ($Context.Project -cnotmatch '^ac-ltdp-install-[a-f0-9]{12}$' -or
            $Context.IsolatedHealthContainer -cne "$($Context.Project)-app-1" -or $Context.Port -in @(3001,3002)) {
            throw 'Isolated readiness cannot target a retained installation.'
        }
        $health = Get-LocalHealth $Context.Url -IsolatedContainer $Context.IsolatedHealthContainer
    } else { $health = Get-LocalHealth $Context.Url }
    if (-not $health.authConfigured) { throw 'App sign-in configuration is missing. Check the project secret mounts and saved configuration before retrying.' }
}

function Show-LocalDeploymentSummary {
    param($Context,[switch]$Checked)
    Write-Host 'Deployment verification summary'
    if ($Checked) { Write-Host '[AUTOMATED CHECKS] PASSED: frontend lint/typecheck and backend/frontend regression tests against the built source snapshot.' }
    else { Write-Host '[AUTOMATED CHECKS] NOT RUN: normal start builds and verifies this installation. Use check or start -ForceChecks for full regression validation.' }
    Write-Host "[LOCAL READINESS] PASSED: $($Context.Url) (database/schema readiness and sign-in configuration)."
    Write-Host "Open $($Context.PublicUrl) to sign in."
    if ($Context.PublicUrl -cne $Context.Url) {
        Write-Host 'Local health is verified; tunnel reachability is not checked.'
        Show-LocalTunnelGuidance $Context.Port
    }
}

function Invoke-LocalApplication {
    param($Context,[switch]$CheckOnly,[switch]$ForceChecks,[switch]$DbReset)
    $snapshot = $null
    $originalCompose = $Context.Compose
    $originalAppliedComposeFiles = $Context.AppliedComposeFiles
    $errors = [Collections.Generic.List[Exception]]::new()
    $candidate = $null
    $progress = $null
    $progressPath = Join-Path $Context.State 'deployment-operation.json'
    $Context.DatabaseAction = if ($DbReset) { 'reset' } else { 'deploy' }
    $Context.DbResetStarted = $false
    try {
        if ($Context.ReadOnly -and -not $Context.Candidate) { throw '-ReadOnly requires an exact candidate and digest.' }
        if ($Context.Candidate) {
            if ($CheckOnly -or $ForceChecks) { throw 'Pinned deployment cannot relabel historical whole-suite evidence.' }
            $candidate = Read-LocalCandidate $Context
            $target = Get-LocalReleaseTarget $Context
            $observations = Get-LocalReleaseObservations $Context
            $binding = Get-LocalSha256 ($target | ConvertTo-Json -Depth 30 -Compress)
            if ($Context.ReadOnly) {
                $preflight = if ($DbReset) { @('preflight-reset','agentcontrol') } else { @('preflight') }
                Invoke-LocalOperator $Context (@('backend/scripts/database.ts') + $preflight) -Capture | Out-Null
                return [ordered]@{ status='deployment_pending'; preflight=$binding; target=$target; observations=$observations
                    schemaValidation=$(if ($DbReset) {'operator reset target verified; saved data and official report imports/history will be deleted'} else {'current or fresh schema and runtime grants verified'})
                    actions=@('drain-app','maintenance') + $(if ($DbReset) {@('reset-agentcontrol-confirmed','initialize-current-schema')} else {@('protected-current-schema-checkpoint')}) + @('verify-final-schema-grants','resume','start-pinned-runtime','observe')
                    productionMutation=$false }
            }
            if ($Context.ExpectedPreflight -cnotmatch '^[a-f0-9]{64}$') { throw 'Pinned deployment requires the approved exact read-only preflight digest.' }
            if (Test-Path -LiteralPath $progressPath) {
                $progress = [IO.File]::ReadAllText($progressPath) | ConvertFrom-Json -AsHashtable
                if ($progress.step -eq 'verified' -and ($progress.candidate -cne $Context.CandidateSha256 -or
                    $progress.preflight -cne $Context.ExpectedPreflight)) { $progress = $null }
            }
            if ($progress) {
                if ($progress.version -ne 2 -or $progress.databaseAction -cne $Context.DatabaseAction -or
                    $progress.candidate -cne $Context.CandidateSha256 -or $progress.preflight -cne $Context.ExpectedPreflight) { throw 'Pending deployment belongs to a different approved action/content identity.' }
                $before = $progress.target
                foreach ($key in @('project','root','state','dockerContext','engine','endpoint','origin','port','tenantRegistryHash','secretBinding','mcpSecretBinding')) {
                    if ($before[$key] -cne $target[$key]) { throw "Resumed deployment target changed: $key." }
                }
                if (($before.resources | ConvertTo-Json -Compress) -cne ($target.resources | ConvertTo-Json -Compress)) { throw 'Resumed volume/network identity changed.' }
                if (($before.composeInputs | ConvertTo-Json -Depth 6 -Compress) -cne ($target.composeInputs | ConvertTo-Json -Depth 6 -Compress)) { throw 'Resumed Compose inputs changed.' }
                if ($target.configuration['settings.json'] -cne $before.configuration['settings.json'] -or
                    $target.configuration['compose.env'] -cnotin @($before.configuration['compose.env'],$progress.composeEnvironmentHash)) { throw 'Resumed configuration differs.' }
                foreach ($container in $target.containers) {
                    $previous = @($before.containers | Where-Object service -eq $container.service)[0]
                    if ($container.service -eq 'postgres' -and ($container.id -cne $previous.id -or $container.image -cne $previous.image)) { throw 'Resumed PostgreSQL identity changed.' }
                    if ($container.service -eq 'app' -and $container.id -cne $previous.id -and $container.image -cne $candidate.images.runtime.id) { throw 'Resumed app is neither the original nor exact candidate.' }
                    if ($container.service -eq 'mcp' -and $container.id -cne $previous.id -and $container.image -cne $candidate.images.mcp.id) { throw 'Resumed MCP is neither the original nor exact candidate.' }
                }
                if ($target.schema.fingerprint -cnotin @($before.schema.fingerprint,$candidate.schemaFingerprint) -and
                    -not ($DbReset -and $progress.resetStatus -eq 'completed' -and $null -eq $target.schema.fingerprint)) { throw 'Resumed schema is outside the approved current/reset operation.' }
            } elseif ($binding -cne $Context.ExpectedPreflight) { throw 'Read-only target/action/content preflight identity changed; renew approval before drain.' }
        }
        if ($progress -and $progress.resetStatus -eq 'attempted') {
            throw 'Reset outcome is unknown. Keep maintenance; inspect the exact database before operator recovery. Destructive reset is not automatically retried.'
        }
        if (-not $CheckOnly) {
            $volumes = Invoke-DockerCommand @('volume','ls','--format','{{.Name}}') -Capture
            $existing = $Context.Volume -in ($volumes -split "`n")
            $plan = Read-LocalConfiguration $Context $existing -Onboard
            Sync-LocalMcpContext $Context $plan.Settings
            $receipt = Read-LocalDeploymentReceipt $Context
            @(Get-OwnedLocalContainers $Context) | Out-Null
        }
        if (-not $candidate -and -not $CheckOnly -and (Test-Path -LiteralPath $progressPath)) {
            $savedProgress = [IO.File]::ReadAllText($progressPath) | ConvertFrom-Json -AsHashtable
            if ($savedProgress.step -ne 'verified') {
                if ($savedProgress.candidate) { throw 'Pending pinned deployment must resume with its exact candidate.' }
                if ($savedProgress.version -ne 2 -or $savedProgress.databaseAction -ne 'reset' -or $savedProgress.resetStatus -eq 'attempted') {
                    throw 'Pending reset outcome requires explicit operator recovery; destructive reset is not automatically retried.'
                }
                $progress = $savedProgress
            }
        }
        if ($candidate) {
            $compose = @($Context.Compose)
            for ($index=0; $index -lt $compose.Count-1; $index++) {
                if ($compose[$index] -eq '-f' -and [IO.Path]::GetFullPath($compose[$index+1]) -cin @((Join-Path $Context.Root 'compose.yaml'),(Join-Path $Context.Root 'compose.mcp.yaml'))) {
                    $compose[$index+1] = Join-Path $candidate.sourceRoot ([IO.Path]::GetFileName($compose[$index+1]))
                }
            }
            $files = @(for ($index=0; $index -lt $compose.Count-1; $index++) { if ($compose[$index] -eq '-f') { $compose[$index+1] } })
            $snapshot = @{ Root=$candidate.sourceRoot; Compose=$compose; ComposeFiles=$files }
        } else { $snapshot = New-LocalBuildSnapshot $Context }
        $buildArguments = @(if (-not $candidate) { Get-LocalBuildArguments $Context -SourceRoot $snapshot.Root })
        $Context.Compose = $snapshot.Compose
        $Context.AppliedComposeFiles = $snapshot.ComposeFiles
        if ($CheckOnly) {
            Write-Host '[BUILD] Building the qualification image and production outputs once from a fixed source snapshot.'
            $checkImage = Build-LocalArtifact $Context $snapshot 'qualification' $Context.Checks $buildArguments
            Invoke-LocalSoftwareChecks $Context -Image $checkImage -SourceRoot $snapshot.Root
            Invoke-LocalMcpChecks $Context $snapshot
            Write-Host '[AUTOMATED CHECKS] PASSED. No application configuration, services or database were changed.'
            return
        }
        Write-Host '[BUILD] Preparing the database operator from the fixed source snapshot.'
        if (-not $candidate) {
            $Context.OperatorImageId = Build-LocalArtifact $Context $snapshot 'operator' $Context.Operator $buildArguments
            $Context.RuntimeImageId = if ($receipt) { $receipt.runtimeImage } else { '' }
            if (-not $existing) { Save-LocalConfiguration $Context $plan }
        } elseif ($plan.RegistryChanged -or $plan.SettingsChanged -or $plan.IdentityChanged -or $plan.McpPlan.SecretsChanged) { throw 'Pinned release cannot change saved identity/settings or MCP credentials.' }
        $marker = Join-Path $Context.State 'control/maintenance'
        $reauthenticate = Join-Path $Context.State 'control/reauthenticate'
        $initializing = Join-Path $Context.State 'control/database-initializing'
        if ($DbReset) { Write-Warning "Explicit database reset requested for project '$($Context.Project)'. All saved application data will be deleted; settings, secrets and backup files are retained." }
        Write-Host '[DATABASE PREFLIGHT] Checking the current schema before runtime compilation, maintenance or app shutdown.'
        try {
            if (-not $candidate) { Invoke-DockerCommand ($Context.Compose + @('up','-d','--no-recreate','--wait','--wait-timeout','90','postgres')) }
            $preflight = if ($DbReset -and $progress.resetStatus -ne 'completed') { @('preflight-reset','agentcontrol') } else { @('preflight') }
            $schema = Invoke-LocalOperator $Context (@('backend/scripts/database.ts') + $preflight) -Capture | ConvertFrom-Json
            if ($DbReset -and $progress.resetStatus -ne 'completed' -and ($schema.outcome -cne 'succeeded' -or
                $schema.database -cne 'agentcontrol' -or $schema.exists -isnot [bool])) { throw 'Invalid exact reset preflight result.' }
            if ((-not $DbReset -or $progress.resetStatus -eq 'completed') -and ($schema.state -cnotin @('fresh','current') -or
                $schema.targetFingerprint -cnotmatch '^[a-f0-9]{64}$' -or
                -not $schema.PSObject.Properties['currentFingerprint'] -or
                ($schema.state -ceq 'fresh' -and $null -ne $schema.currentFingerprint) -or
                ($schema.state -ceq 'current' -and $schema.currentFingerprint -cne $schema.targetFingerprint))) {
                throw 'Invalid database preflight result. Only the current schema or an empty database is accepted. No reset or automatic conversion is performed.'
            }
        } catch { throw "Database preflight failed: $($_.Exception.Message) This attempt has not entered maintenance, stopped the app or reset data." }
        if ($candidate -and -not $DbReset -and
            ($schema.currentFingerprint -cne $target.schema.fingerprint -or $schema.targetFingerprint -cne $candidate.schemaFingerprint)) { throw 'Candidate schema preflight changed.' }
        Write-Host '[BUILD] Building the runtime once; the existing application remains available.'
        if (-not $candidate) { $Context.RuntimeImageId = Build-LocalArtifact $Context $snapshot 'runtime' $Context.Image $buildArguments }
        if ($Context.Mcp -and -not $candidate) { $Context.McpImageId = Build-LocalMcpArtifact $Context $snapshot }
        if ($ForceChecks) {
            $checkImage = Build-LocalArtifact $Context $snapshot 'qualification' $Context.Checks $buildArguments
            Invoke-LocalSoftwareChecks $Context -Image $checkImage -SourceRoot $snapshot.Root
            Invoke-LocalMcpChecks $Context $snapshot
        }
        if (-not $candidate) { Save-LocalConfiguration $Context $plan }
        Write-LocalComposeEnvironment $Context
        Test-LocalMcpConfiguration $Context
        $identity = Get-LocalDeploymentIdentity $Context $snapshot.ComposeFiles
        if ($progress -and -not $candidate -and $progress.databaseIdentity -and $progress.databaseIdentity -cne $identity.database) {
            throw 'Pending reset database/credential/operator identity changed; review before recovery.'
        }
        $containers = @(Get-OwnedLocalContainers $Context)
        $retainedPostgres = @($containers | Where-Object { $_.Service -eq 'postgres' })[0]
        $apps = @($containers | Where-Object { $_.Service -eq 'app' })
        if ($apps.Count -gt 1) { throw 'Expected at most one application container for this project.' }
        $app = if ($apps.Count) { $apps[0] } else { $null }
        $same = $receipt -and $receipt.runtimeImage -ceq $identity.runtimeImage -and $receipt.configuration -ceq $identity.configuration
        $databaseCurrent = $receipt -and $receipt.database -ceq $identity.database -and
            $schema.state -ceq 'current' -and $schema.currentFingerprint -ceq $schema.targetFingerprint -and
            -not (Test-Path -LiteralPath $initializing)
        $pending = Test-Path -LiteralPath $reauthenticate
        $resetComplete = $progress -and $progress.resetStatus -eq 'completed'
        if ($same -and $databaseCurrent -and (-not $DbReset -or ($resetComplete -and $progress.step -eq 'verified')) -and -not $pending -and
            -not (Test-Path -LiteralPath $marker) -and $app -and $app.Image -ceq $identity.runtimeImage -and
            $app.State.Running -and $app.State.Health.Status -eq 'healthy') {
            Invoke-LocalOperator $Context @('backend/scripts/database.ts','resume','confirmed')
            try { Assert-LocalRuntimeReady $Context }
            catch { Write-LocalText $marker 'maintenance'; throw }
            if ($progress -and $progress.step -ne 'verified') {
                $progress.step = 'verified'
                Write-LocalText $progressPath ($progress | ConvertTo-Json -Depth 30)
            }
            Write-Host '[DEPLOYMENT] ALREADY RUNNING: image, configuration and database contract are unchanged. No restart or database initialization was needed.'
            if ($originalAppliedComposeFiles) { $Context.AppliedComposeFiles = $originalAppliedComposeFiles }
            Show-LocalDeploymentSummary $Context -Checked:$ForceChecks
            Start-LocalMcp $Context
            return
        }
        $initialize = ($DbReset -and -not $resetComplete) -or -not $databaseCurrent -or ($app -and $app.State.Running -and $app.State.Health.Status -ne 'healthy')
        if ($candidate -or $DbReset -or $progress) {
            if (-not $progress) { $progress = [ordered]@{ version=2; candidate=$Context.CandidateSha256; preflight=$binding; target=$target; databaseAction=$Context.DatabaseAction; step='prepared'; resetStatus=$null } }
            $progress.databaseIdentity = $identity.database
            $progress.composeEnvironmentHash = (Get-FileHash -LiteralPath (Join-Path $Context.State 'compose.env')).Hash.ToLowerInvariant()
            Write-LocalText $progressPath ($progress | ConvertTo-Json -Depth 30)
        }
        Write-LocalText $marker 'maintenance'
        if ($app -and $app.State.Running) {
            Write-Host '[DEPLOYMENT] Draining the application before applying the required changes.'
            Invoke-DockerCommand ($Context.Compose + @('stop','--timeout','130','app'))
        }
        if (@(Get-OwnedLocalContainers $Context | Where-Object { $_.Service -eq 'app' -and $_.State.Running }).Count) { throw 'Old runtime is still running; checkpoint/reset refused.' }
        Assert-LocalPort $Context.Port
        if (-not $same -and -not $candidate) {
            Invoke-DockerCommand ($Context.Compose + @('up','-d','--no-recreate','--wait','--wait-timeout','90','postgres'))
        }
        if ($initialize) { Write-LocalText $initializing 'pending' }
        if ($DbReset -and -not $resetComplete) {
            $progress.resetStatus = 'attempted'
            Write-LocalText $progressPath ($progress | ConvertTo-Json -Depth 30)
            $Context.DbResetStarted = $true
            Invoke-LocalOperator $Context @('backend/scripts/database.ts','reset','agentcontrol')
            $progress.resetStatus = 'completed'
            Write-LocalText $progressPath ($progress | ConvertTo-Json -Depth 30)
        }
        if ($candidate -and -not $DbReset -and $schema.state -eq 'current') {
            Invoke-LocalOperator $Context @('backend/scripts/database.ts','maintenance','confirmed')
            if (-not $progress.checkpoint) {
                $checkpoint = Join-Path $Context.State "backups/release-$([Guid]::NewGuid().ToString('N')).dump"
                Invoke-LocalOperator $Context @('backend/scripts/backup.ts','backup',"/backups/$([IO.Path]::GetFileName($checkpoint))") (Split-Path $checkpoint -Parent)
                $metadata = [IO.File]::ReadAllText("$checkpoint.json") | ConvertFrom-Json
                if ($metadata.schemaFingerprint -cne $schema.currentFingerprint -or
                    $metadata.sha256 -cne (Get-FileHash -LiteralPath $checkpoint).Hash.ToLowerInvariant()) { throw 'Protected checkpoint identity mismatch; release refused.' }
                $progress.checkpoint = $checkpoint
                $progress.checkpointHash = $metadata.sha256
                $progress.checkpointReceiptHash = (Get-FileHash -LiteralPath "$checkpoint.json").Hash.ToLowerInvariant()
                $progress.step = 'checkpointed'
                Write-LocalText $progressPath ($progress | ConvertTo-Json -Depth 30)
            } elseif ((Get-FileHash -LiteralPath $progress.checkpoint).Hash.ToLowerInvariant() -cne $progress.checkpointHash -or
                (Get-FileHash -LiteralPath "$($progress.checkpoint).json").Hash.ToLowerInvariant() -cne $progress.checkpointReceiptHash) { throw 'Retained checkpoint changed; resume refused.' }
        }
        if ($candidate) {
            $postgres = @($target.containers | Where-Object service -eq 'postgres')[0]
            Invoke-DockerCommand @('update','--memory','1g','--memory-swap','1g','--cpus','0.5',$postgres.id) | Out-Null
        }
        if ($initialize) {
            Write-Host '[DATABASE] Initializing the current schema and runtime grants.'
            $initializeArguments = @('backend/scripts/database.ts','initialize')
            Invoke-LocalOperator $Context $initializeArguments
            Remove-Item -LiteralPath $initializing
        } else { Write-Host '[DATABASE] Current schema and unchanged operator/credential contract; initialization is not repeated.' }
        if ($pending) {
            Invoke-DockerCommand ($Context.Compose + @('exec','-T','postgres','psql','-U','agentcontrol_admin','-d','agentcontrol','-v','ON_ERROR_STOP=1','-c','DELETE FROM public.sessions;'))
            Remove-Item -LiteralPath $reauthenticate
        }
        if ($candidate -or $progress) {
            $final = Invoke-LocalOperator $Context @('backend/scripts/database.ts','preflight') -Capture | ConvertFrom-Json
            if ($final.state -cne 'current' -or ($candidate -and $final.currentFingerprint -cne $candidate.schemaFingerprint) -or
                (-not $DbReset -and $final.currentFingerprint -cne $schema.targetFingerprint)) { throw 'Final schema/grant verification failed.' }
            Invoke-LocalOperator $Context @('backend/scripts/database.ts','resume','confirmed')
            $identity.sourceManifestHash = $Context.SourceHash
            $identity.candidate = $Context.CandidateSha256
            $identity.schemaFingerprint = $final.currentFingerprint
            $identity.checkpoint = $progress.checkpoint
        } else { Invoke-LocalOperator $Context @('backend/scripts/database.ts','resume','confirmed') }
        Remove-Item -LiteralPath $marker
        try {
            $start = @('up','-d','--no-build','--no-deps')
            Invoke-DockerCommand ($Context.Compose + $start + @('--wait','--wait-timeout','90','app'))
            Assert-LocalRuntimeReady $Context
            $owned = @(Get-OwnedLocalContainers $Context)
            $running = @($owned | Where-Object { $_.Service -eq 'app' })
            if ($running.Count -ne 1 -or $running[0].Image -cne $Context.RuntimeImageId) { throw 'The running application does not match the built runtime image.' }
            if ($retainedPostgres) {
                $postgres = @($owned | Where-Object { $_.Service -eq 'postgres' })
                if ($postgres.Count -ne 1 -or $postgres[0].Id -cne $retainedPostgres.Id -or $postgres[0].Image -cne $retainedPostgres.Image) {
                    throw 'Approved PostgreSQL identity changed during app startup; retain maintenance and renew target approval.'
                }
            }
            Write-LocalText (Join-Path $Context.State 'deployment.json') ($identity | ConvertTo-Json)
            if ($progress) {
                $progress.step = 'verified'
                Write-LocalText $progressPath ($progress | ConvertTo-Json -Depth 30)
            }
        } catch {
            Write-LocalText $marker 'maintenance'
            throw
        }
        Write-Host '[DEPLOYMENT] Applied the required changes successfully.'
        Show-LocalDeploymentSummary $Context -Checked:$ForceChecks
        Start-LocalMcp $Context
    } catch { $errors.Add($_.Exception) }
    finally {
        $Context.Compose = $originalCompose
        if ($snapshot -and $snapshot.Directory) {
            try { Remove-Item -LiteralPath $snapshot.Directory -Recurse -Force }
            catch { $errors.Add($_.Exception) }
        }
        if ($errors.Count) { throw [AggregateException]::new('Local application operation failed.',$errors) }
    }
}
