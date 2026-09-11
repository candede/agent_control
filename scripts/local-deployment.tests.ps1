#requires -Version 7.0
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'local-deployment.ps1')
$repositoryRoot=Split-Path $PSScriptRoot -Parent
$scratchRoot=Join-Path $repositoryRoot 'artifacts/test-scratch'
$testRoot=Join-Path $scratchRoot "agent control tests $([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$script:Calls=[Collections.Generic.List[string]]::new()
$script:Failure=''
$script:VolumeExists=$false
$script:ComposeVersion='2.30.0'
$script:NoDocker=$false
$script:Checks=0
function Get-Command {
    param([string]$Name,$ErrorAction)
    if ($Name -eq 'docker') { if (-not $script:NoDocker) { return @{Name='docker'} }; return }
    Microsoft.PowerShell.Core\Get-Command $Name -ErrorAction $ErrorAction
}
function Invoke-DockerCommand {
    param([string[]]$Arguments,[switch]$Capture)
    $line=$Arguments -join '|'; $script:Calls.Add($line)
    if ($script:Failure -and $line -match $script:Failure) { throw 'Simulated Docker failure (redacted).' }
    if ($Arguments[0] -eq 'info') { return '29.7.2' }
    if ($line -eq 'compose|version|--short') { return $script:ComposeVersion }
    if ($Arguments[0] -eq 'volume') { if ($script:VolumeExists) { return 'fixture-project_data' }; return '' }
    if ($line -match '\|postgres$') { $script:VolumeExists=$true }
}
function Get-LocalHealth { param([string]$Url) return @{authConfigured=$false;callback="$Url/api/auth/callback"} }
function Assert-True { param([bool]$Condition,[string]$Message) if (-not $Condition) { throw $Message }; $script:Checks++ }
function Assert-Fails { param([scriptblock]$Command,[string]$Pattern) try { & $Command; throw 'Expected failure did not occur' } catch { Assert-True ($_.Exception.Message -match $Pattern) "Unexpected failure: $($_.Exception.Message)" } }
try {
    $context=New-LocalContext -Root $testRoot -StateRoot $testRoot -Project 'fixture-project' -Port 14391
    $script:NoDocker=$true
    Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'approved Docker'
    $script:NoDocker=$false; $script:Failure='^info\|'
    Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'Simulated'
    $script:Failure=''; $script:ComposeVersion='1.29.0'
    Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'Compose v2'
    $script:ComposeVersion='2.30.0'
    Assert-Fails { Invoke-LocalDeployment $context 'Reset' } 'reset denied'
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $listener.Start()
    try { Assert-Fails { Assert-LocalPort $listener.LocalEndpoint.Port } 'occupied' } finally { $listener.Stop() }
    foreach ($failure in @('^build\|','\|migrate$','\|--wait-timeout\|90\|postgres$','\|--wait-timeout\|90\|app$')) {
        $script:Failure=$failure
        Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'Simulated'
    }
    $script:Failure=''
    Invoke-LocalDeployment $context 'Deploy' 6>$null
    $secret=Join-Path $context.State 'secrets/postgres-app'
    $before=[IO.File]::ReadAllText($secret)
    Invoke-LocalDeployment $context 'Deploy' 6>$null
    Assert-True ([IO.File]::ReadAllText($secret) -ceq $before) 'Repeat deploy rotated credentials.'
    Assert-True (($script:Calls -join "`n") -notlike "*$before*") 'Secret leaked to command arguments.'
    Assert-True (($script:Calls -join "`n").Contains($testRoot)) 'Paths containing spaces were not preserved.'
    Assert-True (-not (($script:Calls -join "`n") -match 'down\|--volumes')) 'Normal deployment reset the volume.'
    Assert-Fails { Invoke-LocalDeployment $context 'Retain' } 'cleanup denied'
    Invoke-LocalDeployment $context 'Retain' -ConfirmCleanup 'fixture-project/agentcontrol' -DryRun 6>$null
    Assert-True (($script:Calls -join "`n") -match 'database.ts\|retain\|confirmed\|1000\|dry-run') 'Dry-run cleanup was not explicit and bounded.'
    $backups=Join-Path $context.State 'backups'
    $originalCulture=[Threading.Thread]::CurrentThread.CurrentCulture
    try {
        foreach ($culture in @('en-US','en-GB')) {
            [Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::GetCultureInfo($culture)
            foreach ($age in @(1,8)) {
                $dump=Join-Path $backups "fixture-$age.dump"
                [IO.File]::WriteAllText($dump,'fixture')
                $created=[DateTime]::UtcNow.AddDays(-$age)
                [IO.File]::WriteAllText("$dump.json",(@{version=3;sha256=('a'*64);snapshotAt=$created.AddSeconds(-1).ToString('o');createdAt=$created.ToString('o')} | ConvertTo-Json))
            }
            Remove-ExpiredLocalBackups $backups
            Assert-True (Test-Path -LiteralPath (Join-Path $backups 'fixture-1.dump')) "Retention removed a current backup under $culture."
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $backups 'fixture-8.dump'))) "Retention left an expired dump under $culture."
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $backups 'fixture-8.dump.json'))) "Retention left an expired receipt under $culture."
        }
    } finally {
        [Threading.Thread]::CurrentThread.CurrentCulture=$originalCulture
    }
    [IO.File]::WriteAllText($secret,'corrupt')
    Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'corrupt'
    [IO.File]::WriteAllText($secret,$before)
    Remove-Item -LiteralPath $secret
    Assert-Fails { Invoke-LocalDeployment $context 'Deploy' } 'original secret'
    Assert-Fails { Invoke-LocalDeployment $context 'Reset' -ConfirmReset 'other/other_data' } 'reset denied'
    Write-Host "Passed $script:Checks PowerShell orchestration assertions."
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
    if ((Test-Path -LiteralPath $scratchRoot) -and -not (Get-ChildItem -LiteralPath $scratchRoot -Force)) {
        Remove-Item -LiteralPath $scratchRoot
    }
}