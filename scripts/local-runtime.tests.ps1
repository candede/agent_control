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
$script:enumerations = 0
$script:wrongOwner = $false
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
    Assert ($args -contains 'docs' -and $args -notcontains 'plans' -and $args -notcontains 'plans/admin-poc-production/README.md') 'Source inventory must use current documentation, not historical plans.'
    $script:enumerations++
    if ($script:changeDuringCapture -and $script:enumerations -eq 2) {
        [IO.File]::WriteAllText((Join-Path $root 'backend/input.ts'),'changed-during-capture')
    }
    return (@('Dockerfile','.dockerignore','compose.yaml','compose.large-tenant-test.yaml','backend/input.ts','backend/.env.synthetic') -join "`0") + "`0"
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
    if ($Arguments[0] -eq 'build') {
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
        if ($Arguments[-1] -eq 'preflight') {
            if ($script:preflightOverride) { return $script:preflightOverride }
            if ($script:currentFingerprint -and $script:currentFingerprint -cne $script:targetFingerprint) {
                throw 'database_schema_reset_required: explicit -DbReset is required.'
            }
            return (@{state=$(if ($script:currentFingerprint) {'current'} else {'fresh'});currentFingerprint=$script:currentFingerprint;targetFingerprint=$script:targetFingerprint} | ConvertTo-Json -Compress)
        }
        if ($Arguments -contains 'preflight-reset') { return '{"outcome":"succeeded"}' }
        if ($Arguments[-1] -eq 'initialize') { $script:currentFingerprint=$script:targetFingerprint }
        if ($Arguments -contains 'reset') { $script:currentFingerprint=$null }
        return
    }
    if ($Arguments[0] -eq 'compose') {
        if ($Arguments -contains 'stop') { $script:containers[('a' * 64)].running=$false; return }
        if ($Arguments -contains 'up') {
            $service = $Arguments[-1]
            $id = if ($service -eq 'app') {'a' * 64} else {'b' * 64}
            $script:containers[$id]=@{service=$service;running=$true;image=$(if ($service -eq 'app') {$script:runtime} else {'sha256:' + ('d' * 64)})}
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
    Assert (@(Get-ChildItem -LiteralPath (Join-Path $root 'artifacts/local-builds')).Count -eq 0) 'Source snapshot was not removed.'
    $receipt=(Get-FileHash -LiteralPath (Join-Path $context.State 'deployment.json')).Hash
    $health=$script:healthCalls
    $messages=Run-Deploy
    Assert (($messages -join "`n").Contains('ALREADY RUNNING')) 'Unchanged healthy start was not a no-op.'
    Assert ($script:healthCalls -eq $health+1) 'No-op skipped fresh host readiness.'
    Assert (-not (($script:calls -join "`n") -match '(?m)\|stop\||database\.ts\|initialize$|\|90\|app$')) 'No-op restarted the app or initialized the database.'
    Assert ((Get-FileHash -LiteralPath (Join-Path $context.State 'deployment.json')).Hash -ceq $receipt) 'No-op rewrote its deployment identity.'
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
    Assert (($script:calls -join "`n") -match '(?m)database\.ts\|initialize$' -and -not (($script:calls -join "`n") -match 'backup\.ts|pg_dump')) 'Explicit reset did not initialize directly without a pre-reset backup.'
    $script:failure='database\.ts\|initialize$'
    Fails { Run-Deploy -DbReset 3>$null } 'Simulated Docker failure'
    $initializing=Join-Path $context.State 'control/database-initializing'
    Assert (Test-Path -LiteralPath $initializing) 'Failed database initialization lost its repair marker.'
    $script:failure=''
    $script:currentFingerprint=$script:targetFingerprint
    $messages=Run-Deploy
    Assert (($script:calls -join "`n") -match '(?m)database\.ts\|initialize$' -and -not (($script:calls -join "`n") -match 'database\.ts\|reset\|')) 'Retry skipped failed grants because fingerprints matched, or repeated a destructive reset without authorization.'
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
        foreach ($operation in @('Deploy','Stop','EditConfig','Reset','Backup')) {
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
    Write-Host "Passed $script:checks redesigned local-runtime assertions (mocked Docker; no deployment)."
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
