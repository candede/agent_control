param([switch]$Full)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
. (Join-Path $PSScriptRoot 'local-mcp-fixture.ps1')
Assert-LocalMcpFixtureEngine
foreach ($name in @([Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -cmatch '^(MCP_|AZURE_|PG|APP_PG|TENANT|CLIENT_|SESSION_SECRET)' })) {
    if ([Environment]::GetEnvironmentVariable($name)) { throw 'Azure OAuth fixture rejects inherited application/cloud credentials.' }
}
$project = "ac-oauth-fixture-$([Guid]::NewGuid().ToString('N').Substring(0,24))"
$image = 'mcr.microsoft.com/azure-storage/azurite@sha256:647c63a91102a9d8e8000aab803436e1fc85fbb285e7ce830a82ee5d6661cf37'
$directory = Join-Path $root "artifacts/phase10-blob/$project"
$scratch = Join-Path $root ".local/$project"
if ((Test-Path -LiteralPath $directory) -or (Test-Path -LiteralPath $scratch)) { throw 'Fixture paths must be absent.' }
$baseline = @((Invoke-DockerCommand @('ps','-aq','--no-trunc') -Capture) -split "`n" | Where-Object { $_ })
$network = $null
$container = $null
$exit = 1
$evidence = [ordered]@{purpose='synthetic OAuth Blob lease qualification';project=$project;context='desktop-linux'
    endpoint="unix://$HOME/.docker/run/docker.sock";image=$image;azureEvidence=$false;networkRemoved=$false;containerRemoved=$false}
[IO.Directory]::CreateDirectory($directory) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $scratch 'emulator')) | Out-Null
try {
    $imageId = Invoke-DockerCommand @('image','inspect','--format','{{.Id}}',$image) -Capture
    $evidence.imageId = $imageId
    $network = Invoke-DockerCommand @('network','create','--internal','--label',"io.agent-control.fixture=$project",$project) -Capture
    $container = Invoke-DockerCommand @('run','-d','--name',$project,'--label',"io.agent-control.fixture=$project",
        '--network',$project,'--memory','512m','--cpus','1','--pids-limit','128',
        '--mount',"type=bind,source=$(Join-Path $scratch 'emulator'),target=/data,readonly",
        '--env','AZURITE_ACCOUNTS=fixtureoauth:c3ludGhldGljLWVtdWxhdG9yLWtleS1ub3QtYS1wcm9kdWN0aW9uLXNlY3JldA==',
        $image,'azurite-blob','--blobHost','127.0.0.1','--silent','--disableTelemetry','--inMemoryPersistence',
        '--extentMemoryLimit','128','--skipApiVersionCheck') -Capture
    $evidence.containerId = $container
    $evidence.networkId = $network
    Assert-LocalMcpFixtureEngine
    $inspect = Invoke-DockerCommand @('inspect',$container) -Capture | ConvertFrom-Json
    $state = $inspect[0]
    $evidence.observed = @{image=$state.Image;mounts=$state.Mounts;memory=$state.HostConfig.Memory
        cpus=$state.HostConfig.NanoCpus;pids=$state.HostConfig.PidsLimit
        networks=@($state.NetworkSettings.Networks.PSObject.Properties.Name);ports=$state.HostConfig.PortBindings}
    if ($state.Id -cne $container -or $state.Image -cne $imageId -or
        $state.Config.Labels.'io.agent-control.fixture' -cne $project -or $state.Mounts.Count -ne 1 -or
        $state.Mounts[0].Type -cne 'bind' -or $state.Mounts[0].Destination -cne '/data' -or $state.Mounts[0].RW -or
        -not (Test-LocalBindSource $state.Mounts[0].Source (Join-Path $scratch 'emulator')) -or
        $state.HostConfig.Memory -ne 536870912 -or $state.HostConfig.NanoCpus -ne 1000000000 -or
        $state.HostConfig.PidsLimit -ne 128 -or $state.NetworkSettings.Networks.PSObject.Properties.Name -cne $project -or
        @($state.HostConfig.PortBindings.PSObject.Properties).Count) { throw 'Fixture ownership/isolation differs.' }
    $evidence.transport = 'bounded16-connection host127.0.0.1 -> exact-owned Docker exec -> container127.0.0.1:10000; no NAT/public ports'
    $ready = $false
    foreach ($attempt in 1..30) {
        try {
            $response = Invoke-DockerCommand @('exec',$container,'node','-e',
                'require("http").get("http://127.0.0.1:10000/fixtureoauth?comp=list", r => {process.exit(r.statusCode===403?0:1)}).on("error",()=>process.exit(1))') -Capture
            $ready=$true; break
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    if (-not $ready -or -not $state.State.Running) { throw 'Owned emulator did not become responsive.' }
    $evidence.responsive = $true
    $selectors = if ($Full) { @() } else {
        @('tests/test_azure_storage.py','tests/test_config_storage.py','tests/test_oauth.py','tests/test_container_contract.py')
    }
    Push-Location (Join-Path $root 'mcp')
    try {
        $output = @(& .venv/bin/python tests/azure_fixture_tunnel.py $container (Join-Path $scratch 'pytest') @selectors 2>&1)
        $exit = $LASTEXITCODE
        $redacted = ConvertTo-RedactedFixtureLog ($output -join "`n")
        [IO.File]::WriteAllText((Join-Path $directory 'pytest.log'),$redacted)
        Write-Output $redacted
        $evidence.validation = if ($Full) { 'full Python aggregate with real Azure SDK/emulator' } else { 'focused SDK/emulator, file, OAuth and container contracts' }
        $evidence.exitCode = $exit
    } finally { Pop-Location }
} catch {
    if ($container) {
        $logs = Invoke-DockerCommand @('logs',$container) -Capture -CaptureError
        [IO.File]::WriteAllText((Join-Path $directory 'emulator.log'),(ConvertTo-RedactedFixtureLog $logs))
        Write-Output (ConvertTo-RedactedFixtureLog $logs)
    }
    throw
} finally {
    Assert-LocalMcpFixtureEngine
    if ($container) {
        $owned = Invoke-DockerCommand @('inspect','--format','{{.Config.Labels}} {{.Image}}',$container) -Capture
        if (-not $owned.Contains($project) -or -not $owned.Contains($imageId)) { throw 'Refusing cleanup of changed container owner/image.' }
        Invoke-DockerCommand @('rm','-f',$container) | Out-Null
        $evidence.containerRemoved = -not (Invoke-DockerCommand @('ps','-aq','--no-trunc','--filter',"id=$container") -Capture)
    }
    if ($network) {
        $owned = Invoke-DockerCommand @('network','inspect',$network) -Capture | ConvertFrom-Json
        if ($owned[0].Labels.'io.agent-control.fixture' -cne $project -or -not $owned[0].Internal -or
            @($owned[0].Containers.PSObject.Properties).Count) { throw 'Refusing cleanup of changed network ownership/use.' }
        Invoke-DockerCommand @('network','rm',$network) | Out-Null
        $evidence.networkRemoved = -not (Invoke-DockerCommand @('network','ls','--filter',"id=$network",'--format','{{.ID}}') -Capture)
    }
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Force -Recurse }
    $evidence.priorContainersPreserved = @($baseline | Where-Object { $_ -and
        -not (Invoke-DockerCommand @('ps','-aq','--no-trunc','--filter',"id=$_") -Capture) }).Count -eq 0
    [IO.File]::WriteAllText((Join-Path $directory 'evidence.json'),($evidence | ConvertTo-Json -Depth 8))
    Write-Output "Redacted SDK/emulator evidence: artifacts/phase10-blob/$project/evidence.json"
}
if ($exit -ne 0) { throw "Azure OAuth fixture validation failed with exit $exit." }
