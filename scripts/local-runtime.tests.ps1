#requires -Version 7.0
param([switch]$ReceiptOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
$repository = Split-Path $PSScriptRoot -Parent
$root = Join-Path $repository "artifacts/test-scratch/runtime-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory((Join-Path $root 'backend')) | Out-Null
foreach ($file in @('Dockerfile','.dockerignore','compose.yaml','compose.mcp.yaml','compose.mcp-metadata.yaml','compose.proxy.yaml','compose.mcp-proxy.yaml','compose.large-tenant-test.yaml')) {
    Copy-Item -LiteralPath (Join-Path $repository $file) -Destination (Join-Path $root $file)
}
[IO.File]::WriteAllText((Join-Path $root 'backend/input.ts'),'snapshot-v1')
[IO.File]::WriteAllText((Join-Path $root 'backend/.env.synthetic'),'excluded-synthetic-fixture')
$script:checks = 0
$script:calls = [Collections.Generic.List[string]]::new()
$script:containers = @{}
$script:runtime = 'sha256:' + ('a' * 64)
$script:operator = 'sha256:' + ('b' * 64)
$script:qualification = 'sha256:' + ('c' * 64)
$script:failure = ''
$script:currentFingerprint = $null
$script:targetFingerprint = '1' * 64
$script:preflightOverride = $null
$script:checked = 0
$script:healthCalls = 0
$script:ready = $true
$script:mutateSource = $false
$script:changeDuringCapture = $false
$script:addDuringCapture = $false
$script:enumerations = 0
$script:wrongOwner = $false
$script:candidateInputs = @()
$script:candidateHash = ''
$script:replacePostgresOnAppStart = $false
$script:buildStdout = 'Docker Desktop build summary (Windows)'
$script:answers = [Collections.Generic.Queue[string]]::new()
$script:validateDatabaseCompose = $false
$script:composeValidations = 0
$script:composeOrphanPolicy = [Environment]::GetEnvironmentVariable('COMPOSE_IGNORE_ORPHANS')
$script:proxyNetworkId = 'f'*64
$script:dockerExecutable = (Microsoft.PowerShell.Core\Get-Command docker -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
function Assert($Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:checks++ }
function Fails([scriptblock]$Action,[string]$Pattern) {
    try { & $Action; throw 'Expected failure did not occur.' }
    catch { Assert ($_.Exception.Message -match $Pattern) "Unexpected failure: $($_.Exception.Message)" }
}
function Get-Command {
    param([string]$Name,$ErrorAction)
    if ($Name -in @('docker','git')) { return @{Name=$Name} }
    Microsoft.PowerShell.Core\Get-Command $Name -ErrorAction $ErrorAction
}
function git {
    $global:LASTEXITCODE = 0
    Assert ($args -contains 'compose.yaml' -and $args -contains 'Dockerfile') 'Source inventory omitted required Docker/Compose inputs.'
    Assert ($args -contains 'docs' -and $args -contains 'knip.json' -and $args -notcontains 'plans') 'Source inventory must include current documentation and analysis configuration.'
    $script:enumerations++
    if ($script:changeDuringCapture -and $script:enumerations -eq 2) {
        [IO.File]::WriteAllText((Join-Path $root 'backend/input.ts'),'changed-during-capture')
    }
    if ($script:addDuringCapture -and $script:enumerations -eq 2) {
        [IO.File]::WriteAllText((Join-Path $root 'backend/added.ts'),'added-during-capture')
        return ((@('Dockerfile','compose.yaml','backend/input.ts','backend/added.ts')) -join "`0") + "`0"
    }
    return ((@('Dockerfile','.dockerignore','compose.yaml','compose.mcp.yaml','compose.mcp-metadata.yaml','compose.proxy.yaml','compose.mcp-proxy.yaml','compose.large-tenant-test.yaml','backend/input.ts','backend/.env.synthetic') + $script:candidateInputs | Sort-Object -Unique) -join "`0") + "`0"
}
function Read-Host {
    param([string]$Prompt,[switch]$AsSecureString)
    if (-not $script:answers.Count) { throw "Unexpected prompt: $Prompt" }
    $value = $script:answers.Dequeue()
    if ($AsSecureString) { return ConvertTo-SecureString $value -AsPlainText -Force }
    return $value
}
function Get-LocalBuildArguments { param($Context) return @() }
function Invoke-LocalSoftwareChecks {
    param($Context,[string]$Image,[string]$SourceRoot)
    Assert ($Image -ceq $script:qualification) 'Checks did not use the built immutable qualification image.'
    Assert ($SourceRoot -cne $root -and (Test-Path -LiteralPath "$SourceRoot/backend/input.ts")) 'Checks did not use the frozen source snapshot.'
    if ($script:failure -eq 'checks') { throw 'Simulated checks failure.' }
    $script:checked++
}
function Get-LocalHealth {
    param([string]$Url,[string]$IsolatedContainer)
    $script:healthCalls++
    if (-not $script:ready) { throw 'Simulated readiness failure.' }
    return @{authConfigured=$true}
}
function docker {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
    $global:LASTEXITCODE = 0
    $line = $Arguments -join '|'
    $script:calls.Add($line)
    if ($script:failure -and $script:failure -ne 'checks' -and $line -match $script:failure) { throw 'Simulated Docker failure.' }
    if ($Arguments[0] -eq 'info') { return '29.7.2' }
    if ($line -eq 'compose|version|--short') { return '2.30.0' }
    if ($Arguments[0] -eq 'network' -and $Arguments[3] -ceq '{{json .}}') {
        return (@{Name=$Arguments[-1];Id=$script:proxyNetworkId;Driver='bridge';Scope='local';Internal=$false;Ingress=$false;ConfigOnly=$false
            Containers=@{};Options=@{};Labels=@{'io.shared-proxy.managed'='true';'io.shared-proxy.instance'='fixture-edge';'io.shared-proxy.owner'='/independent-infrastructure'}} | ConvertTo-Json -Depth 5)
    }
    if ($Arguments[0] -eq 'volume') { if ($script:currentFingerprint) { return $context.Volume }; return '' }
    if ($Arguments[0] -eq 'image' -and $Arguments[1] -eq 'inspect') {
        if ($Arguments[3] -eq '{{.Id}}') { return $(if ($Arguments[-1] -eq 'candidate-runtime:local') {$script:runtime} else {$script:operator}) }
        return $script:candidateHash
    }
    if ($Arguments[0] -eq 'build') {
        Assert ($Arguments -contains '--provenance=false') 'Local rebuild attestation timestamps would break exact reset/runtime identity.'
        $target = $Arguments[[Array]::IndexOf($Arguments,'--target')+1]
        $image = switch ($target) { 'runtime' {$script:runtime} 'operator' {$script:operator} 'qualification' {$script:qualification} }
        $source = $Arguments[-1]
        Assert ($source -cne $root -and -not (Test-Path -LiteralPath "$source/backend/.env.synthetic")) 'Build used mutable source or included excluded environment files.'
        if ($script:mutateSource -and $target -eq 'operator') { [IO.File]::WriteAllText((Join-Path $root 'backend/input.ts'),'changed-after-snapshot') }
        if ($script:mutateSource) { Assert ([IO.File]::ReadAllText("$source/backend/input.ts") -ceq 'snapshot-v1') 'Build targets consumed different source versions.' }
        [IO.File]::WriteAllText($Arguments[[Array]::IndexOf($Arguments,'--iidfile')+1],$image)
        return $script:buildStdout
    }
    if ($Arguments[0] -eq 'ps') { return ($script:containers.Keys -join "`n") }
    if ($Arguments[0] -eq 'inspect') {
        $container = $script:containers[$Arguments[-1]]
        switch ($Arguments[2]) {
            '{{json .Config.Labels}}' { return (@{'com.docker.compose.project'=$context.Project;'com.docker.compose.project.working_dir'=$(if ($script:wrongOwner) {'/different-checkout'} else {$root});'com.docker.compose.service'=$container.service} | ConvertTo-Json -Compress) }
            '{{json .State}}' { return (@{Running=$container.running;Health=@{Status='healthy'}} | ConvertTo-Json -Compress) }
            '{{.Image}}' { return $container.image }
            '{{json .NetworkSettings.Networks}}' { return $container.networks | ConvertTo-Json -Depth 5 -Compress }
        }
    }
    if ($Arguments[0] -eq 'stop') { $script:containers[$Arguments[-1]].running=$false; return }
    if ($Arguments[0] -eq 'run') {
        if ($Arguments[-1] -match 'Built output link') { return '{"hash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","count":198}' }
        if ($Arguments[-1] -match 'readFileSync\("backend/scripts/database.ts"\)') {
            return (@{cli=(Get-FileHash -LiteralPath (Join-Path $root 'backend/scripts/database.ts')).Hash.ToLowerInvariant();schemaFingerprint=$script:targetFingerprint}|ConvertTo-Json -Compress)
        }
        if ($Arguments -contains 'backend/scripts/backup.ts') {
            $mount = @($Arguments | Where-Object { $_ -match 'target=/backups$' })[0]
            $directory = ($mount -replace '^type=bind,source=','') -replace ',target=/backups$',''
            $file = Join-Path $directory ([IO.Path]::GetFileName($Arguments[-1]))
            Write-LocalText $file 'synthetic-protected-checkpoint'
            Write-LocalText "$file.json" (@{schemaFingerprint=$script:currentFingerprint;sha256=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()} | ConvertTo-Json)
            return
        }
        if ($Arguments[-1] -eq 'preflight') {
            if ($script:preflightOverride) { return $script:preflightOverride }
            if ($script:currentFingerprint -and $script:currentFingerprint -cne $script:targetFingerprint) {
                throw 'database_schema_reset_required: explicit -DbReset is required.'
            }
            return (@{state=$(if (-not $script:currentFingerprint) {'fresh'} else {'current'});currentFingerprint=$script:currentFingerprint;targetFingerprint=$script:targetFingerprint} | ConvertTo-Json -Compress)
        }
        if ($Arguments -contains 'preflight-reset') { return '{"outcome":"succeeded","database":"agentcontrol","exists":true}' }
        if ($Arguments -contains 'initialize') { $script:currentFingerprint=$script:targetFingerprint }
        if ($Arguments -contains 'resume') { $script:operationalMode='normal' }
        if ($Arguments -contains 'reset') { $script:currentFingerprint=$null }
        return
    }
    if ($Arguments[0] -eq 'compose') {
        $databaseOnly = $Arguments -contains 'up' -and $Arguments[-1] -eq 'postgres'
        $expectedPolicy = if ($databaseOnly) { 'true' } else { $script:composeOrphanPolicy }
        Assert ([Environment]::GetEnvironmentVariable('COMPOSE_IGNORE_ORPHANS') -ceq $expectedPolicy) 'Orphan detection must be disabled only for database-only Compose startup.'
        if ($databaseOnly) {
            Assert ($Arguments -notcontains '--remove-orphans') 'Database-only Compose must not remove configured MCP containers.'
        }
        if ($Arguments -contains 'stop') { $script:containers[('a' * 64)].running=$false; return }
        if ($Arguments -contains 'up') {
            $service = $Arguments[-1]
            if ($script:validateDatabaseCompose -and $service -eq 'postgres') {
                if ($script:dockerExecutable) {
                    $upIndex = [Array]::IndexOf($Arguments,'up')
                    $validationArguments = @($Arguments[0..($upIndex-1)]) + @('config','--format','json')
                    $configuration = @(& $script:dockerExecutable @validationArguments)
                    if ($LASTEXITCODE -ne 0) { throw 'Read-only database Compose configuration validation failed.' }
                    $configuration = ($configuration -join "`n") | ConvertFrom-Json
                    Assert ($configuration.services.app.container_name -ceq "$($context.Project)-agent-control-app-1" -and
                        $configuration.services.postgres.container_name -ceq "$($context.Project)-agent-control-postgres-1") 'Compose did not derive clear container names from the selected project.'
                    Assert ($configuration.name -ceq $context.Project -and $configuration.volumes.data.name -ceq $context.Volume -and
                        $configuration.networks.default.name -ceq $context.Network) 'Container naming changed project, data volume or network ownership.'
                    Assert ($configuration.services.app.environment.PGHOST -ceq 'postgres') 'Container naming changed the internal database service hostname.'
                    $script:composeValidations++
                } else { Write-Host 'Real Compose interpolation check skipped: Docker CLI is unavailable; mocked ordering assertions still run.' }
                Assert (@($Arguments | Where-Object { [IO.Path]::GetFileName($_) -ceq 'compose.mcp.yaml' }).Count -eq 0) 'Database preflight included the unsaved MCP overlay.'
            }
            $id = if ($service -eq 'app') {'a' * 64} else {'b' * 64}
            $networks=@{$context.Network=@{}}
            if ($service -eq 'app' -and $context.ProxyNetwork) { $networks[$context.ProxyNetwork]=@{Aliases=@("$($context.Project)-app")} }
            $script:containers[$id]=@{service=$service;running=$true;networks=$networks;image=$(if ($service -eq 'app') {$script:runtime} else {'sha256:' + ('d' * 64)})}
            if ($service -eq 'app' -and $script:replacePostgresOnAppStart) {
                $script:containers.Remove(('b' * 64))
                $script:containers[('e' * 64)]=@{service='postgres';running=$true;image=('sha256:' + ('d' * 64))}
            }
        }
    }
}
function Run-Deploy {
    param([switch]$ForceChecks,[switch]$DbReset)
    $script:calls.Clear()
    return @(Invoke-LocalDeployment $context Deploy -ForceChecks:$ForceChecks -DbReset:$DbReset 6>&1)
}
try {
    & {
        $receiptContext = @{State=(Join-Path $root 'receipt-validation')}
        [IO.Directory]::CreateDirectory($receiptContext.State) | Out-Null
        $receiptFile = Join-Path $receiptContext.State 'deployment.json'
        Assert ($null -eq (Read-LocalDeploymentReceipt $receiptContext)) 'An absent deployment receipt must allow a first deployment.'
        $valid = @{version=1;runtimeImage=$script:runtime;configuration=('B'*64);database=('C'*64)}
        $validJson = $valid | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($receiptFile,$validJson)
        $receipt = Read-LocalDeploymentReceipt $receiptContext
        Assert ($receipt -is [Collections.IDictionary] -and $receipt.runtimeImage -ceq $script:runtime) 'A valid current deployment receipt was rejected.'
        $invalid = @('null','[]','{}','true','1','"receipt"','{',
            (ConvertTo-Json -InputObject @($valid) -Compress),
            (ConvertTo-Json -InputObject @($valid,$valid) -Compress))
        foreach ($field in @('version','runtimeImage','configuration','database')) {
            $arrayField = $valid.Clone()
            $arrayField[$field] = @($valid[$field],$valid[$field])
            $invalid += $arrayField | ConvertTo-Json -Compress
        }
        $invalidVersion = $valid.Clone()
        $invalidVersion.version = $true
        $invalid += $invalidVersion | ConvertTo-Json -Compress
        foreach ($json in $invalid) {
            [IO.File]::WriteAllText($receiptFile,$json)
            Fails { Read-LocalDeploymentReceipt $receiptContext } 'receipt is invalid'
            Assert ([IO.File]::ReadAllText($receiptFile) -ceq $json) 'Invalid receipt validation changed saved state.'
        }
    }
    if ($ReceiptOnly) {
        Write-Host "Passed $script:checks local deployment receipt assertions (filesystem only; no Docker or Git operations)."
        return
    }
    $context = New-LocalContext $root 'runtime-test'
    & {
        $gitPath = (Microsoft.PowerShell.Core\Get-Command git -CommandType Application | Select-Object -First 1).Source
        function git { & $gitPath @args }
        $filterRoot = Join-Path $root 'source-filter'
        [IO.Directory]::CreateDirectory($filterRoot) | Out-Null
        & $gitPath -C $filterRoot init --quiet
        if ($LASTEXITCODE -ne 0) { throw 'Could not initialize isolated source-filter fixture.' }
        $ordinary = @('backend/input.ts','frontend/view.tsx','backend/tsx-source/input.ts',
            'backend/tsx-123-source/input.ts','backend/tsx-123.ts/input.ts')
        $caches = @('backend/tsx-0/tracked','backend/tsx-501/untracked',
            'frontend/nested/tsx-10001/cache','backend/tsx-501/tsx-123-source/cache',
            'backend/tsx-4294967295/cache')
        foreach ($path in $ordinary + $caches) {
            $file = Join-Path $filterRoot $path
            [IO.Directory]::CreateDirectory((Split-Path $file -Parent)) | Out-Null
            [IO.File]::WriteAllText($file,'synthetic-source-filter')
        }
        & $gitPath -C $filterRoot add --force -- $caches[0]
        if ($LASTEXITCODE -ne 0) { throw 'Could not track the synthetic cache fixture.' }
        $paths = @(Get-LocalSourceFiles $filterRoot)
        foreach ($path in $ordinary) { Assert ($path -cin $paths) "Ordinary source was excluded: $path" }
        foreach ($path in $caches) { Assert ($path -cnotin $paths) "Generated tracked/untracked cache was included: $path" }
        Copy-Item -LiteralPath (Join-Path $repository '.gitignore') -Destination (Join-Path $filterRoot '.gitignore')
        foreach ($path in $caches[1..($caches.Count-1)]) {
            & $gitPath -C $filterRoot check-ignore --quiet -- $path
            Assert ($LASTEXITCODE -eq 0) "Generated cache escaped Git exclusions: $path"
        }
        foreach ($path in $ordinary) {
            & $gitPath -C $filterRoot check-ignore --quiet -- $path
            Assert ($LASTEXITCODE -eq 1) "Git exclusions swallowed ordinary source: $path"
        }
        Assert ((& $gitPath -C $filterRoot ls-files --cached) -ceq $caches[0]) 'Filtering removed pre-existing tracked cache content.'
        Assert ([IO.File]::ReadAllText((Join-Path $filterRoot $caches[0])) -ceq 'synthetic-source-filter') 'Filtering changed tracked cache bytes.'
        $dockerIgnore = [IO.File]::ReadAllLines((Join-Path $repository '.dockerignore'))
        foreach ($width in 1..10) {
            Assert (('**/tsx-' + ('[0-9]' * $width)) -cin $dockerIgnore) "Docker context is missing the exact $width-digit OS UID cache exclusion."
        }
    }
    $manifestRoot=Join-Path $root 'manifest-validation'
    $hashes=@{}
    foreach ($manifest in @('package.json','package-lock.json','backend/package.json','frontend/package.json')) {
        $file=Join-Path $manifestRoot $manifest
        [IO.Directory]::CreateDirectory((Split-Path $file -Parent)) | Out-Null
        [IO.File]::WriteAllText($file,'{"name":"synthetic-manifest"}')
        $hashes[$manifest]=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()
    }
    Assert-LocalDependencyManifests $manifestRoot $hashes
    [IO.File]::WriteAllText((Join-Path $manifestRoot 'frontend/package.json'),'{"name":"changed-manifest"}')
    Fails { Assert-LocalDependencyManifests $manifestRoot $hashes } 'offline reuse refused'
    $script:changeDuringCapture=$true
    Fails { New-LocalBuildSnapshot $context } 'Source changed while preparing'
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $root 'artifacts/local-builds')).Count -eq 0) 'Failed source capture leaked its snapshot.'
    $script:changeDuringCapture=$false
    [IO.File]::WriteAllText((Join-Path $root 'backend/input.ts'),'snapshot-v1')
    $script:enumerations=0
    $script:addDuringCapture=$true
    Fails { New-LocalBuildSnapshot $context } 'Source files changed while preparing'
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $root 'artifacts/local-builds')).Count -eq 0) 'Changed source inventory leaked its snapshot.'
    $script:addDuringCapture=$false
    Remove-Item -LiteralPath (Join-Path $root 'backend/added.ts')
    & {
        function Protect-LocalPath { param([string]$Path,[switch]$Directory) throw 'Simulated snapshot protection failure.' }
        Fails { New-LocalBuildSnapshot $context } 'snapshot protection failure'
        Assert (@(Get-ChildItem -LiteralPath (Join-Path $root 'artifacts/local-builds')).Count -eq 0) 'Failed snapshot protection leaked its source directory.'
    }
    & {
        $inputRoot = Join-Path $root 'linked-input'
        $targetRoot = Join-Path $root 'linked-target'
        foreach ($directory in @($inputRoot,$targetRoot)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
        [IO.File]::WriteAllText((Join-Path $targetRoot 'input.ts'),'synthetic-linked-input')
        $linkType = if ($IsWindows) { 'Junction' } else { 'SymbolicLink' }
        $backendLink = Join-Path $inputRoot 'backend'
        New-Item -ItemType $linkType -Path $backendLink -Target $targetRoot | Out-Null
        function git { $global:LASTEXITCODE=0; return "backend/input.ts`0" }
        Assert (-not (Get-Item -LiteralPath (Join-Path $backendLink 'input.ts')).LinkType) 'Ancestor-link regression must use a regular leaf file.'
        Fails { Get-LocalSourceFiles $inputRoot } 'Symbolic build input paths'
        Fails { Assert-LocalBuildPath $inputRoot (Join-Path $targetRoot 'input.ts') } 'remain inside the repository'
        Remove-Item -LiteralPath $backendLink -Force
        $artifactLink = Join-Path $inputRoot 'artifacts'
        New-Item -ItemType $linkType -Path $artifactLink -Target $targetRoot | Out-Null
        Fails { New-LocalBuildSnapshot @{Root=$inputRoot} } 'Symbolic build input paths'
        Assert (-not (Test-Path -LiteralPath (Join-Path $targetRoot 'local-builds'))) 'Snapshot creation wrote through a linked artifact ancestor.'
        Remove-Item -LiteralPath $artifactLink -Force
    }
    & {
        $nativeExecutable=(Microsoft.PowerShell.Core\Get-Command pwsh -CommandType Application | Select-Object -First 1).Source
        $nativeFixture=Join-Path $root 'native build fixture.ps1'
        [IO.File]::WriteAllText($nativeFixture,@'
param([string]$IdentityFile,[string]$Identity,[int]$ExitCode)
[Console]::Out.WriteLine('Docker Desktop build summary (Windows)')
[IO.File]::WriteAllText($IdentityFile,$Identity)
exit $ExitCode
'@)
        $nativeIdentity=$script:operator
        $nativeExitCode=0
        function docker {
            param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
            $identityFile=$Arguments[[Array]::IndexOf($Arguments,'--iidfile')+1]
            & $nativeExecutable -NoLogo -NoProfile -NonInteractive -File $nativeFixture -IdentityFile $identityFile -Identity $nativeIdentity -ExitCode $nativeExitCode
        }
        $directory=Join-Path $root 'native build with spaces'
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        $snapshot=@{Directory=$directory;Root=$root}
        $diagnostics=Join-Path $directory 'build-output.txt'
        foreach ($target in @('operator','runtime','qualification')) {
            $image=Build-LocalArtifact @{} $snapshot $target "native-${target}:local" @() 6>$diagnostics
            Assert ($image -is [string] -and $image -ceq $script:operator) "Native $target build stdout contaminated the returned image identity."
            Assert ([IO.File]::ReadAllText($diagnostics).Contains($script:buildStdout)) 'Native build progress was discarded instead of displayed.'
        }
        foreach ($target in @('runtime','test','fixture')) {
            $image=Build-LocalMcpArtifact @{McpImage='native-mcp:local'} $snapshot -Target $target 6>$diagnostics
            Assert ($image -is [string] -and $image -ceq $script:operator) "Native MCP $target build stdout contaminated the returned image identity."
            Assert ([IO.File]::ReadAllText($diagnostics).Contains($script:buildStdout)) 'Native MCP build progress was discarded instead of displayed.'
        }
        $nativeExitCode=17
        Fails { Build-LocalArtifact @{} $snapshot 'operator' 'native-operator:local' @() 6>$diagnostics } 'Docker build failed \(exit code 17\)'
        Fails { Build-LocalMcpArtifact @{McpImage='native-mcp:local'} $snapshot 6>$diagnostics } 'Docker build failed \(exit code 17\)'
        $nativeExitCode=0
        $nativeIdentity='invalid-image-identity'
        Fails { Build-LocalArtifact @{} $snapshot 'operator' 'native-operator:local' @() 6>$diagnostics } 'did not produce an immutable image identity'
        Fails { Build-LocalMcpArtifact @{McpImage='native-mcp:local'} $snapshot 6>$diagnostics } 'did not return an immutable image identity'
        Remove-Item -LiteralPath $directory -Recurse -Force
        Remove-Item -LiteralPath $nativeFixture
    }
    foreach ($value in @('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','synthetic-runtime-test-client-secret','example.invalid','14399')) { $script:answers.Enqueue($value) }
    $script:mutateSource=$true
    $messages=Run-Deploy
    $script:mutateSource=$false
    Assert ($context.OperatorImageId -is [string] -and $context.OperatorImageId -ceq $script:operator -and
        $context.RuntimeImageId -is [string] -and $context.RuntimeImageId -ceq $script:runtime) 'Noisy first-start builds did not retain scalar operator/runtime image identities.'
    Assert (@($script:calls | Where-Object { $_ -match '^run\|' -and $_.Contains($script:buildStdout) }).Count -eq 0) 'Build progress was passed to Docker as an image or command argument.'
    Assert (($script:calls -join "`n").Contains("|$($script:operator)|backend/scripts/database.ts|preflight")) 'First-start preflight did not invoke the exact built operator image.'
    Assert ($script:checked -eq 0 -and -not (($script:calls -join "`n") -match 'test-postgres|test-all|qualification')) 'Normal start still ran regression validation.'
    Assert (@($script:calls | Where-Object { $_ -match '^build\|' }).Count -eq 2) 'Normal start did not build exactly the operator and runtime.'
    $preflight = $script:calls.FindIndex([Predicate[string]]{param($line) $line -match 'database\.ts\|preflight$'})
    $runtimeBuild = $script:calls.FindIndex([Predicate[string]]{param($line) $line -match '\|--target\|runtime\|'})
    Assert ($preflight -lt $runtimeBuild) 'Database compatibility was not checked before runtime compilation.'
    Assert (($script:calls -join "`n") -match '\|--no-recreate\|--wait\|') 'Preflight could recreate PostgreSQL before draining the application.'
    Assert (Test-Path -LiteralPath (Join-Path $context.State 'deployment.json')) 'Successful deployment did not record its identity.'
    Assert ($script:operationalMode -eq 'normal' -and ($script:calls -join "`n") -match 'database\.ts\|resume') 'Normal deployment blocked automatic first sync.'
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $root 'artifacts/local-builds')).Count -eq 0) 'Source snapshot was not removed.'
    & {
        $releaseContext = $context.Clone()
        $releaseContext.SchemaFingerprint = $script:targetFingerprint
        $releaseContext.DatabaseAction = 'deploy'
        $releaseContext.CandidateSha256 = 'f' * 64
        $inspectedAppName = $null
        $releaseMcpDetails = $null
        $releaseRecordingProject = $releaseContext.Project
        function Get-OwnedLocalContainers {
            param($Context)
            foreach ($id in $script:containers.Keys) {
                $container = $script:containers[$id]
                @{Id=$id;Service=$container.service;Image=$container.image}
            }
            if ($releaseMcpDetails) { @{Id=('c'*64);Service='mcp';Image=$script:runtime} }
        }
        function Invoke-DockerCommand {
            param([string[]]$Arguments,[switch]$Capture)
            if ($Arguments[0] -ceq 'inspect') {
                if ($releaseMcpDetails -and $Arguments[-1] -ceq ('c'*64)) { return $releaseMcpDetails | ConvertTo-Json -Depth 10 }
                $service = $script:containers[$Arguments[-1]].service
                $mounts = if ($service -ceq 'postgres') {
                    @(@{Destination='/var/lib/postgresql/data';Type='volume';Name=$releaseContext.Volume;RW=$true},
                        @{Destination='/run/secrets/postgres-admin';Type='bind';Source=(Join-Path $releaseContext.State 'secrets/postgres-admin');RW=$false})
                } else {
                    @(@{Destination='/run/control';Type='bind';Source=(Join-Path $releaseContext.State 'control');RW=$false},
                        @{Destination='/run/agent-sharing-diagnostics';Type='bind';Source=(Join-Path $releaseContext.State 'agent-sharing-diagnostics');RW=$true},
                        @{Destination='/run/secrets/tenants.json';Type='bind';Source=(Join-Path $releaseContext.State 'secrets/tenants.json');RW=$false},
                        @{Destination='/run/secrets/session';Type='bind';Source=(Join-Path $releaseContext.State 'secrets/session');RW=$false},
                        @{Destination='/run/secrets/postgres-app';Type='bind';Source=(Join-Path $releaseContext.State 'secrets/postgres-app');RW=$false})
                }
                $name = if ($service -ceq 'app' -and $inspectedAppName) { $inspectedAppName }
                    else { "/$($releaseContext.Project)-agent-control-$service-1" }
                $ports = if ($service -ceq 'postgres') { @{} }
                    else { @{'3001/tcp'=@(@{HostIp='127.0.0.1';HostPort=[string]$releaseContext.Port})} }
                return (@{name=$name;mounts=$mounts;ports=$ports;networks=@{$releaseContext.Network=@{}};memory=0;cpus=0} | ConvertTo-Json -Depth 10)
            }
            if ($Arguments[0] -cin @('volume','network')) {
                if ($Arguments[0] -ceq 'volume' -and $Arguments[-1] -cin @($releaseContext.McpVolume,$releaseContext.McpRecordingVolume)) {
                    $recordings = $Arguments[-1] -ceq $releaseContext.McpRecordingVolume
                    return (@{name=$Arguments[-1];driver='local';createdAt='2026-01-01T00:00:00Z';labels=@{
                        'com.docker.compose.project'=$(if ($recordings) {$releaseRecordingProject} else {$releaseContext.Project})
                        'com.docker.compose.volume'=$(if ($recordings) {'mcp-recordings'} else {'mcp-oauth'})
                        'io.agent-control.purpose'=$(if ($recordings) {'mcp-session-recordings'} else {'encrypted-oauth-state'})
                    }} | ConvertTo-Json -Depth 5)
                }
                if ($Arguments[3] -ceq '{{json .Labels}}') {
                    return (@{'com.docker.compose.project'=$releaseContext.Project
                        "com.docker.compose.$($Arguments[0])"=$(if ($Arguments[0] -ceq 'volume') {'data'} else {'default'})} | ConvertTo-Json)
                }
                return $(if ($Arguments[0] -ceq 'volume') {'2026-01-01T00:00:00Z'} else {'offline-network-id'})
            }
            if ($Arguments[0] -ceq 'context') { return 'offline-docker-context' }
            if ($Arguments[0] -ceq 'info') { return 'offline-docker-engine' }
            if ($Arguments[0] -ceq 'exec') { return 'f' }
            throw 'Unexpected release-target Docker mock command.'
        }
        $releaseTarget = Get-LocalReleaseTarget $releaseContext
        Assert ($releaseTarget.containers.Count -eq 2) 'Read-only target rejected the current explicitly named Compose containers.'
        foreach ($invalidName in @("/$($context.Project)-app-1",'/different-project-agent-control-app-1')) {
            $inspectedAppName = $invalidName
            Fails { Get-LocalReleaseTarget $releaseContext } 'network/name mismatch'
        }
        $inspectedAppName = $null
        $releaseContext.Mcp = @{port=14392}
        $releaseMcpDetails = @{name="/$($releaseContext.Project)-agent-control-mcp-1";user='1000:1000'
            networks=@{$releaseContext.Network=@{}};ports=@{'8000/tcp'=@(@{HostIp='127.0.0.1';HostPort='14392'})}
            mounts=@(
                @{Destination='/run/secrets/mcp-client';Type='bind';Source=(Join-Path $releaseContext.State 'secrets/mcp-client');RW=$false},
                @{Destination='/run/secrets/mcp-signing';Type='bind';Source=(Join-Path $releaseContext.State 'secrets/mcp-signing');RW=$false},
                @{Destination='/run/secrets/mcp-encryption';Type='bind';Source=(Join-Path $releaseContext.State 'secrets/mcp-encryption');RW=$false},
                @{Destination='/var/lib/agent-control-mcp/oauth';Type='volume';Name=$releaseContext.McpVolume;RW=$true},
                @{Destination='/var/lib/agent-control-mcp/recordings';Type='volume';Name=$releaseContext.McpRecordingVolume;RW=$true})}
        try {
            foreach ($name in @('mcp-client','mcp-signing','mcp-encryption')) {
                Write-LocalText (Join-Path $releaseContext.State "secrets/$name") "synthetic-release-$name"
            }
            $withMcp = Get-LocalReleaseTarget $releaseContext
            Assert ($withMcp.containers.Count -eq 3 -and
                $withMcp.resources.Count -eq $releaseTarget.resources.Count) 'Release target rejected separate diagnostics or added disposable volume receipts.'
            foreach ($field in @('Name','Type','RW')) {
                $saved=$releaseMcpDetails.mounts[-1][$field]
                $releaseMcpDetails.mounts[-1][$field]=if ($field -ceq 'RW') {$false} elseif ($field -ceq 'Type') {'bind'} else {$releaseContext.McpVolume}
                Fails { Get-LocalReleaseTarget $releaseContext } 'volume identity/access mismatch'
                $releaseMcpDetails.mounts[-1][$field]=$saved
            }
            $releaseRecordingProject='other-project'
            Fails { Get-LocalReleaseTarget $releaseContext } 'recording volume ownership/purpose'
            $releaseRecordingProject=$releaseContext.Project
            $saved=$releaseMcpDetails.mounts
            $releaseMcpDetails.mounts=$saved[0..3]
            Fails { Get-LocalReleaseTarget $releaseContext } 'mount inventory differs'
            $releaseMcpDetails.mounts=$saved
        } finally {
            foreach ($name in @('mcp-client','mcp-signing','mcp-encryption')) {
                Remove-Item -LiteralPath (Join-Path $releaseContext.State "secrets/$name") -ErrorAction SilentlyContinue
            }
        }
    }
    $receipt=(Get-FileHash -LiteralPath (Join-Path $context.State 'deployment.json')).Hash
    $health=$script:healthCalls
    $appliedComposeFiles=$context.AppliedComposeFiles -join '|'
    $messages=Run-Deploy
    Assert (($messages -join "`n").Contains('ALREADY RUNNING')) 'Unchanged healthy start was not a no-op.'
    Assert (($context.AppliedComposeFiles -join '|') -ceq $appliedComposeFiles) 'No-op relabeled an unapplied snapshot as the container Compose ownership.'
    Assert ($script:healthCalls -eq $health+1) 'No-op skipped fresh host readiness.'
    Assert (-not (($script:calls -join "`n") -match '(?m)\|stop\||database\.ts\|initialize$|\|90\|app$')) 'No-op restarted the app or initialized the database.'
    Assert ((Get-FileHash -LiteralPath (Join-Path $context.State 'deployment.json')).Hash -ceq $receipt) 'No-op rewrote its deployment identity.'
    $script:operationalMode='maintenance'
    $messages=Run-Deploy
    Assert ($script:operationalMode -eq 'normal' -and ($messages -join "`n").Contains('ALREADY RUNNING') -and
        -not (($script:calls -join "`n") -match '\|stop\||database\.ts\|reset\|')) 'Normal start left a healthy deployment stuck in saved-only admission.'
    & {
        $context.ProxyNetworkInput='agent-control-local-ingress'
        $context.PublicUrlInput='https://control.runtime.example.invalid'
        $postgresImage=$script:containers[('b'*64)].image
        $messages=Run-Deploy
        Assert (($messages -join "`n").Contains('Shared ingress: agent-control-local-ingress')) 'Ingress deployment omitted its truthful routing summary.'
        Assert ($script:containers[('a'*64)].networks.Contains($context.Network) -and
            $script:containers[('a'*64)].networks[$context.ProxyNetwork].Aliases -ccontains 'runtime-test-app') 'App deployment lost its private network or stable ingress alias.'
        Assert ($script:containers[('b'*64)].image -ceq $postgresImage -and $script:containers[('b'*64)].networks.Count -eq 1) 'Ingress deployment replaced or exposed PostgreSQL.'
        Assert (-not (($script:calls -join "`n") -match '^network\|(create|rm|connect|disconnect)|database\.ts\|(reset|initialize)')) 'Ingress deployment managed shared infrastructure or reset/reinitialized the database.'
        $messages=Run-Deploy
        Assert (($messages -join "`n").Contains('ALREADY RUNNING') -and -not (($script:calls -join "`n") -match '\|stop\||\|90\|app$')) 'Unchanged saved ingress restarted the app.'
        $script:proxyNetworkId='e'*64
        Fails { Run-Deploy } 'network identity changed'
        Assert ($script:containers[('a'*64)].running -and -not (($script:calls -join "`n") -match '^build\||\|stop\|')) 'Changed ingress identity reached app mutation.'
        $script:proxyNetworkId='f'*64
        $context.ProxyNetworkInput='none';$context.PublicUrlInput='local'
        Run-Deploy | Out-Null
        Assert ($script:containers[('a'*64)].networks.Count -eq 1 -and -not $context.ProxyNetwork) 'Explicit standalone deployment retained ingress attachment.'
        $context.Remove('ProxyNetworkInput');$context.Remove('PublicUrlInput');$context.Remove('ProxyNetworkId')
    }
    & {
        $beforeSettings = (Get-FileHash -LiteralPath (Join-Path $context.State 'settings.json')).Hash
        $beforeEnvironment = (Get-FileHash -LiteralPath (Join-Path $context.State 'compose.env')).Hash
        $beforeRegistry = (Get-FileHash -LiteralPath (Join-Path $context.State 'secrets/tenants.json')).Hash
        Assert (-not (Read-LocalSettings $context.State).Contains('mcp') -and
            -not [IO.File]::ReadAllText((Join-Path $context.State 'compose.env')).Contains('MCP_')) 'First MCP setup regression requires an existing project without MCP settings.'
        $context.ConfigureMcp = $true
        foreach ($answer in @('','33333333-3333-4333-8333-333333333333','https://mcp.runtime.example.invalid/mcp','https://client.example.invalid/callback','14400','','','synthetic-mcp-runtime-test-secret')) {
            $script:answers.Enqueue($answer)
        }
        $script:validateDatabaseCompose = $true
        $script:failure = '[\\/]mcp[\\/]Dockerfile\|'
        try {
            Fails { Run-Deploy } 'Simulated Docker failure'
            Assert (($script:calls -join "`n") -match '(?m)database\.ts\|preflight$') 'First MCP setup never reached the database preflight.'
            Assert (($script:calls -join "`n") -match '[\\/]mcp[\\/]Dockerfile\|') 'First MCP setup did not reach the deliberately interrupted MCP build.'
            if ($script:dockerExecutable) { Assert ($script:composeValidations -eq 1) 'First MCP setup did not validate the actual database Compose configuration.' }
            Assert ((Get-FileHash -LiteralPath (Join-Path $context.State 'settings.json')).Hash -ceq $beforeSettings -and
                (Get-FileHash -LiteralPath (Join-Path $context.State 'compose.env')).Hash -ceq $beforeEnvironment -and
                (Get-FileHash -LiteralPath (Join-Path $context.State 'secrets/tenants.json')).Hash -ceq $beforeRegistry) 'Interrupted MCP setup saved planned configuration before builds succeeded.'
            Assert ($script:containers[('a'*64)].running -and
                -not (Test-Path -LiteralPath (Join-Path $context.State 'control/maintenance')) -and
                -not (($script:calls -join "`n") -match '\|stop\||database\.ts\|(reset|initialize)\|?')) 'Interrupted MCP setup stopped the existing app or changed the database.'
            foreach ($name in @('mcp-client','mcp-signing','mcp-encryption')) {
                Assert (-not (Test-Path -LiteralPath (Join-Path $context.State "secrets/$name"))) 'Interrupted MCP setup persisted new credentials.'
            }
        } finally {
            $script:failure = ''
            $script:validateDatabaseCompose = $false
            $context.ConfigureMcp = $false
            Sync-LocalMcpContext $context (Read-LocalSettings $context.State)
        }
    }
    & {
        $previousContainers = $script:containers
        $script:containers = @{}
        foreach ($id in $previousContainers.Keys) { $script:containers[$id] = $previousContainers[$id].Clone() }
        try {
            $previousContext = $context
            $context = New-LocalContext $root 'runtime-metadata-test'
            [IO.Directory]::CreateDirectory((Join-Path $context.State 'secrets')) | Out-Null
            foreach ($name in @('postgres-admin','postgres-app','session')) {
                Write-LocalText (Join-Path $context.State "secrets/$name") ([IO.File]::ReadAllText((Join-Path $previousContext.State "secrets/$name")))
            }
            $profiles = ConvertFrom-DeploymentTenantRegistry ([IO.File]::ReadAllText((Join-Path $previousContext.State 'secrets/tenants.json')))
            $profiles[0].integration = @{clientId='33333333-3333-4333-8333-333333333333';audience=$profiles[0].clientId;scope='AgentControl.Access'}
            $settings = Read-LocalSettings $previousContext.State
            $settings.tenants = Get-LocalTenantMetadata $profiles
            $settings.mcp = @{tenantId=$profiles[0].tenantId;apiClientId=$profiles[0].clientId;clientId=$profiles[0].integration.clientId
                publicUrl='https://mcp.runtime.example.invalid/mcp';redirectUris=@('https://client.example.invalid/callback');port=14400}
            Write-LocalText (Join-Path $context.State 'settings.json') ($settings | ConvertTo-Json -Depth 20)
            Write-LocalText (Join-Path $context.State 'secrets/tenants.json') (ConvertTo-Json -InputObject $profiles -Depth 20)
            Write-LocalText (Join-Path $context.State 'secrets/mcp-client') 'synthetic-mcp-runtime-test-secret'
            Write-LocalText (Join-Path $context.State 'secrets/mcp-signing') ([Convert]::ToBase64String([byte[]](1..32)).Replace('+','-').Replace('/','_'))
            Write-LocalText (Join-Path $context.State 'secrets/mcp-encryption') (ConvertTo-Json -InputObject @([Convert]::ToBase64String([byte[]](33..64)).Replace('+','-').Replace('/','_')))
            $context = New-LocalContext $root $context.Project
            $context.OperatorImageId = $script:operator
            $context.RuntimeImageId = $script:runtime
            Write-LocalComposeEnvironment $context
            $initialFiles = @((Join-Path $root 'compose.yaml'),(Join-Path $root 'compose.mcp.yaml'))
            Write-LocalText (Join-Path $context.State 'deployment.json') ((Get-LocalDeploymentIdentity $context $initialFiles) | ConvertTo-Json)
            Assert (-not (Test-Path -LiteralPath (Join-Path $context.State 'secrets/mcp-metadata'))) 'Metadata regression requires an existing MCP project without the optional credential.'
            $protected = @{}
            foreach ($name in @('postgres-admin','postgres-app','session','tenants.json','mcp-client','mcp-signing','mcp-encryption')) {
                $protected[$name] = (Get-FileHash -LiteralPath (Join-Path $context.State "secrets/$name")).Hash
            }
            $validations = [Collections.Generic.List[object]]::new()
            function Build-LocalMcpArtifact { param($Context,$Snapshot) return ('sha256:' + ('7' * 64)) }
            function Test-LocalMcpConfiguration {
                param($Context)
                $files = @(for ($index=0; $index -lt $Context.Compose.Count-1; $index++) {
                    if ($Context.Compose[$index] -eq '-f') { $Context.Compose[$index+1] }
                })
                $validations.Add(@{Files=$files;SnapshotFiles=@($snapshot.ComposeFiles);AppliedFiles=@($Context.AppliedComposeFiles)
                    CommandMatches=(($snapshot.Compose -join '|') -ceq ($Context.Compose -join '|'))
                    Frozen=(@($files | Where-Object { (Split-Path $_ -Parent) -cne $snapshot.Root -or -not (Test-Path -LiteralPath $_) }).Count -eq 0)})
                Assert (Test-LocalMcpMetadataCredential $Context) 'Normal configuration save did not automatically create an independent usable metadata credential.'
            }
            function Start-LocalMcp { param($Context) }
            $messages = Run-Deploy
            $firstApplied = @($context.AppliedComposeFiles)
            $firstReceipt = (Get-FileHash -LiteralPath (Join-Path $context.State 'deployment.json')).Hash
            $firstApp = @($script:calls | Where-Object { $_ -match '\|up\|' -and $_ -match '\|app$' })
            $metadataHash = (Get-FileHash -LiteralPath (Join-Path $context.State 'secrets/mcp-metadata')).Hash
            $context = New-LocalContext $root $context.Project
            $messages = Run-Deploy
            $noOp = ($messages -join "`n").Contains('ALREADY RUNNING')
            $unchangedReceipt = (Get-FileHash -LiteralPath (Join-Path $context.State 'deployment.json')).Hash -ceq $firstReceipt
            Write-Host "Metadata lifecycle regression: used=$($validations[0].Files.Count), snapshot=$($validations[0].SnapshotFiles.Count), applied=$($firstApplied.Count), unchangedStartNoOp=$noOp, receiptUnchanged=$unchangedReceipt."
            Assert (($firstApplied -join '|') -ceq ($validations[0].Files -join '|')) 'First metadata start omitted an actually applied Compose input from ownership evidence.'
            foreach ($validation in $validations) {
                Assert ($validation.CommandMatches -and $validation.Frozen) 'Final Compose command differs from its fixed source snapshot.'
                Assert (($validation.SnapshotFiles -join '|') -ceq ($validation.Files -join '|') -and
                    ($validation.AppliedFiles -join '|') -ceq ($validation.Files -join '|')) 'Final snapshot/applied Compose inputs were stale at configuration validation.'
            }
            Assert ($validations.Count -eq 2 -and $validations[0].Files.Count -eq 3 -and
                [IO.Path]::GetFileName($validations[0].Files[-1]) -ceq 'compose.mcp-metadata.yaml') 'Metadata upgrade did not use all three snapshot-root Compose inputs.'
            Assert ($firstApp.Count -eq 1 -and $firstApp[0].Contains(($firstApplied -join '|-f|'))) 'Applied evidence differs from the first actual app startup command.'
            Assert ($noOp -and $unchangedReceipt -and -not (($script:calls -join "`n") -match '\|stop\||database\.ts\|initialize$|\|90\|app$')) 'Unchanged start after automatic metadata setup restarted the app or changed its receipt.'
            Assert ((Get-FileHash -LiteralPath (Join-Path $context.State 'secrets/mcp-metadata')).Hash -ceq $metadataHash) 'Unchanged start rotated the optional metadata credential.'
            foreach ($name in $protected.Keys) {
                Assert ((Get-FileHash -LiteralPath (Join-Path $context.State "secrets/$name")).Hash -ceq $protected[$name]) 'Automatic metadata setup changed retained synthetic credentials.'
            }
        } finally { $script:containers = $previousContainers }
    }
    $script:runtime='sha256:' + ('e' * 64)
    $messages=Run-Deploy
    Assert (($script:calls -join "`n") -match '\|stop\|--timeout\|130\|app') 'Changed image was not drained.'
    Assert (-not (($script:calls -join "`n") -match '(?m)database\.ts\|initialize$')) 'Application-only update unnecessarily initialized the database.'
    $script:operator='sha256:' + ('f' * 64)
    $messages=Run-Deploy
    Assert (($script:calls -join "`n") -match '(?m)database\.ts\|initialize$') 'Changed database operator contract did not reapply bootstrap/grants.'
    $messages=Run-Deploy -ForceChecks
    Assert ($script:checked -eq 1 -and ($messages -join "`n").Contains('[AUTOMATED CHECKS] PASSED')) 'ForceChecks did not run explicit validation.'
    $script:failure='checks'
    Fails { Run-Deploy -ForceChecks } 'Simulated checks failure'
    Assert (-not (($script:calls -join "`n") -match '(?m)\|stop\||database\.ts\|initialize$')) 'Failed explicit checks changed the application.'
    $script:failure=''
    $script:wrongOwner=$true
    Fails { Run-Deploy } 'ownership mismatch'
    Assert (-not (($script:calls -join "`n") -match '^build\||\|up\|')) 'Foreign container ownership was discovered after changing services.'
    $script:wrongOwner=$false
    $settingsPath=Join-Path $context.State 'settings.json'
    $settings=Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -AsHashtable
    $settings.publicUrl='https://runtime.example.invalid'
    Write-LocalText $settingsPath ($settings | ConvertTo-Json -Depth 6)
    $messages=Run-Deploy
    Assert (($script:calls -join "`n") -match '\|stop\|' -and -not (($script:calls -join "`n") -match '(?m)database\.ts\|initialize$')) 'Configuration-only update did not restart without database initialization.'
    $reauthenticate=Join-Path $context.State 'control/reauthenticate'
    Write-LocalText $reauthenticate 'pending'
    $messages=Run-Deploy
    Assert (-not (Test-Path -LiteralPath $reauthenticate) -and ($script:calls -join "`n") -match 'DELETE FROM public.sessions;') 'Pending reauthentication was bypassed by no-op detection.'
    foreach ($invalid in @(
        @{state='compatible';currentFingerprint=$script:targetFingerprint;targetFingerprint=$script:targetFingerprint},
        @{state='fresh';targetFingerprint=$script:targetFingerprint},
        @{state='fresh';currentFingerprint=$script:targetFingerprint;targetFingerprint=$script:targetFingerprint},
        @{state='current';currentFingerprint=$null;targetFingerprint=$script:targetFingerprint},
        @{state='current';currentFingerprint=('2'*64);targetFingerprint=$script:targetFingerprint},
        @{state='current';currentFingerprint='bad';targetFingerprint='bad'}
    )) {
        $script:preflightOverride=$invalid | ConvertTo-Json -Compress
        Fails { Run-Deploy } 'Invalid database preflight result'
        Assert (-not (($script:calls -join "`n") -match '\|stop\||database\.ts\|(initialize|reset)|\|--target\|runtime\|')) 'Invalid schema evidence mutated the database, drained the app or built the runtime.'
    }
    $script:preflightOverride=$null
    $script:targetFingerprint='2'*64
    Fails { Run-Deploy } 'database_schema_reset_required'
    Assert (-not (($script:calls -join "`n") -match '\|stop\||database\.ts\|(initialize|reset)|\|--target\|runtime\|')) 'Changed schema was automatically converted.'
    $messages=Run-Deploy -DbReset 3>$null
    Assert ($context.DbResetStarted -and ($script:calls -join "`n") -match 'database\.ts\|reset\|agentcontrol') 'Explicit reset no longer recreates only the selected database.'
    Assert (($script:calls -join "`n") -match '(?m)database\.ts\|initialize$' -and -not (($script:calls -join "`n") -match 'backup\.ts|pg_dump')) 'Explicit reset did not initialize the current schema without a pre-reset backup.'
    Assert ($script:operationalMode -eq 'normal' -and ($script:calls -join "`n") -match 'database\.ts\|resume') 'Completed reset did not return to normal operation.'
    $initializing=Join-Path $context.State 'control/database-initializing'
    $operationPath=Join-Path $context.State 'deployment-operation.json'
    $completedOperation=Get-Content -LiteralPath $operationPath -Raw | ConvertFrom-Json -AsHashtable
    $completedOperation.candidate='f'*64
    Write-LocalText $operationPath ($completedOperation | ConvertTo-Json -Depth 30)
    $messages=Run-Deploy -DbReset 3>$null
    $freshOperation=Get-Content -LiteralPath $operationPath -Raw | ConvertFrom-Json -AsHashtable
    Assert ($context.DbResetStarted -and @($script:calls | Where-Object { $_ -match 'database\.ts\|reset\|agentcontrol$' }).Count -eq 1) 'A completed pinned receipt blocked a new explicit reset.'
    Assert ($freshOperation.step -eq 'verified' -and $freshOperation.resetStatus -eq 'completed' -and -not $freshOperation.candidate) 'A new ordinary reset retained the previous pinned operation identity.'
    $messages=Run-Deploy -DbReset 3>$null
    Assert ($context.DbResetStarted -and @($script:calls | Where-Object { $_ -match 'database\.ts\|reset\|agentcontrol$' }).Count -eq 1) 'A completed ordinary receipt silently skipped a new explicit reset.'
    $messages=Run-Deploy
    Assert (($messages -join "`n").Contains('ALREADY RUNNING') -and
        -not (($script:calls -join "`n") -match '\|stop\||database\.ts\|(reset|initialize)\|')) 'Ordinary start after a completed reset repeated destructive work.'
    Write-LocalText $initializing 'pending'
    $script:failure='database\.ts\|initialize(?:\|closed)?$'
    Fails { Run-Deploy 3>$null } 'Simulated Docker failure'
    Assert (Test-Path -LiteralPath $initializing) 'Failed database initialization lost its repair marker.'
    $script:failure=''
    $script:currentFingerprint=$script:targetFingerprint
    $messages=Run-Deploy
    Assert (($script:calls -join "`n") -match '(?m)database\.ts\|initialize(?:\|closed)?$' -and -not (($script:calls -join "`n") -match 'database\.ts\|reset\|')) 'Retry skipped failed grants because fingerprints matched, or repeated a destructive reset without authorization.'
    Assert (-not (Test-Path -LiteralPath $initializing)) 'Successful initialization retained an obsolete repair marker.'
    $script:ready=$false
    Fails { Run-Deploy } 'readiness failure'
    $script:ready=$true
    $receiptPath=Join-Path $context.State 'deployment.json'
    $validReceipt=[IO.File]::ReadAllText($receiptPath)
    [IO.File]::WriteAllText($receiptPath,'{}')
    Fails { Run-Deploy } 'receipt is invalid'
    Assert (-not (($script:calls -join "`n") -match '^build\||\|up\|')) 'Invalid deployment identity was silently accepted.'
    [IO.File]::WriteAllText($receiptPath,$validReceipt)
    $lock=[IO.File]::Open((Join-Path $root "artifacts/local-operations/$($context.Project).lock"),'Open','ReadWrite','None')
    try {
        foreach ($operation in @('Deploy','Stop','EditConfig','Retain','Backup')) {
            $script:calls.Clear()
            Fails { Invoke-LocalDeployment $context $operation } 'Another operation'
            Assert ($script:calls.Count -eq 0) 'Concurrent project operation reached Docker.'
        }
    } finally { $lock.Dispose() }
    $savedSettings=[IO.File]::ReadAllText((Join-Path $context.State 'settings.json'))
    [IO.File]::WriteAllText((Join-Path $context.State 'settings.json'),'invalid settings')
    $stopContext=New-LocalContext $root $context.Project -SkipSettings
    Invoke-LocalDeployment $stopContext Stop 6>$null
    Assert (-not $script:containers[('a' * 64)].running -and -not $script:containers[('b' * 64)].running) 'Stop depended on valid onboarding configuration.'
    [IO.File]::WriteAllText((Join-Path $context.State 'settings.json'),$savedSettings)
    $messages=Run-Deploy
    Assert (-not (($script:calls -join "`n") -match '(?m)database\.ts\|initialize$|\|stop\|')) 'Stopped unchanged services were not resumed without initialization/drain.'
    $script:calls.Clear()
    $beforeCheck=$script:checked
    $checkContext=New-LocalContext $root $context.Project -SkipSettings
    Invoke-LocalDeployment $checkContext Test 6>$null
    Assert ($script:checked -eq $beforeCheck+1) 'Explicit check did not execute validation.'
    Assert (-not (($script:calls -join "`n") -match 'database\.ts|--wait-timeout|secrets/')) 'Check accessed application runtime/database configuration.'
    $script:failure='database\.ts\|preflight$'
    Fails { Run-Deploy } 'Database preflight failed'
    Assert (-not (($script:calls -join "`n") -match '\|--target\|runtime\||\|stop\|')) 'Failed preflight reached runtime compilation or shutdown.'
    $script:failure=''
    # Real candidate consumer with mocked immutable images and the existing executor.
    $script:candidateInputs=@('deploy-local.ps1','deploy-local.sh','scripts/local-launcher.Dockerfile','scripts/local-launcher-inputs.ps1','scripts/local-deployment.ps1','scripts/local-runtime.ps1','scripts/local-mcp.ps1','scripts/local-proxy.ps1','compose.proxy.yaml','compose.mcp-proxy.yaml','backend/scripts/database.ts')
    foreach ($path in $script:candidateInputs) {
        $destination=Join-Path $root $path
        [IO.Directory]::CreateDirectory((Split-Path $destination -Parent)) | Out-Null
        if ($path -eq 'backend/scripts/database.ts') { Write-LocalText $destination 'synthetic-operator-bytes' }
        else { Copy-Item -LiteralPath (Join-Path $repository $path) -Destination $destination }
    }
    $candidateDirectory=Join-Path $root 'artifacts/candidate'
    [IO.Directory]::CreateDirectory($candidateDirectory) | Out-Null
    $context.SourceEvidenceFile=Join-Path $candidateDirectory 'source.json'
    $frozen=New-LocalBuildSnapshot $context
    $script:runtime='sha256:' + ('9'*64)
    $script:candidateHash=$context.SourceHash
    $script:targetFingerprint='e671d8d1fda5d0276bcfac9db8a879a78feea048eb0e84127727e894781f5244'
    $context.Candidate=Join-Path $candidateDirectory 'build.json'
    Write-LocalText $context.Candidate (@{schemaContract='current-only';schemaFingerprint=$script:targetFingerprint
        sourceRoot=$frozen.Root;sourceManifest=$context.SourceEvidenceFile;sourceManifestHash=$context.SourceHash
        builtFilesHash=('c'*64);builtFileCount=198;operatorCliSha256=(Get-FileHash -LiteralPath (Join-Path $root 'backend/scripts/database.ts')).Hash.ToLowerInvariant()
        images=@{runtime=@{tag='candidate-runtime:local';id=$script:runtime;sourceManifestHash=$context.SourceHash}
            operator=@{tag='candidate-operator:local';id=$script:operator;sourceManifestHash=$context.SourceHash}}} | ConvertTo-Json -Depth 6)
    $context.CandidateSha256=(Get-FileHash -LiteralPath $context.Candidate).Hash.ToLowerInvariant()
    $portableCandidate = Read-LocalCandidate $context
    Assert ($portableCandidate.sourceManifestHash -ceq $context.SourceHash) 'Candidate inventory must match its slash-separated Git manifest on every supported OS.'
    foreach ($path in @('deploy-local.sh','scripts/local-launcher.Dockerfile','scripts/local-launcher-inputs.ps1','scripts/local-proxy.ps1','compose.proxy.yaml','compose.mcp-proxy.yaml')) {
        $inputFile=Join-Path $root $path
        $originalInput=[IO.File]::ReadAllText($inputFile)
        try {
            [IO.File]::AppendAllText($inputFile,"`n# synthetic unqualified tooling change`n")
            Fails { Read-LocalCandidate $context } 'tooling differs'
        } finally { [IO.File]::WriteAllText($inputFile,$originalInput) }
    }
    & {
        $linkType = if ($IsWindows) { 'Junction' } else { 'SymbolicLink' }
        $artifactLink = Join-Path $root 'artifacts/linked-candidate'
        $sourceLink = Join-Path $root 'artifacts/linked-candidate-source'
        New-Item -ItemType $linkType -Path $artifactLink -Target $candidateDirectory | Out-Null
        New-Item -ItemType $linkType -Path $sourceLink -Target $frozen.Directory | Out-Null
        $linkedContext = $context.Clone()
        $linkedContext.Candidate = Join-Path $artifactLink 'build.json'
        $script:calls.Clear()
        Fails { Read-LocalCandidate $linkedContext } 'Symbolic build input paths'
        Assert ($script:calls.Count -eq 0) 'Linked candidate reached Docker verification.'
        $linkedContext.Candidate = Join-Path $candidateDirectory 'linked-inputs.json'
        foreach ($field in @('sourceRoot','sourceManifest')) {
            $linkedCandidate = $portableCandidate.Clone()
            $linkedCandidate[$field] = if ($field -eq 'sourceRoot') { Join-Path $sourceLink 'source' } else { Join-Path $artifactLink 'source.json' }
            Write-LocalText $linkedContext.Candidate ($linkedCandidate | ConvertTo-Json -Depth 6)
            $linkedContext.CandidateSha256 = (Get-FileHash -LiteralPath $linkedContext.Candidate).Hash.ToLowerInvariant()
            Fails { Read-LocalCandidate $linkedContext } 'Symbolic build input paths'
            Assert ($script:calls.Count -eq 0) 'Linked candidate source/manifest reached Docker verification.'
        }
        Remove-Item -LiteralPath $artifactLink -Force
        Remove-Item -LiteralPath $sourceLink -Force
    }
    $secretPath=Join-Path $context.State 'secrets/tenants.json'
    $savedRegistry=[IO.File]::ReadAllText($secretPath)
    $beforeIdentity=Get-LocalDeploymentIdentity $context @()
    Write-LocalText $secretPath ($savedRegistry+"`n")
    $changedIdentity=Get-LocalDeploymentIdentity $context @()
    Assert ($beforeIdentity.secretConfiguration -cne $changedIdentity.secretConfiguration -and
        $beforeIdentity.database -ceq $changedIdentity.database) 'Exact secret configuration binding missed tenant registry changes or changed the database identity.'
    Write-LocalText $secretPath $savedRegistry
    $script:currentFingerprint=$script:targetFingerprint
    function Get-LocalReleaseTarget {
        param($Context)
        return [ordered]@{project=$Context.Project;root=$Context.Root;state=$Context.State;dockerContext='owned';engine='owned-engine';endpoint='owned'
            origin=$Context.PublicUrl;port=$Context.Port;tenantRegistryHash=('1'*64);secretBinding=('2'*64)
            configuration=@{'settings.json'=(Get-FileHash -LiteralPath (Join-Path $Context.State 'settings.json')).Hash.ToLowerInvariant()
                'compose.env'=(Get-FileHash -LiteralPath (Join-Path $Context.State 'compose.env')).Hash.ToLowerInvariant()}
            containers=@(@{service='postgres';id=('b'*64);image=('sha256:' + ('d'*64))},@{service='app';id=('a'*64);image=$script:runtime})
            schema=@{fingerprint=$script:currentFingerprint};databaseAction=$Context.DatabaseAction}
    }
    function Get-LocalReleaseObservations { param($Context) return @{fixture='bounded synthetic observation'} }
    $context.ReadOnly=$true
    $before=(Get-FileHash -LiteralPath (Join-Path $context.State 'compose.env')).Hash
    $report=Run-Deploy
    $evidence=@($report | Where-Object { $_ -is [Collections.IDictionary] })[0]
    $context.ExpectedPreflight=$evidence.preflight
    Assert ($evidence.status -ceq 'deployment_pending' -and -not $evidence.productionMutation) 'Read-only candidate preflight fabricated deployment.'
    Assert (-not (($script:calls -join "`n") -match '\|up\||\|stop\||backend/scripts/database\.ts\|(?!preflight)|backup.ts|\|update\|') -and
        (Get-FileHash -LiteralPath (Join-Path $context.State 'compose.env')).Hash -ceq $before) 'Read-only candidate preflight changed the installation.'
    $context.ReadOnly=$false
    $context.CandidateSha256='0'*64
    Fails { Run-Deploy } 'digest mismatch'
    $context.CandidateSha256=(Get-FileHash -LiteralPath $context.Candidate).Hash.ToLowerInvariant()
    $approved=$context.ExpectedPreflight
    $context.ExpectedPreflight='0'*64
    Fails { Run-Deploy } 'preflight identity changed'
    Assert (-not (($script:calls -join "`n") -match 'backend/scripts/database\.ts\||\|stop\|')) 'Unapproved preflight drained or contacted the database.'
    $context.ExpectedPreflight=$approved
    $script:failure='backup.ts'
    Fails { Run-Deploy } 'Simulated Docker failure'
    Assert ((Test-Path -LiteralPath (Join-Path $context.State 'control/maintenance')) -and
        -not (($script:calls -join "`n") -match 'database\.ts\|resume')) 'Failed checkpoint did not keep maintenance active.'
    $script:failure='database\.ts\|resume'
    Fails { Run-Deploy } 'Simulated Docker failure'
    $progress=Get-Content -LiteralPath (Join-Path $context.State 'deployment-operation.json') -Raw | ConvertFrom-Json
    Assert ($progress.step -ceq 'checkpointed' -and (Test-Path -LiteralPath $progress.checkpoint)) 'Interrupted release lost its protected checkpoint receipt.'
    $checkpointHash=(Get-FileHash -LiteralPath $progress.checkpoint).Hash
    Write-LocalText $progress.checkpoint 'tampered'
    $script:failure=''
    Fails { Run-Deploy } 'checkpoint changed'
    Write-LocalText $progress.checkpoint 'synthetic-protected-checkpoint'
    Assert ((Get-FileHash -LiteralPath $progress.checkpoint).Hash -ceq $checkpointHash) 'Synthetic checkpoint was not restored exactly.'
    $script:ready=$false
    Fails { Run-Deploy } 'readiness failure'
    Assert (-not (($script:calls -join "`n") -match 'backup.ts') -and ($script:calls -join "`n") -match 'database\.ts\|resume') 'Resume recreated the checkpoint or failed to return to normal operation.'
    $script:ready=$true
    $script:replacePostgresOnAppStart=$true
    $beforeReceipt=(Get-FileHash -LiteralPath (Join-Path $context.State 'deployment.json')).Hash
    Fails { Run-Deploy } 'PostgreSQL identity changed'
    Assert ((Test-Path -LiteralPath (Join-Path $context.State 'control/maintenance')) -and
        (Get-FileHash -LiteralPath (Join-Path $context.State 'deployment.json')).Hash -ceq $beforeReceipt) 'Changed PostgreSQL identity was published as a verified release.'
    $script:replacePostgresOnAppStart=$false
    $script:containers.Remove(('e' * 64))
    $script:containers[('b' * 64)]=@{service='postgres';running=$true;image=('sha256:' + ('d'*64))}
    $messages=Run-Deploy
    $applied=Get-Content -LiteralPath (Join-Path $context.State 'deployment.json') -Raw | ConvertFrom-Json
    $progress=Get-Content -LiteralPath (Join-Path $context.State 'deployment-operation.json') -Raw | ConvertFrom-Json
    Assert ($applied.candidate -ceq $context.CandidateSha256 -and $applied.schemaFingerprint -ceq $script:targetFingerprint -and
        $progress.step -ceq 'verified') 'Resumed exact candidate did not persist its verified release identity.'
    Assert (-not (($script:calls -join "`n") -match '^build\||backup.ts|reset\|') -and (Test-Path -LiteralPath $frozen.Root)) 'Pinned deployment rebuilt/deleted its candidate or replayed destructive work.'
    $appStarts = @($script:calls | Where-Object { $_ -match '\|up\|' -and $_ -match '\|app$' })
    Assert ($appStarts.Count -eq 1 -and $appStarts[0] -match '\|--no-deps\|') 'Pinned app startup can recreate the approved retained PostgreSQL dependency.'
    $messages=Run-Deploy
    Assert (-not (($script:calls -join "`n") -match '\|stop\||backup.ts|maintenance\|confirmed') -and
        (Get-FileHash -LiteralPath $progress.checkpoint).Hash -ceq $checkpointHash) 'Verified pinned deployment replayed its maintenance/checkpoint.'
    $context.ReadOnly=$true
    $resetReport=Run-Deploy -DbReset
    $resetEvidence=@($resetReport | Where-Object { $_ -is [Collections.IDictionary] })[0]
    Assert ($resetEvidence.preflight -cne $context.ExpectedPreflight -and $resetEvidence.target.databaseAction -eq 'reset') 'Reset action is not bound in read-only approval identity.'
    $context.ReadOnly=$false
    Fails { Run-Deploy -DbReset } 'different approved action'
    Assert (-not (($script:calls -join "`n") -match '\|stop\||database\.ts\|reset\|')) 'Normal release approval authorized a reset.'
    $context.ExpectedPreflight=$resetEvidence.preflight
    $script:failure='preflight-reset'
    Fails { Run-Deploy -DbReset } 'Database preflight failed'
    Assert (-not (($script:calls -join "`n") -match '\|stop\||database\.ts\|reset\|')) 'Failed exact reset preflight drained the app.'
    $script:failure='initialize'
    Fails { Run-Deploy -DbReset } 'Simulated Docker failure'
    $operation=Get-Content -LiteralPath (Join-Path $context.State 'deployment-operation.json') -Raw|ConvertFrom-Json
    Assert ($operation.resetStatus -eq 'completed' -and (Test-Path -LiteralPath (Join-Path $context.State 'control/maintenance'))) 'Completed reset with initialization failure lost honest maintenance recovery evidence.'
    $script:failure=''
    $messages=Run-Deploy
    Assert (-not (($script:calls -join "`n") -match 'database\.ts\|reset\||backup.ts') -and
        ($script:calls -join "`n") -match 'database\.ts\|resume') 'Reset resume repeated destruction or failed to return to normal operation.'
    $messages=Run-Deploy -DbReset
    Assert (($messages -join "`n").Contains('ALREADY RUNNING') -and
        -not (($script:calls -join "`n") -match '\|stop\||database\.ts\|(reset|initialize)\|')) 'Verified pinned reset rerun repeated work.'
    $script:currentFingerprint='0'*64
    $context.ReadOnly=$true
    $unknownReport=Run-Deploy -DbReset
    $context.ExpectedPreflight=@($unknownReport | Where-Object { $_ -is [Collections.IDictionary] })[0].preflight
    $context.ReadOnly=$false
    $script:failure='database\.ts\|reset\|'
    Fails { Run-Deploy -DbReset } 'Simulated Docker failure'
    $operation=Get-Content -LiteralPath (Join-Path $context.State 'deployment-operation.json') -Raw|ConvertFrom-Json
    Assert ($operation.resetStatus -eq 'attempted' -and $context.DbResetStarted -and
        (Test-Path -LiteralPath (Join-Path $context.State 'control/maintenance'))) 'Unknown destructive failure was not honestly fenced.'
    $script:failure=''
    Fails { Run-Deploy -DbReset } 'Reset outcome is unknown'
    Assert (-not (($script:calls -join "`n") -match '\|stop\||database\.ts\|reset\|')) 'Unknown reset failure automatically repeated destructive work.'
    $pendingPath=Join-Path $context.State 'deployment-operation.json'
    $pendingHash=(Get-FileHash -LiteralPath $pendingPath).Hash
    foreach ($phase in @('drop','create','unknown')) {
        Fails { Resolve-LocalDeniedReset $context (@{event='database_operator_command';outcome='failed';code='database_reset_failed';phase=$phase}|ConvertTo-Json -Compress) } 'Only the original typed pre-DROP'
        Assert ((Get-FileHash -LiteralPath $pendingPath).Hash -ceq $pendingHash) 'Uncertain reset recovery changed its pending receipt.'
    }
    $denial=@{event='database_operator_command';outcome='failed';code='database_reset_denied';phase='validation'}|ConvertTo-Json -Compress
    $script:currentFingerprint='9'*64
    Fails { Resolve-LocalDeniedReset $context $denial } 'target changed: schema'
    $script:currentFingerprint='0'*64
    $recovery=Resolve-LocalDeniedReset $context $denial
    Assert ($recovery.outcome -ceq 'validation-denial-verified' -and -not $recovery.databaseReset -and
        $recovery.maintenanceRetained -and
        ([IO.File]::ReadAllText($pendingPath)|ConvertFrom-Json).resetStatus -ceq 'denied' -and
        (Get-FileHash -LiteralPath $recovery.archive).Hash -ceq $pendingHash -and
        (Test-Path -LiteralPath "$($recovery.archive).failure.json") -and
        (Test-Path -LiteralPath (Join-Path $context.State 'control/maintenance'))) 'Typed pre-DROP denial recovery lost its immutable evidence or reopened the application.'
    Write-LocalText (Join-Path $frozen.Root 'backend/input.ts') 'changed-frozen-source'
    Fails { Run-Deploy } 'Candidate source changed'
    Assert (-not (($script:calls -join "`n") -match '\|stop\||backend/scripts/database\.ts\|')) 'Tampered candidate reached production operations.'
    Write-Host "Passed $script:checks redesigned local-runtime assertions (mocked Docker; no deployment)."
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
