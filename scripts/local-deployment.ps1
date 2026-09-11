function Invoke-DockerCommand {
    param([string[]]$Arguments, [switch]$Capture)
    if ($Capture) { $result = @(& docker @Arguments); if ($LASTEXITCODE -ne 0) { throw 'Docker command failed. Check engine, build, target and health status.' }; return ($result -join "`n") }
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Docker command failed. Check engine, build, target and health status.' }
}

function New-LocalContext {
    param([string]$Root,[string]$StateRoot,[string]$Project,[int]$Port)
    if ($Project -notmatch '^[a-z][a-z0-9-]{2,39}$') { throw 'Project must be 3-40 lowercase letters, digits or hyphens.' }
    if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be 1024-65535.' }
    $rootPath = [IO.Path]::GetFullPath($Root)
    $state = [IO.Path]::GetFullPath((Join-Path $StateRoot $Project))
    if ($state -match "[\r\n']" -or $rootPath -match "[\r\n']") { throw 'Paths may contain spaces, but not newlines or single quotes.' }
    return @{
        Root=$rootPath; State=$state; Project=$Project; Port=$Port; Url="http://localhost:$Port"
        Volume="${Project}_data"; Network="${Project}_default"; Image="${Project}-app:local"; Operator="${Project}-operator:local"
        Compose=@('compose','--project-directory',$rootPath,'--env-file',(Join-Path $state 'compose.env'),'-f',(Join-Path $rootPath 'compose.yaml'),'-p',$Project)
    }
}

function Protect-LocalPath {
    param([string]$Path,[switch]$Directory)
    if (-not $IsWindows) {
        $mode = if ($Directory) { [IO.UnixFileMode]448 } else { [IO.UnixFileMode]384 }
        [IO.File]::SetUnixFileMode($Path,$mode)
    } else {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        & icacls $Path '/inheritance:r' '/grant:r' "${identity}:(F)" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not restrict local secret permissions.' }
    }
}

function Initialize-LocalState {
    param($Context,[bool]$ExistingVolume,[string]$TenantId,[string]$ClientId,[string]$ClientSecretFile)
    $state = $Context.State
    $secretDirectory = Join-Path $state 'secrets'
    foreach ($name in @('postgres-admin','postgres-app','session')) {
        $file = Join-Path $secretDirectory $name
        if ($ExistingVolume -and -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Existing volume $($Context.Volume) requires its original secret files. Restore the local state directory; do not regenerate credentials." }
        if (Test-Path -LiteralPath $file) {
            $value = [IO.File]::ReadAllText($file).Trim()
            if ($value -notmatch '^[A-Za-z0-9+/]{64}$') { throw "Local secret file $name is corrupt. Restore the original secret; do not reset the volume." }
        }
    }
    foreach ($directory in @($state,$secretDirectory,(Join-Path $state 'control'),(Join-Path $state 'backups'))) {
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        Protect-LocalPath $directory -Directory
    }
    foreach ($name in @('postgres-admin','postgres-app','session')) {
        $file = Join-Path $secretDirectory $name
        if (-not (Test-Path -LiteralPath $file)) { [IO.File]::WriteAllText($file,[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))) }
        Protect-LocalPath $file
    }
    $settingsFile = Join-Path $state 'settings.json'
    if (Test-Path -LiteralPath $settingsFile) {
        $previous = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
        if ($previous.port -ne $Context.Port) { throw 'Origin changed. Rerun with the existing port or explicitly prepare a new local project.' }
        if (-not $TenantId) { $TenantId=$previous.tenantId }
        if (-not $ClientId) { $ClientId=$previous.clientId }
        if ($previous.tenantId -and $TenantId -ne $previous.tenantId) { throw 'Existing project belongs to another tenant. Use a separate local project.' }
    }
    foreach ($identifier in @($TenantId,$ClientId)) { if ($identifier -and $identifier -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') { throw 'Tenant and client identifiers must be GUIDs.' } }
    $clientFile = Join-Path $secretDirectory 'client-secret'
    if ($ClientSecretFile) {
        if (-not (Test-Path -LiteralPath $ClientSecretFile -PathType Leaf)) { throw 'The existing client secret file was not found.' }
        [IO.File]::WriteAllText($clientFile,[IO.File]::ReadAllText([IO.Path]::GetFullPath($ClientSecretFile)).Trim())
    } elseif (-not (Test-Path -LiteralPath $clientFile)) {
        if ($TenantId -and $ClientId) {
            $secure = Read-Host 'Entra client secret (secure terminal input)' -AsSecureString
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            try { [IO.File]::WriteAllText($clientFile,[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }
            finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
        } else { [IO.File]::WriteAllText($clientFile,'') }
    }
    Protect-LocalPath $clientFile
    $userId = if ($IsWindows) { '1000' } else { (& id -u).Trim() }
    $groupId = if ($IsWindows) { '1000' } else { (& id -g).Trim() }
    [IO.File]::WriteAllText($settingsFile,(@{port=$Context.Port;tenantId=$TenantId;clientId=$ClientId} | ConvertTo-Json))
    $lines = @("LOCAL_STATE_DIR='$state'","APP_PORT=$($Context.Port)","APP_UID=$userId","APP_GID=$groupId","APP_IMAGE=$($Context.Image)","TENANT_ID=$TenantId","CLIENT_ID=$ClientId")
    [IO.File]::WriteAllLines((Join-Path $state 'compose.env'),$lines)
    Protect-LocalPath $settingsFile
    Protect-LocalPath (Join-Path $state 'compose.env')
}

function Assert-LocalPort {
    param([int]$Port)
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$Port)
    try { $listener.Start() } catch { throw "Loopback port $Port is occupied. Use -Port with an available port and matching Entra callback." }
    finally { $listener.Stop() }
}

function Invoke-LocalOperator {
    param($Context,[string[]]$Command,[string]$BackupDirectory)
    $arguments = @('run','--rm','--network',$Context.Network,'--mount',"type=bind,source=$($Context.State)/secrets,target=/run/secrets,readonly",'-e','PGHOST=postgres','-e','PGUSER=agentcontrol_admin','-e','PGDATABASE=agentcontrol','-e','PGPASSWORD_FILE=/run/secrets/postgres-admin','-e','APP_PGPASSWORD_FILE=/run/secrets/postgres-app')
    if ($BackupDirectory) { $arguments += @('--mount',"type=bind,source=$BackupDirectory,target=/backups") }
    Invoke-DockerCommand ($arguments + @($Context.Operator) + $Command)
}

function Get-LocalHealth {
    param([string]$Url)
    $ready = Invoke-RestMethod "$Url/api/ready" -TimeoutSec 10
    if (-not $ready.ok) { throw 'Database/schema readiness failed.' }
    return Invoke-RestMethod "$Url/api/auth/status" -TimeoutSec 10
}

function Remove-ExpiredLocalBackups {
    param([string]$Directory)
    $threshold=[DateTime]::UtcNow.AddDays(-7)
    foreach ($receipt in Get-ChildItem -LiteralPath $Directory -Filter '*.dump.json' -File) {
        if ($receipt.LinkType) { throw 'Backup receipts must not be symbolic links.' }
        $metadata=Get-Content -LiteralPath $receipt.FullName -Raw | ConvertFrom-Json
        $created=if ($metadata.createdAt -is [DateTime]) { $metadata.createdAt.ToUniversalTime() }
            else { [DateTimeOffset]::Parse([string]$metadata.createdAt,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime }
        if ($metadata.version -notin @(1,2,3) -or $metadata.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid backup receipt; review before retention.' }
        if ($metadata.version -eq 3) {
            $snapshot=if ($metadata.snapshotAt -is [DateTime]) { $metadata.snapshotAt.ToUniversalTime() }
                else { [DateTimeOffset]::Parse([string]$metadata.snapshotAt,[Globalization.CultureInfo]::InvariantCulture).UtcDateTime }
            if ($snapshot -gt $created) { throw 'Invalid backup snapshot timestamp; review before retention.' }
        }
        if ($created -ge $threshold) { continue }
        $dump=$receipt.FullName.Substring(0,$receipt.FullName.Length-5)
        if (Test-Path -LiteralPath $dump) {
            if ((Get-Item -LiteralPath $dump).LinkType) { throw 'Backup dumps must not be symbolic links.' }
            Remove-Item -LiteralPath $dump
        }
        Remove-Item -LiteralPath $receipt.FullName
    }
}

function Invoke-LocalDeployment {
    param($Context,[string]$Action,[string]$TenantId,[string]$ClientId,[string]$ClientSecretFile,[string]$BackupFile,[string]$RestoreDatabase,[string]$ConfirmCleanup,[int]$CleanupBatchSize=1000,[switch]$DryRun,[string]$ConfirmReset)
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install and start the company-approved Docker engine/Desktop and Compose v2 before continuing.' }
    Invoke-DockerCommand @('info','--format','{{.ServerVersion}}') | Out-Null
    $composeVersion = Invoke-DockerCommand @('compose','version','--short') -Capture
    if ($composeVersion -notmatch '^v?([2-9]|[1-9][0-9])\.') { throw 'Docker Compose v2 or newer is required.' }
    $volumes = Invoke-DockerCommand @('volume','ls','--format','{{.Name}}') -Capture
    $existing = $Context.Volume -in ($volumes -split "`n")
    if ($Action -eq 'Reset') {
        if ($ConfirmReset -cne "$($Context.Project)/$($Context.Volume)") { throw "Destructive reset denied. Exact confirmation required: $($Context.Project)/$($Context.Volume)" }
        if (-not (Test-Path -LiteralPath (Join-Path $Context.State 'compose.env'))) { throw 'Reset requires the original project configuration for target verification.' }
        Invoke-DockerCommand ($Context.Compose + @('down','--volumes','--remove-orphans'))
        Remove-Item -LiteralPath $Context.State -Recurse -Force
        return
    }
    if ($Action -ne 'Deploy' -and -not $existing) { throw 'Expected project volume is missing. Stop for recovery; only an explicit fresh Deploy creates storage.' }
    Initialize-LocalState $Context $existing $TenantId $ClientId $ClientSecretFile
    $marker = Join-Path $Context.State 'control/maintenance'
    if ($Action -eq 'Stop') {
        [IO.File]::WriteAllText($marker,'maintenance')
        Invoke-DockerCommand ($Context.Compose + @('stop','--timeout','130'))
        return
    }
    if ($Action -in @('Deploy','Test')) {
        Invoke-DockerCommand @('build','--target','operator','-t',$Context.Operator,$Context.Root)
    }
    if ($Action -eq 'Deploy') {
        Invoke-DockerCommand @('build','--target','runtime','-t',$Context.Image,$Context.Root)
        [IO.File]::WriteAllText($marker,'maintenance')
        Invoke-DockerCommand ($Context.Compose + @('stop','--timeout','130','app'))
        Assert-LocalPort $Context.Port
        Invoke-DockerCommand ($Context.Compose + @('up','-d','--wait','--wait-timeout','90','postgres'))
        Invoke-LocalOperator $Context @('backend/scripts/database.ts','migrate')
        Invoke-LocalOperator $Context @('backend/scripts/test-all.ts')
    }
    if ($Action -eq 'Test') { Invoke-LocalOperator $Context @('backend/scripts/test-all.ts'); return }
    if ($Action -eq 'Retain') {
        $expected="$($Context.Project)/agentcontrol"
        if ($ConfirmCleanup -cne $expected) { throw "Retention cleanup denied. Exact confirmation required: $expected" }
        $mode=if ($DryRun) { 'dry-run' } else { 'apply' }
        Invoke-LocalOperator $Context @('backend/scripts/database.ts','retain','confirmed',"$CleanupBatchSize",$mode)
        if (-not $DryRun) { Remove-ExpiredLocalBackups (Join-Path $Context.State 'backups') }
        return
    }
    if ($Action -eq 'Reopen') {
        if ($RestoreDatabase -notmatch '^agentcontrol_restore_[a-z0-9_]{1,40}$') { throw 'Reopen requires an isolated agentcontrol_restore_* database.' }
        Invoke-LocalOperator $Context @('backend/scripts/backup.ts','reopen',$RestoreDatabase)
        return
    }
    if ($Action -in @('Backup','Restore')) {
        if (-not $BackupFile) { $BackupFile = Join-Path $Context.State "backups/$(Get-Date -AsUTC -Format 'yyyyMMddTHHmmssfffZ').dump" }
        $filename = [IO.Path]::GetFullPath($BackupFile)
        $directory = [IO.Path]::GetDirectoryName($filename)
        if (-not (Test-Path -LiteralPath $directory)) { throw 'Backup directory must already exist with restricted permissions.' }
        if ($Action -eq 'Restore' -and $RestoreDatabase -notmatch '^agentcontrol_restore_[a-z0-9_]{1,40}$') { throw 'Restore requires a new isolated agentcontrol_restore_* database.' }
        $command = @('backend/scripts/backup.ts',$Action.ToLowerInvariant(),"/backups/$([IO.Path]::GetFileName($filename))")
        if ($Action -eq 'Restore') { $command += $RestoreDatabase }
        Invoke-LocalOperator $Context $command $directory
        Write-Host "$Action verified: $filename"
        return
    }
    if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
    try {
        Invoke-DockerCommand ($Context.Compose + @('up','-d','--no-build','--wait','--wait-timeout','90','app'))
        $health = Get-LocalHealth $Context.Url
    } catch {
        [IO.File]::WriteAllText($marker,'maintenance')
        throw
    }
    Write-Host "Healthy local app: $($Context.Url)"
    if (-not $health.authConfigured) { Write-Host "Sign-in unconfigured. Supply -TenantId, -ClientId and -ClientSecretFile; register $($health.callback) as an Entra Web reply URL." }
}