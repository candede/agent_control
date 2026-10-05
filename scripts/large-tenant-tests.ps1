#requires -Version 7.0
param([Parameter(Mandatory)][string]$Suite, [string]$BrowserFiles = 'reportSets.spec.ts')
$ErrorActionPreference = 'Stop'
$profile = $Suite -eq 'cutover-report-profile'
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
$root = Split-Path $PSScriptRoot -Parent
if ($Suite -in @('capacity-focused','capacity-core')) {
    & python3 -B (Join-Path $PSScriptRoot 'capacity-results.test.py')
    if ($LASTEXITCODE -ne 0) { throw 'Capacity parser/resource-model regression failed.' }
}
if ($Suite -in @('capacity','capacity-query','capacity-probe')) {
    $mode = if ($Suite -eq 'capacity') { 'full' } elseif ($Suite -eq 'capacity-query') { 'query' } else { 'probe' }
    & python3 (Join-Path $PSScriptRoot 'large-tenant-capacity.py') --mode $mode
    exit $LASTEXITCODE
}
$implemented = @('inventory-registry','inventory-native-source','inventory-control-integration','inventory-refresh-services','inventory-exports','inventory-metadata','inventory-lifecycle','inventory-details','cutover-native-views','cutover-overview-contract','cutover-history-contract','cutover-native-authority','cutover-user-protocol','cutover-http-lifecycle','cutover-automatic-contract','cutover-agent-usage','cutover-runtime-contract','cutover-ui-contract','cutover-source-activation','cutover-types','cutover-app-contract','cutover-people-fences','cutover-browser-contract','cutover-browser-ui-contract','cutover-capability-admission','cutover-retention-contract','users-reports-cutover','data-page-contract','official-reports-foundation','user-sources-foundation','selected-reads','foundation','all','gate-failure','software-gate','export-readonly')
$implemented += @('production-publication','production-gate-repairs','fresh-installation','production-counts','production-gate-cost','production-prerequisites','capacity-focused','capacity-core','capacity-retention','capacity-schema','capacity-cost','capacity-software','lifecycle-acceptance-related','lifecycle-acceptance','lifecycle-race','restore-inventory','restore','lifecycle','lifecycle-core','lifecycle-repair','browser','restart')
if ($Suite -notin ($implemented + @('inventory-acceptance-repair','inventory-acceptance-recovery','inventory-controller-contract','report-source-scale','backend-shard-1','backend-shard-2','inventory-app-exports','inventory-http-contract','inventory-route-contract','inventory-integration','inventory-expiry','inventory-parity','inventory-verification','inventory-identity-proof','inventory-cleanup','inventory-identity','inventory-facets','inventory','inventory-cutover','inventory-usage-authority','inventory-native-evidence','inventory-staging','inventory-jobs','inventory-route','inventory-protocol','inventory-core','inventory-reconciliation','inventory-native-ui','inventory-groups','inventory-foundation')) -and -not $profile -and $Suite -ne 'cutover-compiled-restart') { throw "Suite '$Suite' is not yet implemented; no qualification claimed." }
if ($Suite -in @('cutover-browser-contract','browser')) {
    if ($Suite -eq 'browser' -and -not $PSBoundParameters.ContainsKey('BrowserFiles')) { $BrowserFiles = 'largeTenantData.spec.ts' }
    $selectedFiles = @($BrowserFiles -split ',')
    if (-not ($Suite -eq 'browser' -and $BrowserFiles -ceq 'all') -and ($selectedFiles.Count -gt 32 -or @($selectedFiles | Select-Object -Unique).Count -ne $selectedFiles.Count -or
        @($selectedFiles | Where-Object { $_ -cnotmatch '^[a-zA-Z][a-zA-Z0-9]*\.spec\.ts$' }).Count)) {
        throw 'Browser selection requires 1-32 distinct bare spec filenames.'
    }
} elseif ($BrowserFiles -cne 'reportSets.spec.ts') { throw 'BrowserFiles requires the cutover-browser-contract suite.' }
foreach ($name in @([Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -cmatch '^(PG|APP_PG|TENANT|CLIENT_|SESSION_SECRET)' })) {
    if ([Environment]::GetEnvironmentVariable($name)) { throw "Fixture rejects inherited $name." }
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Unavailable: start the company-approved Docker engine/Desktop and Compose v2; no automatic infrastructure installation.' }
Invoke-DockerCommand @('info','--format','{{.ServerVersion}}') | Out-Null
$id = [Guid]::NewGuid().ToString('N')
$project = "agent-control-ltdp-$id"
$directory = Join-Path $root "artifacts/large-tenant-data-platform/$id"
[IO.Directory]::CreateDirectory($directory) | Out-Null
$image = "$project-operator:local"
$baseline = 'agent-control-scale-5096-operator:local'
$baselineId = Invoke-DockerCommand @('image','inspect','--format','{{.Id}}',$baseline) -Capture
if ($baselineId -cne 'sha256:78f3cb9fa91e7a64960699899d8fe2eb56bdd77c8ee56490f1f5255855b3c235') { throw 'Campaign baseline image identity changed.' }
[IO.File]::WriteAllText((Join-Path $directory 'baseline.txt'),$baselineId)
$hashes = (Invoke-DockerCommand @('run','--rm','--network','none','--entrypoint','node',$baseline,'-e',
    'const fs=require("node:fs"),crypto=require("node:crypto");console.log(JSON.stringify(Object.fromEntries(["package.json","package-lock.json","backend/package.json","frontend/package.json"].map(f=>[f,crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")]))))') -Capture) | ConvertFrom-Json -AsHashtable
foreach ($path in $hashes.Keys) {
    if ((Get-FileHash -LiteralPath (Join-Path $root $path) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hashes[$path]) {
        throw 'Dependency manifests changed: rebuild an approved-feed baseline after checking every lockfile URL; this runner never installs packages.'
    }
}
if ($Suite -eq 'fresh-installation') {
    . (Join-Path $PSScriptRoot 'fresh-installation.ps1')
    Invoke-FreshInstallation -Root $root -Directory $directory -Baseline $baseline
    exit 0
}
if ($Suite -in @('browser','restart')) {
    . (Join-Path $PSScriptRoot 'large-tenant-lifecycle.ps1')
    Invoke-LargeTenantRuntimeFixture -Root $root -Project $project -Directory $directory -Suite $Suite -Baseline $baseline -BrowserFiles $BrowserFiles
    exit 0
}
# Reuse installed, approved dependencies; no installer or registry access.
$dockerfile = Join-Path $directory 'Dockerfile'
$base = "FROM $baseline`n"
if ($Suite -eq 'cutover-browser-contract') {
    $browser = 'agent-control:permission-browser-test-phase06'
    $browserId = Invoke-DockerCommand @('image','inspect','--format','{{.Id}}',$browser) -Capture
    if ($browserId -cne 'sha256:b4eda044a9e58194703b1aa3e3209d3a7ea9cc219f9df14d36d418db873bb60b') { throw 'Cached synthetic browser image identity changed.' }
    $browserArchitecture = Invoke-DockerCommand @('image','inspect','--format','{{.Architecture}}',$browser) -Capture
    $baselineArchitecture = Invoke-DockerCommand @('image','inspect','--format','{{.Architecture}}',$baseline) -Capture
    if ($browserArchitecture -cne $baselineArchitecture) { throw 'Cached browser and approved installed dependencies must have the same architecture.' }
    [IO.File]::WriteAllText((Join-Path $directory 'browser-baseline.txt'),$browserId)
    $base = "FROM $baseline AS installed`nFROM $browser`nRUN rm -rf /app /browser`nCOPY --from=installed /app /app`nCOPY --from=installed /usr/local /usr/local`nWORKDIR /app`n"
}
[IO.File]::WriteAllText($dockerfile,"${base}RUN rm -rf /app/backend/src /app/backend/scripts /app/backend/dist /app/frontend/src /app/frontend/browser /app/frontend/dist /app/scripts /app/docs /app/plans`nCOPY backend /app/backend`nCOPY frontend /app/frontend`nCOPY scripts /app/scripts`nCOPY docs /app/docs`nCOPY plans /app/plans`nCOPY compose.yaml compose.large-tenant-test.yaml /app/`n")
if ($Suite -eq 'software-gate') { [IO.File]::AppendAllText($dockerfile,"RUN npm run build`n") }
if ($Suite -eq 'gate-failure') {
    [IO.File]::AppendAllText($dockerfile, "RUN printf '%s\n' 'console.error(`"intentional owned gate failure`"); setTimeout(() => process.exit(17), 1200);' > /app/backend/scripts/test-all.ts`n")
}
Invoke-DockerCommand @('build','--network','none','-f',$dockerfile,'-t',$image,$root)
if ($Suite -in @('gate-failure','software-gate')) {
    $failure = $null
    try { Invoke-LocalSoftwareChecks @{Root=$root;Operator=$image} -ForceChecks } catch { $failure=$_.Exception }
    $messages = @(Get-FixtureFailureMessages $failure)
    [IO.File]::WriteAllText((Join-Path $directory 'result.json'),(@{suite=$Suite;expectedFailure=($Suite -eq 'gate-failure');failures=$messages} | ConvertTo-Json))
    if ($Suite -eq 'gate-failure' -and $messages.Count -eq 1 -and $messages[0] -ceq 'Fixture workload failed: exit=17, OOMKilled=False.') {
        Write-Host "Expected original-gate refusal verified. Evidence: $directory"
        exit 0
    }
    if ($failure) { throw $failure }
    if ($Suite -eq 'gate-failure') { throw 'Expected original-gate failure was not observed.' }
    exit 0
}
[IO.File]::WriteAllText((Join-Path $directory 'compose.env'),"LOCAL_STATE_DIR='$directory'`nLOCAL_TEST_IMAGE=$image`n")
$compose = @('compose','--project-directory',$root,'--env-file',(Join-Path $directory 'compose.env'),
    '-f',(Join-Path $root 'compose.yaml'),'-f',(Join-Path $root 'compose.large-tenant-test.yaml'),'-p',$project,'--profile','test-db')
if ($Suite -eq 'production-gate-cost') {
    $timingFile = Join-Path $directory 'query-timings.yaml'
    [IO.File]::WriteAllText($timingFile,"services:`n  test-postgres:`n    command: [postgres, -c, shared_buffers=32MB, -c, min_wal_size=32MB, -c, max_wal_size=1GB, -c, log_min_duration_statement=20]`n")
    $compose += @('-f',$timingFile)
}
if ($Suite -eq 'export-readonly') {
    $readonlyFile = Join-Path $directory 'readonly.yaml'
    [IO.File]::WriteAllText($readonlyFile,"services:`n  test-db:`n    read_only: true`n    environment:`n      TSX_DISABLE_CACHE: '1'`n")
    $compose += @('-f',$readonlyFile)
}
$failures = [Collections.Generic.List[Exception]]::new()
$started = $false
try {
    $started = $true
    Invoke-DockerCommand ($compose + @('up','-d','--no-build','--wait','--wait-timeout','90','test-postgres'))
    $ids = @(Get-OwnedFixtureContainers $project)
    if ($ids.Count -ne 1) { throw 'Expected exactly one owned PostgreSQL container.' }
    $mounts = Invoke-DockerCommand @('inspect','--format','{{json .Mounts}}',$ids[0]) -Capture
    [IO.File]::WriteAllText((Join-Path $directory 'mounts.json'),$mounts)
    $dataMount = @($mounts | ConvertFrom-Json | Where-Object { $_.Destination -eq '/var/lib/postgresql/data' })
    if ($dataMount.Count -ne 1 -or $dataMount[0].Type -ne 'volume' -or $dataMount[0].Name -cne "${project}_large-tenant-data") { throw 'Fixture requires exact owned disk-backed PGDATA, not tmpfs.' }
    $command = if ($Suite -eq 'export-readonly') { @('node','--import','tsx','backend/scripts/exportReadonlyFixture.ts') }
        else { @('node','node_modules/tsx/dist/cli.mjs','backend/scripts/largeTenantFixture.ts',$Suite) }
    if ($Suite -eq 'cutover-browser-contract') { $command += $BrowserFiles }
    Invoke-OwnedFixtureWorkload $compose $project $directory $command
} catch { $failures.Add($_.Exception) }
finally {
    if ($started) {
        try { Write-FixtureDiagnostics $project $directory -Final } catch { $failures.Add($_.Exception) }
        try { Remove-OwnedFixture $compose $project $directory } catch { $failures.Add($_.Exception) }
    }
    [IO.File]::WriteAllText((Join-Path $directory 'result.json'),(@{suite=$Suite;project=$project;failures=@($failures | ForEach-Object { $_.Message })} | ConvertTo-Json -Depth 5))
    Write-Host "Evidence: $directory"
}
if ($Suite -eq 'all') {
    $auxiliary = @()
    foreach ($childSuite in @('lifecycle','restore','restart','browser','capacity')) {
        $childLog = Join-Path $directory "$childSuite.log"
        $childArguments = @('-NoProfile','-File',$PSCommandPath,'-Suite',$childSuite)
        if ($childSuite -eq 'browser') { $childArguments += @('-BrowserFiles','all') }
        $startedAt = [DateTime]::UtcNow
        try {
            & pwsh @childArguments *> $childLog
            $childExit = $LASTEXITCODE
            $auxiliary += @{suite=$childSuite;exit=$childExit;startedAt=$startedAt.ToString('o');finishedAt=[DateTime]::UtcNow.ToString('o');log=$childLog}
            if ($childExit -ne 0) { $failures.Add([Exception]::new("Independent $childSuite failed: exit=$childExit; evidence=$childLog")) }
        } catch {
            $auxiliary += @{suite=$childSuite;exit=$null;error=$_.Exception.Message;startedAt=$startedAt.ToString('o');finishedAt=[DateTime]::UtcNow.ToString('o');log=$childLog}
            $failures.Add($_.Exception)
        }
        [IO.File]::WriteAllText((Join-Path $directory 'auxiliary-results.json'),(ConvertTo-Json -InputObject @($auxiliary) -Depth 5))
    }
}
if ($failures.Count) { throw [AggregateException]::new('Large-tenant qualification failed.',$failures) }
