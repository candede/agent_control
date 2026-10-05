#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
. (Join-Path $PSScriptRoot 'fresh-installation.ps1')
$root = Split-Path $PSScriptRoot -Parent
$directory = Join-Path $root 'artifacts/fresh-installation-unit'
$context = New-LocalContext $root 'ac-ltdp-install-0123456789ab'
$context.Port = 43127
$context.FixtureCompose = Join-Path $directory 'fresh.yaml'
$context.SourceHash = 'a'*64
$script:checks = 0
$script:collision = ''
function Assert-True($Condition,[string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Assert-Refused([scriptblock]$Action) {
    $refused = $false
    try { & $Action } catch { $refused = $true }
    Assert-True $refused 'Unsafe fresh installation was not refused.'
}
function Invoke-DockerCommand([string[]]$Arguments,[switch]$Capture) {
    $line = $Arguments -join '|'
    if ($script:collision -eq 'volume' -and $line -like 'volume|ls|*') { return $context.Volume }
    if ($script:collision -eq 'network' -and $line -like 'network|ls|*') { return $context.Network }
    if ($script:collision -eq 'container' -and $line -like 'ps|-aq|*') { return 'a' * 64 }
    if ($script:collision -eq 'name' -and $line -like 'ps|-a|*') { return "$($context.Project)-app-1" }
    if ($script:collision -eq 'image' -and $line -like 'image|ls|*') { return $context.Image }
    return ''
}
function Assert-LocalPort([int]$Port) { Assert-True ($Port -eq 43127) 'Unexpected loopback port.' }
Assert-FreshInstallationAbsent $context $directory
foreach ($collision in @('volume','network','container','name','image')) {
    $script:collision = $collision
    Assert-Refused { Assert-FreshInstallationAbsent $context $directory }
}
$script:collision = ''
foreach ($project in @('seha','agent-control-phase01','ac-ltdp-install-ABCDEF012345','ac-ltdp-install-0123456789abcd')) {
    $bad = $context.Clone(); $bad.Project = $project
    Assert-Refused { Assert-FreshInstallationContext $bad $directory }
}
foreach ($key in @('State','Volume','Network','Image','Operator')) {
    $bad = $context.Clone(); $bad[$key] = 'seha'
    Assert-Refused { Assert-FreshInstallationContext $bad $directory }
}
foreach ($port in @(0,3001,3002,65536)) {
    $bad = $context.Clone(); $bad.Port = $port
    Assert-Refused { Assert-FreshInstallationContext $bad $directory }
}
Assert-Refused { Assert-FreshInstallationContext $context (Join-Path $root '.local/seha') }
function New-Container([string]$Service) {
    $mounts = if ($Service -eq 'app') {
        @(
            @{Type='bind';Source=(Join-Path $context.State 'control');Destination='/run/control';RW=$false}
            @{Type='bind';Source=(Join-Path $context.State 'secrets/tenants.json');Destination='/run/secrets/tenants.json';RW=$false}
            @{Type='bind';Source=(Join-Path $context.State 'secrets/session');Destination='/run/secrets/session';RW=$false}
            @{Type='bind';Source=(Join-Path $context.State 'secrets/postgres-app');Destination='/run/secrets/postgres-app';RW=$false}
        )
    } else {
        @(
            @{Type='volume';Name=$context.Volume;Destination='/var/lib/postgresql/data';RW=$true}
            @{Type='bind';Source=(Join-Path $context.State 'secrets/postgres-admin');Destination='/run/secrets/postgres-admin';RW=$false}
        )
    }
    $ports = if ($Service -eq 'app') { @{'3001/tcp'=@(@{HostIp='127.0.0.1';HostPort='43127'})} } else { @{} }
    return (@{
        Id=('a'*64);Name="/$($context.Project)-$Service-1"
        Config=@{Labels=@{'com.docker.compose.project'=$context.Project;'com.docker.compose.service'=$Service
            'com.docker.compose.project.working_dir'=$root;'com.docker.compose.project.config_files'="$root/compose.yaml,$($context.FixtureCompose)"
            'io.agent-control.fixture'=$context.Project;'io.agent-control.source-sha256'=$context.SourceHash}}
        Mounts=$mounts;HostConfig=@{Memory=$(if ($Service -eq 'app') {1610612736} else {1073741824})
            NanoCpus=$(if ($Service -eq 'app') {1500000000} else {500000000});PortBindings=$ports}
        NetworkSettings=@{Networks=@{$context.Network=@{}}}
    } | ConvertTo-Json -Depth 15 | ConvertFrom-Json)
}
foreach ($service in @('app','postgres')) {
    Assert-FreshInstallationContainer $context (New-Container $service)
    $script:checks++
    foreach ($mutation in @(
        {param($c) $c.Name='/seha-app-1'},
        {param($c) $c.Config.Labels.'com.docker.compose.project'='seha'},
        {param($c) $c.Config.Labels.'com.docker.compose.project.working_dir'='/other'},
        {param($c) $c.Config.Labels.'com.docker.compose.project.config_files'='other.yaml'},
        {param($c) $c.Mounts=@()},
        {param($c) $c.Mounts[-1].Source=(Join-Path $root '.local/seha/secrets/postgres-admin')},
        {param($c) $c.Mounts[-1].RW=$true},
        {param($c) $c.HostConfig.Memory=0},
        {param($c) $c.HostConfig.NanoCpus=0},
        {param($c) $c.NetworkSettings.Networks=[pscustomobject]@{seha_default=@{}}}
    )) {
        $bad = New-Container $service
        & $mutation $bad
        Assert-Refused { Assert-FreshInstallationContainer $context $bad }
    }
}
foreach ($binding in @(@{HostIp='0.0.0.0';HostPort='43127'},@{HostIp='127.0.0.1';HostPort='3002'})) {
    $bad = New-Container app; $bad.HostConfig.PortBindings.'3001/tcp'=@($binding)
    Assert-Refused { Assert-FreshInstallationContainer $context $bad }
}
$bad = New-Container postgres; $bad.Mounts[0].Name='seha_data'
Assert-Refused { Assert-FreshInstallationContainer $context $bad }
$bad = New-Container app; $bad.Config.Labels.'io.agent-control.source-sha256'='other'
Assert-Refused { Assert-FreshInstallationContainer $context $bad }
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'fresh-installation.ps1'))
Assert-True ($source.Contains('Invoke-LocalDeployment -Context $context -Action Deploy')) 'Fresh runner no longer uses the real Deploy boundary.'
Assert-True ($source.Contains('Invoke-LocalDeployment -Context $context -Action Deploy -ForceChecks')) 'Fresh installation proof must explicitly execute full qualification.'
Assert-True (-not $source.Contains('-DbReset') -and -not $source.Contains('-Action Start') -and -not $source.Contains('DROP DATABASE')) 'Fresh runner bypasses initialization safeguards.'
Assert-True (-not $source.Contains("@('up'") -and $source.Contains('Wait-FreshInstallationHealth $context $Directory')) 'Fresh runner must poll health after restart, not directly create/start runtime services.'
Assert-Refused { Get-IsolatedLocalHttp 'seha-app-1' '/api/ready' }
Assert-Refused { Get-IsolatedLocalHttp "$($context.Project)-app-1" '/api/auth/callback' }
$before = [pscustomobject]@{schemaFingerprint=('a'*64);tables=[pscustomobject]@{sessions=@{count=0;hash='same'};data_lifecycle_progress=@{count=6;hash='before'}}}
$after = [pscustomobject]@{schemaFingerprint=('a'*64);tables=[pscustomobject]@{sessions=@{count=0;hash='same'};data_lifecycle_progress=@{count=6;hash='after'}}}
$progressBefore = @('inventory','inventory_metadata','operator','records','report_payloads','report_staging' | ForEach-Object { @{worker=$_;slices=1;rows_collected=0;bytes_collected=0} })
$progressAfter = @($progressBefore | ForEach-Object { $copy=$_.Clone();$copy.slices=2;$copy })
Assert-FreshRestartPersistence $before $after $progressBefore $progressAfter
$script:checks++
foreach ($fingerprint in @($null,'','invalid',('b'*64))) {
    $after.schemaFingerprint=$fingerprint
    Assert-Refused { Assert-FreshRestartPersistence $before $after $progressBefore $progressAfter }
}
$after.schemaFingerprint=$before.schemaFingerprint
Assert-True ($source.Contains("'backend/scripts/database.ts','preflight'") -and
    $source.Contains('schemaFingerprint=$schema.targetFingerprint') -and -not $source.Contains('schemaVersion') -and
    -not $source.Contains('schema_migrations')) 'Fresh qualification still records historical schema evidence.'
$after.tables.sessions.hash='changed'
Assert-Refused { Assert-FreshRestartPersistence $before $after $progressBefore $progressAfter }
$after.tables.sessions.hash='same';$after.tables.data_lifecycle_progress.count=5
Assert-Refused { Assert-FreshRestartPersistence $before $after $progressBefore $progressAfter }
$after.tables.data_lifecycle_progress.count=6;$progressAfter[0].slices=0
Assert-Refused { Assert-FreshRestartPersistence $before $after $progressBefore $progressAfter }
$progressAfter[0].slices=2;$progressAfter[0].rows_collected=1001
Assert-Refused { Assert-FreshRestartPersistence $before $after $progressBefore $progressAfter }
$progressAfter[0].rows_collected=1;$progressAfter[0].bytes_collected=512
Assert-FreshRestartPersistence $before $after $progressBefore $progressAfter
$script:checks++
$progressAfter[0].bytes_collected=1048577
Assert-Refused { Assert-FreshRestartPersistence $before $after $progressBefore $progressAfter }
$dockerfile = [IO.File]::ReadAllText((Join-Path $root 'Dockerfile'))
$testStage = ($dockerfile -split 'FROM dependencies AS test')[1] -split 'FROM test AS security-scan' | Select-Object -First 1
Assert-True ($testStage.Contains('COPY scripts scripts') -and $testStage.Contains('COPY Dockerfile compose.yaml compose.large-tenant-test.yaml')) 'Qualification test inputs omit deployment contracts.'
$qualificationStage = ($dockerfile -split 'FROM operator AS qualification')[1] -split 'FROM node:' | Select-Object -First 1
Assert-True ($qualificationStage.Contains('COPY --from=test /app /app') -and $qualificationStage.Contains('COPY --from=build /app/backend/dist') -and $qualificationStage.Contains('COPY --from=build /app/frontend/dist')) 'Qualification must reuse production compilation and retain all test inputs.'
$buildStage = ($dockerfile -split 'FROM application-base AS build')[1] -split 'FROM dependencies AS test' | Select-Object -First 1
Assert-True ($buildStage.Contains('COPY --from=application-source /app/backend/src') -and $buildStage.Contains('COPY --from=application-source /app/frontend/src') -and -not $buildStage.Contains('COPY scripts')) 'Production compilation must consume filtered sources rather than broad test inputs.'
$operatorStage = ($dockerfile -split 'FROM postgres:17-bookworm AS operator')[1] -split 'FROM operator AS qualification' | Select-Object -First 1
Assert-True ($operatorStage.Contains('COPY --from=application-source /app/backend/src') -and -not $operatorStage.Contains('COPY --from=test') -and -not $operatorStage.Contains('COPY backend/scripts backend/scripts')) 'Test-only changes must not change the database operator contract.'
$savedDependencyImage = [Environment]::GetEnvironmentVariable('AGENT_CONTROL_DEPENDENCY_IMAGE')
try {
    $env:AGENT_CONTROL_DEPENDENCY_IMAGE = 'fixture-dependencies:local'
    $script:manifestMismatch = $false
    function Invoke-DockerCommand([string[]]$Arguments,[switch]$Capture) {
        if ($Arguments[0] -eq 'image') { return "sha256:$('a'*64)" }
        Assert-True (($Arguments[0..6] -join '|') -ceq 'run|--rm|--network|none|--entrypoint|node|sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') 'Dependency validation is not isolated and pinned.'
        $hashes = @{}
        foreach ($path in @('package.json','package-lock.json','backend/package.json','frontend/package.json')) {
            $hashes[$path] = (Get-FileHash -LiteralPath (Join-Path $root $path)).Hash.ToLowerInvariant()
        }
        if ($script:manifestMismatch) { $hashes['package-lock.json']='mismatch' }
        return $hashes | ConvertTo-Json
    }
    $arguments = @(Get-LocalBuildArguments $context)
    Assert-True (($arguments -join '|') -ceq '--network|none|--build-arg|DEPENDENCY_BASE=fixture-dependencies:local|--build-arg|REUSE_INSTALLED_DEPENDENCIES=1') 'Dependency reuse does not select the validated local image/offline builds.'
    Assert-LocalDependencyImage $context
    $context.DependencyImageId = "sha256:$('b'*64)"
    Assert-Refused { Assert-LocalDependencyImage $context }
    $script:manifestMismatch = $true
    Assert-Refused { Get-LocalBuildArguments $context }
    $env:AGENT_CONTROL_DEPENDENCY_IMAGE = 'bad image;echo'
    Assert-Refused { Get-LocalBuildArguments $context }
} finally {
    if ($null -eq $savedDependencyImage) { Remove-Item Env:AGENT_CONTROL_DEPENDENCY_IMAGE -ErrorAction SilentlyContinue }
    else { $env:AGENT_CONTROL_DEPENDENCY_IMAGE=$savedDependencyImage }
}
foreach ($name in @('large-tenant-lifecycle.ps1','restart-runtime.tests.ps1')) {
    $tokens=$null; $errors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name),[ref]$tokens,[ref]$errors)
    Assert-True (@($errors).Count -eq 0) "Runtime fixture $name has invalid PowerShell syntax."
    $registryInputs=@($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $node.Value.StartsWith('TENANTS_JSON=')
    },$true))
    Assert-True ($registryInputs.Count -eq 1) "Runtime fixture $name must supply one current tenant registry."
    $profiles=ConvertFrom-DeploymentTenantRegistry $registryInputs[0].Value.Substring('TENANTS_JSON='.Length)
    Assert-True ($profiles.Count -eq 1 -and $profiles[0].tenantId -ceq '11111111-1111-4111-8111-111111111111' -and
        $profiles[0].domains[0] -ceq 'example.invalid') "Runtime fixture $name has invalid synthetic registry configuration."
    $standaloneInputs=@($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
            $node.Value -cmatch '^(TENANT_ID|CLIENT_ID|CLIENT_SECRET|CLIENT_SECRET_FILE|TENANT_DOMAINS|TENANT_DISPLAY_NAME)='
    },$true))
    Assert-True ($standaloneInputs.Count -eq 0) "Runtime fixture $name still produces standalone tenant configuration."
}
Write-Host "Passed $script:checks fresh-installation guard assertions (mocked resources; not deployment proof)."
