function Get-LocalSourceFiles {
    param([string]$Root)
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required to snapshot tracked and untracked build inputs without copying local secrets or installed dependencies.' }
    $output = @(& git -C $Root ls-files -z --cached --others --exclude-standard -- backend frontend scripts docs infra Dockerfile .dockerignore compose.yaml compose.large-tenant-test.yaml package.json package-lock.json deploy-local.ps1 deploy-azure.ps1 README.md)
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate deployment source files.' }
    foreach ($path in (($output -join "`n") -split "`0" | Where-Object { $_ } | Sort-Object -Unique)) {
        if ($path -match '[\\\r\n]' -or [IO.Path]::IsPathRooted($path) -or $path -match '(^|/)\.\.(/|$)') { throw 'Build input paths must remain inside the repository.' }
        if ($path -match '(^|/)(node_modules|dist|coverage|artifacts|backups|\.git|\.local|\.azure)(/|$)|(^|/)\.env[^/]*$|(^|/)\.npmrc$|\.(pem|pfx|key|csv|db|sqlite[^/]*)$') { continue }
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
            $copy = if ([IO.Path]::GetFullPath($original) -ceq (Join-Path $Context.Root 'compose.yaml')) { Join-Path $source 'compose.yaml' }
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
    Invoke-DockerCommand (@('build') + $BuildArguments + @('--target',$Target,'--iidfile',$identityFile,'-t',$Tag,$Snapshot.Root))
    Assert-LocalDependencyImage $Context
    $identity = [IO.File]::ReadAllText($identityFile).Trim()
    if ($identity -cnotmatch '^sha256:[a-f0-9]{64}$') { throw "The $Target build did not produce an immutable image identity." }
    return $identity
}

function Get-OwnedLocalContainers {
    param($Context)
    $ids = Invoke-DockerCommand @('ps','-aq','--no-trunc','--filter',"label=com.docker.compose.project=$($Context.Project)") -Capture
    foreach ($id in ($ids -split "`n" | Where-Object { $_ })) {
        if ($id -cnotmatch '^[a-f0-9]{12,64}$') { throw 'Invalid local container identity.' }
        $labels = Invoke-DockerCommand @('inspect','--format','{{json .Config.Labels}}',$id) -Capture | ConvertFrom-Json
        if ($labels.'com.docker.compose.project' -cne $Context.Project -or
            $labels.'com.docker.compose.project.working_dir' -cne $Context.Root -or
            $labels.'com.docker.compose.service' -notin @('app','postgres')) {
            throw 'Local container ownership mismatch; operation refused.'
        }
        $state = Invoke-DockerCommand @('inspect','--format','{{json .State}}',$id) -Capture | ConvertFrom-Json
        $image = Invoke-DockerCommand @('inspect','--format','{{.Image}}',$id) -Capture
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
    foreach ($service in @('app','postgres')) {
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
    $errors = [Collections.Generic.List[Exception]]::new()
    try {
        if (-not $CheckOnly) {
            $volumes = Invoke-DockerCommand @('volume','ls','--format','{{.Name}}') -Capture
            $existing = $Context.Volume -in ($volumes -split "`n")
            $plan = Read-LocalConfiguration $Context $existing -Onboard
            $receipt = Read-LocalDeploymentReceipt $Context
            @(Get-OwnedLocalContainers $Context) | Out-Null
        }
        $snapshot = New-LocalBuildSnapshot $Context
        $buildArguments = @(Get-LocalBuildArguments $Context -SourceRoot $snapshot.Root)
        $Context.Compose = $snapshot.Compose
        $Context.AppliedComposeFiles = $snapshot.ComposeFiles
        if ($CheckOnly) {
            Write-Host '[BUILD] Building the qualification image and production outputs once from a fixed source snapshot.'
            $checkImage = Build-LocalArtifact $Context $snapshot 'qualification' $Context.Checks $buildArguments
            Invoke-LocalSoftwareChecks $Context -Image $checkImage -SourceRoot $snapshot.Root
            Write-Host '[AUTOMATED CHECKS] PASSED. No application configuration, services or database were changed.'
            return
        }
        Write-Host '[BUILD] Preparing the database operator from the fixed source snapshot.'
        $Context.OperatorImageId = Build-LocalArtifact $Context $snapshot 'operator' $Context.Operator $buildArguments
        $Context.RuntimeImageId = if ($receipt) { $receipt.runtimeImage } else { '' }
        Save-LocalConfiguration $Context $plan
        $marker = Join-Path $Context.State 'control/maintenance'
        $reauthenticate = Join-Path $Context.State 'control/reauthenticate'
        $initializing = Join-Path $Context.State 'control/database-initializing'
        if ($DbReset) { Write-Warning "Explicit database reset requested for project '$($Context.Project)'. All saved application data will be deleted; settings, secrets and backup files are retained." }
        Write-Host '[DATABASE PREFLIGHT] Checking the current schema before runtime compilation, maintenance or app shutdown.'
        try {
            Invoke-DockerCommand ($Context.Compose + @('up','-d','--no-recreate','--wait','--wait-timeout','90','postgres'))
            $preflight = if ($DbReset) { @('preflight-reset','agentcontrol') } else { @('preflight') }
            $schema = Invoke-LocalOperator $Context (@('backend/scripts/database.ts') + $preflight) -Capture | ConvertFrom-Json
            if (-not $DbReset -and ($schema.state -cnotin @('fresh','current') -or
                $schema.targetFingerprint -cnotmatch '^[a-f0-9]{64}$' -or
                -not $schema.PSObject.Properties['currentFingerprint'] -or
                ($schema.state -ceq 'fresh' -and $null -ne $schema.currentFingerprint) -or
                ($schema.state -ceq 'current' -and $schema.currentFingerprint -cne $schema.targetFingerprint))) {
                throw 'Invalid database preflight result. A non-current schema requires explicit -DbReset; no automatic conversion is supported.'
            }
        } catch { throw "Database preflight failed: $($_.Exception.Message) This attempt has not entered maintenance, stopped the app or reset data." }
        Write-Host '[BUILD] Building the runtime once; the existing application remains available.'
        $Context.RuntimeImageId = Build-LocalArtifact $Context $snapshot 'runtime' $Context.Image $buildArguments
        if ($ForceChecks) {
            $checkImage = Build-LocalArtifact $Context $snapshot 'qualification' $Context.Checks $buildArguments
            Invoke-LocalSoftwareChecks $Context -Image $checkImage -SourceRoot $snapshot.Root
        }
        Write-LocalComposeEnvironment $Context
        $identity = Get-LocalDeploymentIdentity $Context $snapshot.ComposeFiles
        $containers = @(Get-OwnedLocalContainers $Context)
        $apps = @($containers | Where-Object { $_.Service -eq 'app' })
        if ($apps.Count -gt 1) { throw 'Expected at most one application container for this project.' }
        $app = if ($apps.Count) { $apps[0] } else { $null }
        $same = $receipt -and $receipt.runtimeImage -ceq $identity.runtimeImage -and $receipt.configuration -ceq $identity.configuration
        $databaseCurrent = $receipt -and $receipt.database -ceq $identity.database -and
            $schema.state -ceq 'current' -and $schema.currentFingerprint -ceq $schema.targetFingerprint -and
            -not (Test-Path -LiteralPath $initializing)
        $pending = Test-Path -LiteralPath $reauthenticate
        if ($same -and $databaseCurrent -and -not $DbReset -and -not $pending -and
            -not (Test-Path -LiteralPath $marker) -and $app -and $app.Image -ceq $identity.runtimeImage -and
            $app.State.Running -and $app.State.Health.Status -eq 'healthy') {
            Assert-LocalRuntimeReady $Context
            Write-Host '[DEPLOYMENT] ALREADY RUNNING: image, configuration and database contract are unchanged. No restart or database initialization was needed.'
            Show-LocalDeploymentSummary $Context -Checked:$ForceChecks
            return
        }
        $initialize = $DbReset -or -not $databaseCurrent -or ($app -and $app.State.Running -and $app.State.Health.Status -ne 'healthy')
        Write-LocalText $marker 'maintenance'
        if ($app -and $app.State.Running) {
            Write-Host '[DEPLOYMENT] Draining the application before applying the required changes.'
            Invoke-DockerCommand ($Context.Compose + @('stop','--timeout','130','app'))
        }
        Assert-LocalPort $Context.Port
        if (-not $same) {
            Invoke-DockerCommand ($Context.Compose + @('up','-d','--wait','--wait-timeout','90','postgres'))
        }
        if ($initialize) { Write-LocalText $initializing 'pending' }
        if ($DbReset) {
            $Context.DbResetStarted = $true
            Invoke-LocalOperator $Context @('backend/scripts/database.ts','reset','agentcontrol')
        }
        if ($initialize) {
            Write-Host '[DATABASE] Initializing the current schema and runtime grants.'
            Invoke-LocalOperator $Context @('backend/scripts/database.ts','initialize')
            Remove-Item -LiteralPath $initializing
        } else { Write-Host '[DATABASE] Current schema and unchanged operator/credential contract; initialization is not repeated.' }
        if ($pending) {
            Invoke-DockerCommand ($Context.Compose + @('exec','-T','postgres','psql','-U','agentcontrol_admin','-d','agentcontrol','-v','ON_ERROR_STOP=1','-c','DELETE FROM public.sessions;'))
            Remove-Item -LiteralPath $reauthenticate
        }
        Remove-Item -LiteralPath $marker
        try {
            Invoke-DockerCommand ($Context.Compose + @('up','-d','--no-build','--wait','--wait-timeout','90','app'))
            Assert-LocalRuntimeReady $Context
            $running = @(Get-OwnedLocalContainers $Context | Where-Object { $_.Service -eq 'app' })
            if ($running.Count -ne 1 -or $running[0].Image -cne $Context.RuntimeImageId) { throw 'The running application does not match the built runtime image.' }
            Write-LocalText (Join-Path $Context.State 'deployment.json') ($identity | ConvertTo-Json)
        } catch {
            Write-LocalText $marker 'maintenance'
            throw
        }
        Write-Host '[DEPLOYMENT] Applied the required changes successfully.'
        Show-LocalDeploymentSummary $Context -Checked:$ForceChecks
    } catch { $errors.Add($_.Exception) }
    finally {
        $Context.Compose = $originalCompose
        if ($snapshot) {
            try { Remove-Item -LiteralPath $snapshot.Directory -Recurse -Force }
            catch { $errors.Add($_.Exception) }
        }
        if ($errors.Count) { throw [AggregateException]::new('Local application operation failed.',$errors) }
    }
}
