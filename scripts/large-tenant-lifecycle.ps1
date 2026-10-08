function Invoke-LargeTenantRuntimeFixture {
    param([string]$Root,[string]$Project,[string]$Directory,[string]$Suite,[string]$Baseline,[string]$BrowserFiles)
    if ($Project -cnotmatch '^agent-control-ltdp-[a-f0-9]{32}$' -or $Suite -notin @('browser','restart')) { throw 'Invalid lifecycle fixture scope.' }
    $browser = 'agent-control:permission-browser-test-phase06'
    $browserId = Invoke-DockerCommand @('image','inspect','--format','{{.Id}}',$browser) -Capture
    if ($browserId -cne 'sha256:b4eda044a9e58194703b1aa3e3209d3a7ea9cc219f9df14d36d418db873bb60b') { throw 'Protected browser identity changed.' }
    $architectures = @($Baseline,$browser | ForEach-Object { Invoke-DockerCommand @('image','inspect','--format','{{.Architecture}}',$_) -Capture })
    if (@($architectures | Select-Object -Unique).Count -ne 1) { throw 'Installed dependency and browser architectures differ.' }
    $images = @{}
    $targets = if ($Suite -eq 'restart') { @('qualification','runtime') } else { @('qualification','runtime','permission-browser-test') }
    foreach ($target in $targets) {
        $tag = "${Project}-${target}:local"
        Invoke-DockerCommand @('build','--network','none','--build-arg',"DEPENDENCY_BASE=$Baseline",
            '--build-arg',"BROWSER_BASE=$browser",'--build-arg','REUSE_INSTALLED_DEPENDENCIES=1','--target',$target,'-t',$tag,$Root)
        $images[$target] = @{tag=$tag;id=(Invoke-DockerCommand @('image','inspect','--format','{{.Id}}',$tag) -Capture)}
    }
    [IO.File]::WriteAllText((Join-Path $Directory 'images.json'),($images | ConvertTo-Json -Depth 4))
    $id = $Project -replace '^agent-control-ltdp-',''
    $control = "agentcontrol_test_${id}_control"
    $uid = (& id -u).Trim(); $gid = (& id -g).Trim()
    if ($uid -cnotmatch '^\d+$' -or $gid -cnotmatch '^\d+$') { throw 'A numeric owned fixture UID/GID is required.' }
    & chmod 700 $Directory
    foreach ($name in @('cache','home')) { [IO.Directory]::CreateDirectory((Join-Path $Directory $name)) | Out-Null }
    $composeFile = Join-Path $Directory 'lifecycle.yaml'
    [IO.File]::WriteAllText($composeFile,@"
services:
  test-postgres:
    image: postgres:17-bookworm
    mem_limit: 1024m
    cpus: 0.5
    environment:
      POSTGRES_USER: agentcontrol_admin
      POSTGRES_PASSWORD: isolated-fixture-admin-password-never-production-01
      POSTGRES_DB: $control
      PGDATA: /var/lib/postgresql/data/pgdata
    volumes:
      - large-tenant-data:/var/lib/postgresql/data
    networks: [fixture]
    command: [postgres, -c, shared_buffers=128MB, -c, work_mem=8MB, -c, maintenance_work_mem=64MB, -c, max_connections=20]
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U agentcontrol_admin -d $control']
      interval: 1s
      timeout: 3s
      retries: 90
  test-db:
    image: $($images.qualification.tag)
    mem_limit: 1536m
    cpus: 1.5
    networks: [fixture]
    environment:
      NODE_OPTIONS: --max-old-space-size=768
      NPM_CONFIG_REGISTRY: https://packagefeedproxy.microsoft.io/npm/
      PIP_INDEX_URL: https://packagefeedproxy.microsoft.io/pypi/simple
      PGHOST: test-postgres
      PGDATABASE: $control
      PGSSLMODE: disable
      AGENT_CONTROL_ISOLATED_TESTS: '1'
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
volumes:
  large-tenant-data:
networks:
  fixture:
    internal: true
"@)
    & chmod 600 $composeFile
    $compose = @('compose','--project-directory',$Root,'-f',$composeFile,'-p',$Project)
    $admin = @('-e','PGUSER=agentcontrol_admin','-e','PGPASSWORD=isolated-fixture-admin-password-never-production-01',
        '-e','APP_PGPASSWORD=isolated-fixture-password-never-production-01','-e','HOME=/evidence/home','-e','TMPDIR=/evidence/cache')
    $failures = [Collections.Generic.List[Exception]]::new()
    $started = $false
    try {
        $started = $true
        Invoke-DockerCommand ($compose + @('up','-d','--no-build','--wait','--wait-timeout','90','test-postgres'))
        $network = Invoke-DockerCommand @('network','inspect','--format','{{.Internal}}',"${Project}_fixture") -Capture
        if ($network -cne 'true') { throw 'Lifecycle fixture requires an internal network.' }
        foreach ($container in @(Get-OwnedFixtureContainers $Project)) {
            if ((Invoke-DockerCommand @('inspect','--format','{{json .HostConfig.PortBindings}}',$container) -Capture) -notin @('{}','null')) {
                throw 'Lifecycle fixture cannot publish a host port.'
            }
        }
        if ($Suite -eq 'browser') {
            $browserCompose = Join-Path $Directory 'browser.yaml'
            [IO.File]::WriteAllText($browserCompose,"services:`n  test-db:`n    image: $($images.'permission-browser-test'.tag)`n    working_dir: /app/backend`n")
            $runs = if ($BrowserFiles -ceq 'all') { @('all') } else { @('focused','all') }
            foreach ($run in $runs) {
                $args = $admin + @('-e','NODE_ENV=test','-e','AGENT_CONTROL_FIXTURE_MODE=browser',
                    '-e','PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001','-e',"PLAYWRIGHT_EVIDENCE_DIR=/evidence/$run")
                if ($run -eq 'focused') { $args += @('-e',"AGENT_CONTROL_BROWSER_TEST_FILES=$BrowserFiles") }
                try {
                    Invoke-OwnedFixtureWorkload -Compose ($compose + @('-f',$browserCompose)) -Project $Project -Directory $Directory `
                        -NameSuffix "browser-$run" -ExtraArgs $args -Command @('node','/app/node_modules/vitest/vitest.mjs','run','--config','scripts/browser-fixture.config.ts')
                } catch { $failures.Add($_.Exception) }
            }
        } else {
            $receipt = Join-Path $Directory 'restart-fixture.json'
            $seedCommand = @('node','node_modules/tsx/dist/cli.mjs','backend/scripts/restart-fixture.ts')
            Invoke-OwnedFixtureWorkload -Compose $compose -Project $Project -Directory $Directory -NameSuffix seed `
                -ExtraArgs ($admin + @('--user',"${uid}:${gid}")) -Command ($seedCommand + @('seed','/evidence/restart-fixture.json'))
            $saved = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
            if ($saved.database -cnotmatch '^agentcontrol_test_[a-z0-9_]+$' -or $saved.database -ceq $control) { throw 'Invalid receipt-selected child database.' }
            $runtimeCompose = Join-Path $Directory 'runtime.yaml'
            [IO.File]::WriteAllText($runtimeCompose,"services:`n  test-db:`n    image: $($images.runtime.tag)`n    read_only: true`n    working_dir: /app`n")
            $runtime = @('--user',"${uid}:${gid}",'-v',"${receipt}:/evidence/restart-fixture.json:ro",
                '-v',"$Root/backend/scripts/restart-runtime.mjs:/fixture.mjs:ro",
                '-v',"$Root/backend/scripts/officialReportFingerprint.ts:/app/backend/scripts/officialReportFingerprint.ts:ro",
                '-e','PGUSER=agentcontrol_app','-e','PGPASSWORD=isolated-fixture-password-never-production-01',
                '-e','SESSION_SECRET=synthetic-restart-session-secret-0000001',
                '-e','TENANTS_JSON=[{"tenantId":"11111111-1111-4111-8111-111111111111","clientId":"22222222-2222-4222-8222-222222222222","clientSecret":"synthetic-restart-client-secret","domains":["example.invalid"]}]',
                '-e','FRONTEND_ORIGIN=http://127.0.0.1:3001','-e','REDIRECT_URI=http://127.0.0.1:3001/api/auth/callback')
            Invoke-OwnedFixtureWorkload -Compose ($compose + @('-f',$runtimeCompose)) -Project $Project -Directory $Directory `
                -NameSuffix crash -ExpectedExit 17 -ExtraArgs $runtime -DirectEntrypoint node -Command @('/fixture.mjs','crash')
            $crashId = Invoke-DockerCommand @('inspect','--format','{{.Id}}',"$Project-crash") -Capture
            $logs = Get-RedactedFixtureLog $crashId '2000'
            if ($logs -notmatch '"event":"fixture_runtime_crash_after_dispatch"') { throw 'Exit 17 lacked the verified dispatch marker.' }
            Invoke-OwnedFixtureWorkload -Compose $compose -Project $Project -Directory $Directory -NameSuffix expire `
                -ExtraArgs ($admin + @('--user',"${uid}:${gid}")) -Command ($seedCommand + @('expire','/evidence/restart-fixture.json'))
            Invoke-OwnedFixtureWorkload -Compose ($compose + @('-f',$runtimeCompose)) -Project $Project -Directory $Directory `
                -NameSuffix recover -ExtraArgs $runtime -DirectEntrypoint node -Command @('/fixture.mjs','recover')
        }
    } catch { $failures.Add($_.Exception) }
    finally {
        if ($started) {
            try { Write-FixtureDiagnostics $Project $Directory -Final } catch { $failures.Add($_.Exception) }
            try {
                $tracked = @($control)
                $restartReceipt = Join-Path $Directory 'restart-fixture.json'
                if (Test-Path -LiteralPath $restartReceipt) { $tracked += (Get-Content -LiteralPath $restartReceipt -Raw | ConvertFrom-Json).database }
                $dropped = @()
                foreach ($database in $tracked | Select-Object -Unique) {
                    if ($database -cnotmatch '^agentcontrol_test_[a-z0-9_]+$') { throw 'Invalid tracked cleanup database.' }
                    $connections = Invoke-DockerCommand ($compose + @('exec','-T','test-postgres','psql','-U','agentcontrol_admin','-d','postgres',
                        '-Atc',"SELECT count(*) FROM pg_stat_activity WHERE datname='$database'")) -Capture
                    if ($connections -cne '0') { throw "Tracked database still has open connections: $database" }
                    Invoke-DockerCommand ($compose + @('exec','-T','test-postgres','psql','-U','agentcontrol_admin','-d','postgres',
                        '-v','ON_ERROR_STOP=1','-c',"DROP DATABASE IF EXISTS `"$database`""))
                    $remaining = Invoke-DockerCommand ($compose + @('exec','-T','test-postgres','psql','-U','agentcontrol_admin','-d','postgres',
                        '-Atc',"SELECT count(*) FROM pg_database WHERE datname='$database'")) -Capture
                    if ($remaining -cne '0') { throw "Tracked database cleanup was not verified: $database" }
                    $dropped += $database
                }
                [IO.File]::WriteAllText((Join-Path $Directory 'database-cleanup.json'),(@{dropped=$dropped;connections=0;remaining=0} | ConvertTo-Json))
            } catch { $failures.Add($_.Exception) }
            try { Remove-OwnedFixture $compose $Project $Directory } catch { $failures.Add($_.Exception) }
        }
        [IO.File]::WriteAllText((Join-Path $Directory 'result.json'),(@{suite=$Suite;project=$Project;controlDatabase=$control;
            failures=@($failures | ForEach-Object { $_.Message })} | ConvertTo-Json -Depth 5))
        Write-Host "Evidence: $Directory"
    }
    if ($failures.Count) { throw [AggregateException]::new('Lifecycle runtime fixture failed.',$failures) }
}
