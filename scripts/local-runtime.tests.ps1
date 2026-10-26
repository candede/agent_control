#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
$repository = Split-Path $PSScriptRoot -Parent
$root = Join-Path $repository "artifacts/test-scratch/runtime-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory((Join-Path $root 'backend')) | Out-Null
foreach ($file in @('Dockerfile','.dockerignore','compose.yaml','compose.large-tenant-test.yaml')) {
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
$script:answers = [Collections.Generic.Queue[string]]::new()
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
    return ((@('Dockerfile','.dockerignore','compose.yaml','compose.large-tenant-test.yaml','backend/input.ts','backend/.env.synthetic') + $script:candidateInputs) -join "`0") + "`0"
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
        return
    }
    if ($Arguments[0] -eq 'ps') { return ($script:containers.Keys -join "`n") }
    if ($Arguments[0] -eq 'inspect') {
        $container = $script:containers[$Arguments[-1]]
        switch ($Arguments[2]) {
            '{{json .Config.Labels}}' { return (@{'com.docker.compose.project'=$context.Project;'com.docker.compose.project.working_dir'=$(if ($script:wrongOwner) {'/different-checkout'} else {$root});'com.docker.compose.service'=$container.service} | ConvertTo-Json -Compress) }
            '{{json .State}}' { return (@{Running=$container.running;Health=@{Status='healthy'}} | ConvertTo-Json -Compress) }
            '{{.Image}}' { return $container.image }
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
        if ($Arguments -contains 'stop') { $script:containers[('a' * 64)].running=$false; return }
        if ($Arguments -contains 'up') {
            $service = $Arguments[-1]
            $id = if ($service -eq 'app') {'a' * 64} else {'b' * 64}
            $script:containers[$id]=@{service=$service;running=$true;image=$(if ($service -eq 'app') {$script:runtime} else {'sha256:' + ('d' * 64)})}
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
    $context = New-LocalContext $root 'runtime-test'
    & {
        $gitPath = (Microsoft.PowerShell.Core\Get-Command git -CommandType Application).Source
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
    foreach ($value in @('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','synthetic-runtime-test-client-secret','example.invalid','14399')) { $script:answers.Enqueue($value) }
    $script:mutateSource=$true
    $messages=Run-Deploy
    $script:mutateSource=$false
    Assert ($script:checked -eq 0 -and -not (($script:calls -join "`n") -match 'test-postgres|test-all|qualification')) 'Normal start still ran regression validation.'
    Assert (@($script:calls | Where-Object { $_ -match '^build\|' }).Count -eq 2) 'Normal start did not build exactly the operator and runtime.'
    $preflight = $script:calls.FindIndex([Predicate[string]]{param($line) $line -match 'database\.ts\|preflight$'})
    $runtimeBuild = $script:calls.FindIndex([Predicate[string]]{param($line) $line -match '\|--target\|runtime\|'})
    Assert ($preflight -lt $runtimeBuild) 'Database compatibility was not checked before runtime compilation.'
    Assert (($script:calls -join "`n") -match '\|--no-recreate\|--wait\|') 'Preflight could recreate PostgreSQL before draining the application.'
    Assert (Test-Path -LiteralPath (Join-Path $context.State 'deployment.json')) 'Successful deployment did not record its identity.'
    Assert ($script:operationalMode -eq 'normal' -and ($script:calls -join "`n") -match 'database\.ts\|resume') 'Normal deployment blocked automatic first sync.'
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $root 'artifacts/local-builds')).Count -eq 0) 'Source snapshot was not removed.'
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
    $script:candidateInputs=@('deploy-local.ps1','scripts/local-deployment.ps1','scripts/local-runtime.ps1','scripts/local-mcp.ps1','backend/scripts/database.ts')
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
    $messages=Run-Deploy -DbReset
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
    Write-LocalText (Join-Path $frozen.Root 'backend/input.ts') 'changed-frozen-source'
    Fails { Run-Deploy } 'Candidate source changed'
    Assert (-not (($script:calls -join "`n") -match '\|stop\||backend/scripts/database\.ts\|')) 'Tampered candidate reached production operations.'
    Write-Host "Passed $script:checks redesigned local-runtime assertions (mocked Docker; no deployment)."
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
