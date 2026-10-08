function ConvertTo-RedactedFixtureLog {
    param([string]$Text)
    $Text = $Text -replace '(?im)((?:password|secret|token)["'']?\s*[:=]\s*["'']?)\S+','$1[redacted]'
    $Text = $Text -replace '(?im)(authorization["'']?\s*[:=]\s*["'']?)(?:Bearer\s+)?\S+','$1[redacted]'
    $Text = $Text -replace '(?i)(PASSWORD\s+)''[^'']*''','$1[redacted]'
    return ($Text -replace 'isolated-fixture(?:-admin)?-password-never-production-01','[redacted]')
}

function Get-RedactedFixtureLog {
    param([string]$Id,[string]$Tail)
    return ConvertTo-RedactedFixtureLog (Invoke-DockerCommand @('logs','--tail',$Tail,$Id) -Capture -CaptureError)
}

function Get-FixtureFailureMessages {
    param([Exception]$Exception)
    if ($null -eq $Exception) { return }
    if ($Exception -is [AggregateException]) {
        $Exception.Flatten().InnerExceptions | ForEach-Object { $_.Message }
    } else { $Exception.Message }
}

function Get-OwnedFixtureContainers {
    param([string]$Project)
    if ($Project -cnotmatch '^agent-control-(?:check|ltdp)-[a-f0-9]{32}$') { throw 'Invalid disposable project identity.' }
    $ids = Invoke-DockerCommand @('ps','-aq','--no-trunc','--filter',"label=com.docker.compose.project=$Project") -Capture
    foreach ($id in ($ids -split "`n" | Where-Object { $_ })) {
        $label = Invoke-DockerCommand @('inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',$id) -Capture
        if ($label -cne $Project -or $id -cnotmatch '^[a-f0-9]{12,64}$') { throw 'Disposable container ownership mismatch.' }
        $id
    }
}

function Get-OwnedFixtureMounts {
    param([string]$Project,[string]$Id,[string]$Service,[string]$Directory)
    if ($Service -notin @('test-db','test-postgres')) { throw 'Unexpected service in disposable project; cleanup refused.' }
    if ([string]::IsNullOrWhiteSpace($Directory) -or (Split-Path $Directory -Leaf) -cne ($Project -replace '^agent-control-(?:check|ltdp)-','')) {
        throw 'Exact disposable evidence directory is required.'
    }
    $mounts = @(Invoke-DockerCommand @('inspect','--format','{{json .Mounts}}',$Id) -Capture | ConvertFrom-Json)
    foreach ($mount in $mounts) {
        if ($Service -eq 'test-postgres' -and $mount.Type -eq 'volume' -and
            $mount.Destination -ceq '/var/lib/postgresql/data' -and $mount.Name -ceq "${Project}_large-tenant-data") { continue }
        if ($Service -eq 'test-db' -and $mount.Type -eq 'bind' -and $mount.Destination -ceq '/evidence' -and
            [IO.Path]::GetFullPath($mount.Source) -ceq [IO.Path]::GetFullPath($Directory)) { continue }
        if ($Service -eq 'test-db' -and $mount.Type -eq 'bind' -and -not $mount.RW) {
            $expected = if ($mount.Destination -ceq '/evidence/restart-fixture.json') { Join-Path $Directory 'restart-fixture.json' }
                elseif ($mount.Destination -ceq '/fixture.mjs') { Join-Path (Split-Path $PSScriptRoot -Parent) 'backend/scripts/restart-runtime.mjs' }
                elseif ($mount.Destination -ceq '/app/backend/scripts/officialReportFingerprint.ts') {
                    Join-Path (Split-Path $PSScriptRoot -Parent) 'backend/scripts/officialReportFingerprint.ts'
                }
                else { $null }
            if ($expected -and [IO.Path]::GetFullPath($mount.Source) -ceq [IO.Path]::GetFullPath($expected)) { continue }
        }
        if ($Service -eq 'test-db' -and $mount.Type -eq 'volume' -and $mount.Destination -ceq '/var/lib/postgresql/data' -and
            $mount.Name -cmatch '^[a-f0-9]{64}$') {
            $labels = Invoke-DockerCommand @('volume','inspect','--format','{{json .Labels}}',$mount.Name) -Capture | ConvertFrom-Json
            $users = @(Invoke-DockerCommand @('ps','-aq','--no-trunc','--filter',"volume=$($mount.Name)") -Capture |
                ForEach-Object { $_ -split "`n" } | Where-Object { $_ })
            if ($labels.PSObject.Properties.Name -contains 'com.docker.volume.anonymous' -and $users.Count -eq 1 -and $users[0] -ceq $Id) { continue }
        }
        throw 'Unexpected mount in disposable fixture; cleanup refused.'
    }
    if ($Service -eq 'test-postgres' -and $mounts.Count -ne 1) { throw 'Disposable PostgreSQL requires its exact owned disk-backed volume.' }
    return $mounts
}

function Write-FixtureProgress {
    param([string]$Logs,[hashtable]$State)
    $lines = @(($Logs -split '\r?\n') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($line in $lines) {
        if ($line -match '^\[AUTOMATED CHECKS(?: \d+/\d+)?\]' -and $State.Phases.Add($line)) {
            Write-Host $line
        }
    }
    $preview = (@($lines | Where-Object { $_ -notmatch '^\[AUTOMATED CHECKS|^Command:|^\s*\{|^[A-Z_]+\s+\{' } |
        Select-Object -Last 3) -join "`n")
    if ($preview -and $preview -cne $State.Preview) {
        foreach ($line in ($preview -split "`n")) {
            $display = if ($line.Length -gt 300) { $line.Substring(0,300) + ' ... [truncated]' } else { $line }
            Write-Host "[FIXTURE LOG] $display"
        }
    }
    $State.Preview = $preview
}

function Write-FixtureDiagnostics {
    param([string]$Project,[string]$Directory,[switch]$Final,[string]$ProgressId,[hashtable]$ProgressState)
    [IO.Directory]::CreateDirectory($Directory) | Out-Null
    $errors = [Collections.Generic.List[Exception]]::new()
    $containers = @(Get-OwnedFixtureContainers $Project)
    [IO.File]::AppendAllText((Join-Path $Directory 'capture.jsonl'),
        ((@{project=$Project;at=[DateTime]::UtcNow.ToString('o');final=[bool]$Final;containers=$containers;unavailable=($containers.Count -eq 0)} | ConvertTo-Json -Compress) + "`n"))
    foreach ($id in $containers) {
        try {
            # Never persist Config.Env, secret mounts' contents, or the complete inspect response.
            $service = Invoke-DockerCommand @('inspect','--format','{{index .Config.Labels "com.docker.compose.service"}}',$id) -Capture
            $mounts = @(Get-OwnedFixtureMounts $Project $id $service $Directory)
            [IO.File]::WriteAllText((Join-Path $Directory "$id-mounts.json"),(ConvertTo-Json -InputObject $mounts -Depth 5))
            $state = Invoke-DockerCommand @('inspect','--format','{{json .State}}',$id) -Capture
            [IO.File]::AppendAllText((Join-Path $Directory "$id-state.jsonl"),"$state`n")
            $running = ($state | ConvertFrom-Json).Running
            $counters = if ($running) {
                try {
                    Invoke-DockerCommand @('exec',$id,'sh','-c',
                        'for f in memory.current memory.peak memory.max memory.events memory.stat cpu.max cpu.stat; do printf "%s\n" "$f"; if [ -r "/sys/fs/cgroup/$f" ]; then cat "/sys/fs/cgroup/$f"; else printf "unavailable\n"; fi; done') -Capture
                } catch {
                    $latest = (Invoke-DockerCommand @('inspect','--format','{{json .State}}',$id) -Capture) | ConvertFrom-Json
                    if ($latest.Running) { throw }
                    'unavailable: container exited between inspect and cgroup sampling'
                }
            } else { 'unavailable: container stopped; use preceding live samples' }
            [IO.File]::AppendAllText((Join-Path $Directory "$id-cgroup.log"),"$([DateTime]::UtcNow.ToString('o'))`n$counters`n")
        } catch { $errors.Add($_.Exception) }
        try {
            $logs = Get-RedactedFixtureLog $id 'all'
            [IO.File]::WriteAllText((Join-Path $Directory "$id.log"),$logs)
            if ($id -ceq $ProgressId) {
                Write-FixtureProgress $logs $ProgressState
            }
        } catch { $errors.Add($_.Exception) }
    }
    if ($errors.Count) { throw [AggregateException]::new('Fixture diagnostic capture failed.',$errors) }
}

function Invoke-OwnedFixtureWorkload {
    param([string[]]$Compose,[string]$Project,[string]$Directory,[string[]]$Command,
        [string]$NameSuffix='work',[int]$ExpectedExit=0,[string[]]$ExtraArgs=@(),[string]$DirectEntrypoint,
        [ValidateRange(1,86400)][int]$TimeoutSeconds=1800)
    if ($NameSuffix -cnotmatch '^[a-z][a-z0-9-]{0,31}$' -or $ExpectedExit -notin @(0,17)) { throw 'Invalid owned workload identity or expected exit.' }
    $name = "$Project-$NameSuffix"
    $failures = [Collections.Generic.List[Exception]]::new()
    $start = Join-Path $Directory 'start'
    if (Test-Path -LiteralPath $start) { Remove-Item -LiteralPath $start }
    $arguments = $Compose + @('run','-d','--no-deps','--name',$name) + $ExtraArgs
    $arguments += if ($DirectEntrypoint) { @('--entrypoint',$DirectEntrypoint,'test-db') }
        else { @('-v',"${Directory}:/evidence",'--entrypoint','sh','test-db','-c',
            'while [ ! -f /evidence/start ]; do sleep 0.1; done; exec "$@"','fixture') }
    $id = Invoke-DockerCommand ($arguments + $Command) -Capture
    $id = ($id -split "`n")[-1].Trim()
    if ($id -notin @(Get-OwnedFixtureContainers $Project)) { throw 'Workload container identity mismatch.' }
    $budget = '{0:00}:{1:00}' -f [Math]::Floor($TimeoutSeconds / 60),($TimeoutSeconds % 60)
    Write-Host "[FIXTURE] Monitoring $name (deadline $budget). Redacted diagnostics: $Directory"
    # Capture while both services are alive, before allowing the workload to allocate.
    try { Write-FixtureDiagnostics $Project $Directory } catch { $failures.Add($_.Exception) }
    [IO.File]::WriteAllText($start,'start')
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $nextProgress = 0
    $progress = @{ Phases = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal); Preview = '' }
    try {
        while ($true) {
            $state = (Invoke-DockerCommand @('inspect','--format','{{json .State}}',$id) -Capture) | ConvertFrom-Json
            if (-not $state.Running) { break }
            if ($clock.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw "Fixture workload exceeded the $budget deadline." }
            if ($clock.Elapsed.TotalSeconds -ge $nextProgress) {
                $elapsed = '{0:00}:{1:00}' -f [Math]::Floor($clock.Elapsed.TotalMinutes),$clock.Elapsed.Seconds
                Write-Host "[FIXTURE] $name is still running; elapsed $elapsed / $budget."
                try { Write-FixtureDiagnostics $Project $Directory -ProgressId $id -ProgressState $progress } catch { $failures.Add($_.Exception) }
                $nextProgress = $clock.Elapsed.TotalSeconds + 15
            }
            Start-Sleep -Milliseconds 1000
        }
        if ($state.ExitCode -ne $ExpectedExit -or $state.OOMKilled) { throw "Fixture workload failed: exit=$($state.ExitCode), OOMKilled=$($state.OOMKilled)." }
    } catch { $failures.Add($_.Exception) }
    $clock.Stop()
    try { Write-FixtureDiagnostics $Project $Directory -Final -ProgressId $id -ProgressState $progress } catch { $failures.Add($_.Exception) }
    if ($failures.Count) {
        throw [AggregateException]::new('Fixture workload or live capture failed.',$failures)
    }
}

function Remove-OwnedFixture {
    param([string[]]$Compose,[string]$Project,[string]$Directory)
    $ids = @(Get-OwnedFixtureContainers $Project)
    # Verify the complete exact project boundary before any destructive command.
    foreach ($id in $ids) {
        $service = Invoke-DockerCommand @('inspect','--format','{{index .Config.Labels "com.docker.compose.service"}}',$id) -Capture
        $null = @(Get-OwnedFixtureMounts $Project $id $service $Directory)
    }
    $volumes = Invoke-DockerCommand @('volume','ls','-q','--filter',"label=com.docker.compose.project=$Project") -Capture
    foreach ($volume in ($volumes -split "`n" | Where-Object { $_ })) {
        $label = Invoke-DockerCommand @('volume','inspect','--format','{{index .Labels "com.docker.compose.project"}}',$volume) -Capture
        if ($label -cne $Project -or -not $volume.StartsWith("${Project}_")) { throw 'Disposable volume ownership mismatch.' }
    }
    $errors = [Collections.Generic.List[Exception]]::new()
    foreach ($id in $ids) {
        try {
            $service = Invoke-DockerCommand @('inspect','--format','{{index .Config.Labels "com.docker.compose.service"}}',$id) -Capture
            if ($service -eq 'test-db') { Invoke-DockerCommand @('rm','-f','-v',$id) }
        } catch { $errors.Add($_.Exception) }
    }
    try { Invoke-DockerCommand ($Compose + @('down','--volumes','--remove-orphans')) }
    catch { $errors.Add($_.Exception) }
    if ($errors.Count) { throw [AggregateException]::new('Owned fixture cleanup failed.',$errors) }
}
