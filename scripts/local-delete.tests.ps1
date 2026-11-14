#requires -Version 7.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
$repository = Split-Path $PSScriptRoot -Parent
$root = Join-Path $repository "artifacts/test-scratch/delete-$([Guid]::NewGuid().ToString('N'))"
$script:checks = 0
$script:calls = [Collections.Generic.List[string]]::new()
$script:answers = [Collections.Generic.Queue[string]]::new()
$script:prompts = 0
$script:failure = ''
function Assert($Condition,[string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
}
function Fails([scriptblock]$Action,[string]$Pattern) {
    try { & $Action; throw 'Expected failure did not occur.' }
    catch { Assert ($_.Exception.Message -match $Pattern) "Unexpected failure: $($_.Exception.Message)" }
}
function Get-Command {
    param([string]$Name,$ErrorAction)
    if ($Name -eq 'docker') { return @{Name='docker'} }
    Microsoft.PowerShell.Core\Get-Command $Name -ErrorAction $ErrorAction
}
function Read-Host {
    param([string]$Prompt)
    $script:prompts++
    if (-not $script:answers.Count) { throw "Unexpected confirmation prompt: $Prompt" }
    return $script:answers.Dequeue()
}
function New-DeleteFixture {
    param([string]$Name)
    $directory = Join-Path $root $Name
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $context = New-LocalContext $directory 'agent-control' -SkipSettings
    foreach ($path in @('secrets','backups')) { [IO.Directory]::CreateDirectory((Join-Path $context.State $path)) | Out-Null }
    Write-LocalText (Join-Path $context.State 'settings.json') '{"incomplete":'
    Write-LocalText (Join-Path $context.State 'secrets/postgres-admin') 'synthetic-protected-secret'
    Write-LocalText (Join-Path $context.State 'backups/retained.dump') 'synthetic-backup'
    [IO.Directory]::CreateDirectory((Join-Path $directory '.local/seha')) | Out-Null
    Write-LocalText (Join-Path $directory '.local/seha/sentinel') 'keep-another-project'
    $script:containers = @{}
    $script:volumes = @{}
    $script:networks = @{}
    $private = @{
        Name=$context.Network;Id=('e'*64);Driver='bridge';Scope='local';Containers=@{}
        Labels=@{'com.docker.compose.project'=$context.Project;'com.docker.compose.network'='default'}
    }
    $script:networks[$context.Network] = $private
    $script:networks['agent-control-ingress'] = @{
        Name='agent-control-ingress';Id=('f'*64);Driver='bridge';Scope='local';Containers=@{}
        Labels=@{'io.shared-proxy.managed'='true'}
    }
    $index = 0
    foreach ($service in @('app','postgres','mcp')) {
        $id = [string]([char]([int][char]'a'+$index)) * 64
        $index++
        $mounts = if ($service -eq 'postgres') { @($context.Volume) }
            elseif ($service -eq 'mcp') { @($context.McpVolume,$context.McpRecordingVolume) } else { @() }
        $script:containers[$id] = @{
            Labels=@{'com.docker.compose.project'=$context.Project;'com.docker.compose.project.working_dir'=$directory;'com.docker.compose.service'=$service}
            State=@{Running=$true};Mounts=$mounts;Networks=@($context.Network)
        }
        $private.Containers[$id] = @{}
    }
    foreach ($logical in @('data','mcp-oauth','mcp-recordings')) {
        $name = "$($context.Project)_$logical"
        $script:volumes[$name] = @{Name=$name;Driver='local'
            Labels=@{'com.docker.compose.project'=$context.Project;'com.docker.compose.volume'=$logical}}
    }
    $script:containers[('d'*64)] = @{
        Labels=@{'com.docker.compose.project'='seha';'com.docker.compose.project.working_dir'=$directory;'com.docker.compose.service'='app'}
        State=@{Running=$true};Mounts=@('seha_data');Networks=@('agent-control-ingress')
    }
    $script:volumes['seha_data'] = @{Name='seha_data';Driver='local';Labels=@{'com.docker.compose.project'='seha'}}
    $script:calls.Clear(); $script:answers.Clear(); $script:prompts=0; $script:failure=''
    return $context
}
function docker {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
    $global:LASTEXITCODE = 0
    $line = $Arguments -join '|'
    $script:calls.Add($line)
    if ($script:failure -and $line -match $script:failure) { throw 'Synthetic project deletion failure.' }
    switch ($Arguments[0]) {
        'info' { return '29.7.2' }
        'compose' {
            if ($Arguments[1] -eq 'version') { return '2.30.0' }
        }
        'ps' {
            $filter = $Arguments[-1]
            $matches = if ($filter.StartsWith('volume=')) {
                @($script:containers.Keys | Where-Object { $filter.Substring(7) -cin $script:containers[$_].Mounts })
            } elseif ($filter.StartsWith('network=')) {
                @($script:containers.Keys | Where-Object { $filter.Substring(8) -cin $script:containers[$_].Networks })
            } else {
                @($script:containers.Keys | Where-Object { $script:containers[$_].Labels.'com.docker.compose.project' -ceq ($filter -split '=')[-1] })
            }
            return $matches -join "`n"
        }
        'inspect' {
            $container = $script:containers[$Arguments[-1]]
            if (-not $container) { throw 'Unknown deletion fixture container.' }
            switch ($Arguments[2]) {
                '{{json .Config.Labels}}' { return $container.Labels | ConvertTo-Json -Compress }
                '{{json .State}}' { return $container.State | ConvertTo-Json -Compress }
                '{{.Image}}' { return ('sha256:' + ('1'*64)) }
            }
        }
        'stop' { $script:containers[$Arguments[-1]].State.Running=$false; return }
        'rm' {
            $id = $Arguments[-1]
            if ($script:containers[$id].State.Running) { throw 'A running container was removed without stopping it.' }
            $script:containers.Remove($id)
            foreach ($network in $script:networks.Values) { $network.Containers.Remove($id) }
            return
        }
        'volume' {
            switch ($Arguments[1]) {
                'ls' { return $script:volumes.Keys -join "`n" }
                'inspect' { return $script:volumes[$Arguments[-1]] | ConvertTo-Json -Depth 5 -Compress }
                'rm' {
                    if (@($script:containers.Values | Where-Object { $Arguments[-1] -cin $_.Mounts }).Count) { throw 'A volume was removed with consumers attached.' }
                    $script:volumes.Remove($Arguments[-1])
                    return
                }
            }
        }
        'network' {
            switch ($Arguments[1]) {
                'ls' { return $script:networks.Keys -join "`n" }
                'inspect' { return $script:networks[$Arguments[-1]] | ConvertTo-Json -Depth 5 -Compress }
                'rm' {
                    $name = @($script:networks.Keys | Where-Object { $script:networks[$_].Id -ceq $Arguments[-1] })[0]
                    if (-not $name -or $script:networks[$name].Containers.Count) { throw 'Unknown network or attached consumers during deletion.' }
                    $script:networks.Remove($name)
                    return
                }
            }
        }
    }
    throw "Unexpected Docker operation during deletion: $line"
}
function Assert-NoDeletion {
    param($Context)
    Assert (-not @($script:calls | Where-Object { $_ -match '^(stop|rm)\||^(volume|network)\|rm\|' }).Count) 'Deletion changed Docker before ownership/confirmation succeeded.'
    Assert (Test-Path -LiteralPath (Join-Path $Context.State 'secrets/postgres-admin')) 'Refused deletion changed protected saved state.'
    Assert (-not $Context.ProjectDeleteStarted) 'Refused deletion was reported as having started.'
}
try {
    $context = New-DeleteFixture 'confirmed'
    [IO.Directory]::CreateDirectory((Join-Path $context.Root 'scripts')) | Out-Null
    Copy-Item -LiteralPath (Join-Path $repository 'deploy-local.ps1') -Destination $context.Root
    foreach ($file in @('local-deployment.ps1','tenant-deployment.ps1','fixture-diagnostics.ps1','local-runtime.ps1','local-mcp.ps1','local-proxy.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $context.Root 'scripts')
    }
    $script:answers.Enqueue($context.Project)
    & { . (Join-Path $context.Root 'deploy-local.ps1') delete -Project agent-control } 3>$null 6>$null
    Assert (-not (Test-Path -LiteralPath $context.State)) 'Confirmed deletion did not remove saved secrets, settings and backups.'
    Assert ($script:containers.Count -eq 1 -and $script:containers.ContainsKey(('d'*64)) -and
        $script:containers[('d'*64)].State.Running) 'Confirmed deletion removed or stopped another project.'
    Assert ($script:volumes.Count -eq 1 -and $script:volumes.ContainsKey('seha_data')) 'Confirmed deletion missed database/MCP volumes or removed another project volume.'
    Assert ($script:networks.Count -eq 1 -and $script:networks.ContainsKey('agent-control-ingress')) 'Deletion did not retain the shared ingress network.'
    Assert ([IO.File]::ReadAllText((Join-Path $context.Root '.local/seha/sentinel')) -ceq 'keep-another-project') 'Deletion touched sibling project state.'
    Assert ($script:prompts -eq 1 -and -not @($script:calls | Where-Object { $_ -match '^build\||^run\||--force|--volumes|^image\|' }).Count) 'Deletion built software, exposed secrets or used broad Docker cleanup.'
    $context = New-LocalContext $context.Root $context.Project -SkipSettings
    $messages = @(Invoke-LocalDeployment $context Delete 6>&1)
    Assert ($script:prompts -eq 1 -and ($messages -join "`n").Contains('no remaining')) 'Deleting an already absent project was not safely idempotent.'

    foreach ($answer in @('','seha','AGENT-CONTROL')) {
        $context = New-DeleteFixture "cancel-$($script:checks)"
        $script:answers.Enqueue($answer)
        Fails { Invoke-LocalDeployment $context Delete 3>$null 6>$null } 'deletion cancelled'
        Assert-NoDeletion $context
    }
    foreach ($resource in @('container','volume','network')) {
        $context = New-DeleteFixture "foreign-$resource"
        switch ($resource) {
            'container' { $script:containers[('a'*64)].Labels.'com.docker.compose.project.working_dir'='/another/installation' }
            'volume' { $script:volumes[$context.Volume].Labels.'com.docker.compose.project'='foreign' }
            'network' { $script:networks[$context.Network].Labels.'io.shared-proxy.managed'='true' }
        }
        Fails { Invoke-LocalDeployment $context Delete 3>$null 6>$null } 'ownership mismatch'
        Assert-NoDeletion $context
        Assert ($script:prompts -eq 0) 'Foreign ownership was not rejected before confirmation.'
    }
    foreach ($resource in @('volume','network','stopped-network')) {
        $context = New-DeleteFixture "consumer-$resource"
        if ($resource -eq 'volume') { $script:containers[('d'*64)].Mounts += $context.Volume }
        elseif ($resource -eq 'network') { $script:networks[$context.Network].Containers[('d'*64)]=@{} }
        else {
            $script:containers[('d'*64)].State.Running=$false
            $script:containers[('d'*64)].Networks += $context.Network
        }
        Fails { Invoke-LocalDeployment $context Delete 3>$null 6>$null } 'foreign container'
        Assert-NoDeletion $context
    }
    if (-not $IsWindows) {
        $context = New-DeleteFixture 'symbolic-state'
        $sentinel = Join-Path $context.Root '.local/seha/sentinel'
        [IO.File]::CreateSymbolicLink((Join-Path $context.State 'linked-sentinel'),$sentinel) | Out-Null
        Fails { Invoke-LocalDeployment $context Delete 3>$null 6>$null } 'Symbolic paths'
        Assert-NoDeletion $context
        Assert ([IO.File]::ReadAllText($sentinel) -ceq 'keep-another-project') 'Symlink validation touched an external target.'
    }
    $context = New-DeleteFixture 'partial-failure'
    $script:answers.Enqueue($context.Project)
    $script:failure='^network\|rm\|'
    Fails { Invoke-LocalDeployment $context Delete 3>$null 6>$null } 'Synthetic project deletion failure'
    Assert ($context.ProjectDeleteStarted -and (Test-Path -LiteralPath $context.State)) 'Partial failure lost saved recovery state or was reported as no deletion.'
    $script:failure=''
    $script:answers.Enqueue($context.Project)
    $context = New-LocalContext $context.Root $context.Project -SkipSettings
    Invoke-LocalDeployment $context Delete 3>$null 6>$null
    Assert (-not (Test-Path -LiteralPath $context.State) -and $script:networks.ContainsKey('agent-control-ingress')) 'A partial deletion could not resume without affecting shared infrastructure.'
    Write-Host "Passed $script:checks project-deletion assertions (mocked Docker; scratch project state only)."
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
