function Invoke-DockerCommand {
    param([string[]]$Arguments, [switch]$Capture)
    $savedEnvironment = @{}
    try {
        if ($Arguments[0] -eq 'compose' -and $Arguments -contains '--env-file') {
            # Project-owned settings must not be replaced by another project's shell environment.
            foreach ($name in @('LOCAL_STATE_DIR','APP_PORT','APP_UID','APP_GID','APP_IMAGE','TENANT_ID','CLIENT_ID','FRONTEND_ORIGIN','REDIRECT_URI','TRUST_PROXY')) {
                $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
                # .NET can retain a null assignment as an empty override of compose.env.
                if (Test-Path "Env:$name") { Remove-Item "Env:$name" }
            }
        }
        if ($Capture) { $result = @(& docker @Arguments); if ($LASTEXITCODE -ne 0) { throw 'Docker command failed. Check engine, build, target and health status.' }; return ($result -join "`n") }
        & docker @Arguments
        if ($LASTEXITCODE -ne 0) { throw 'Docker command failed. Check engine, build, target and health status.' }
    } finally {
        foreach ($name in $savedEnvironment.Keys) {
            if ($null -eq $savedEnvironment[$name]) {
                if (Test-Path "Env:$name") { Remove-Item "Env:$name" }
            } else {
                Set-Item "Env:$name" $savedEnvironment[$name]
            }
        }
    }
}

function New-LocalContext {
    param([string]$Root,[string]$Project='agent-control')
    if ($Project -cnotmatch '^[a-zA-Z][a-zA-Z0-9-]{2,39}$') { throw 'Project must be 3-40 letters, digits or hyphens, starting with a letter.' }
    $Project = $Project.ToLowerInvariant()
    $rootPath = [IO.Path]::GetFullPath($Root)
    $state = Join-Path (Join-Path $rootPath '.local') $Project
    if ($state -match "[\r\n']" -or $rootPath -match "[\r\n']") { throw 'Paths may contain spaces, but not newlines or single quotes.' }
    $settings = Read-LocalSettings $state
    $port = if ($settings.Contains('port')) { $settings.port } else { 0 }
    $url = if ($port) { "http://localhost:$port" } else { '' }
    return @{
        Root=$rootPath; State=$state; Project=$Project; Port=$port; Url=$url
        PublicUrl=$(if ($settings.publicUrl) { $settings.publicUrl } else { $url })
        Volume="${Project}_data"; Network="${Project}_default"; Image="${Project}-app:local"; Operator="${Project}-operator:local"
        Compose=@('compose','--project-directory',$rootPath,'--env-file',(Join-Path $state 'compose.env'),'-f',(Join-Path $rootPath 'compose.yaml'),'-p',$Project)
    }
}

function Read-LocalSettings {
    param([string]$State)
    $file = Join-Path $State 'settings.json'
    if (-not (Test-Path -LiteralPath $file)) { return [ordered]@{} }
    $settings = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json -AsHashtable
    if ($settings -isnot [Collections.IDictionary]) { throw 'Project settings must be a JSON object. Restore settings.json before continuing.' }
    if ($settings.Contains('port') -and ($settings.port -isnot [long] -and $settings.port -isnot [int] -or $settings.port -lt 1024 -or $settings.port -gt 65535)) {
        throw 'Saved project port must be an integer from 1024 to 65535. Repair settings.json before continuing.'
    }
    if ($settings.Contains('publicUrl') -and ($settings.publicUrl -isnot [string] -or ($settings.publicUrl -ne '' -and -not (Test-LocalPublicUrl $settings.publicUrl)))) {
        throw 'Saved publicUrl must be empty or a canonical HTTPS origin without a trailing slash, path, query or fragment. Repair settings.json before continuing.'
    }
    return $settings
}

function Test-LocalPublicUrl {
    param([string]$Value)
    $uri = $null
    return ($Value -cmatch '^https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[1-9][0-9]{0,4})?$' -and
        [Uri]::TryCreate($Value,[UriKind]::Absolute,[ref]$uri) -and
        $uri.AbsoluteUri -ceq "$Value/" -and
        # Node's URL parser interprets numeric final labels as IPv4, unlike .NET.
        ($uri.HostNameType -eq [UriHostNameType]::IPv4 -or $uri.DnsSafeHost -cnotmatch '(?:^|\.)(?:[0-9]+|0x[0-9a-f]+)$'))
}

function Read-LocalPublicUrl {
    param([string]$Current,[int]$Port)
    $display = if ($Current) { $Current } else { "http://localhost:$Port (automatic)" }
    Write-Host 'For a controlled HTTPS tunnel/reverse proxy, enter its public origin. This enables trust of one proxy hop; it must forward X-Forwarded-Proto: https.'
    Show-LocalTunnelGuidance $Port
    while ($true) {
        $value = [string](Read-Host "Public URL [$display; Enter to keep; 'local' to reset]")
        if ([string]::IsNullOrWhiteSpace($value)) { return $Current }
        $value = $value.Trim()
        if ($value -ieq 'local') { return '' }
        if (Test-LocalPublicUrl $value) { return $value }
        Write-Warning 'Enter a canonical HTTPS origin, e.g. https://your-tunnel.devtunnels.ms, without a trailing slash, path, query or fragment; or local.'
    }
}

function Show-LocalTunnelGuidance {
    param([int]$Port)
    Write-Host "Configure the existing tunnel port: devtunnel port update YOUR_TUNNEL_ID -p $Port --host-header unchanged --origin-header unchanged"
    Write-Host "Then host the tunnel: devtunnel host YOUR_TUNNEL_ID --host-header unchanged --origin-header unchanged"
    Write-Host 'Host flags alone may leave an existing port rewriting Origin to localhost, breaking permission checks and sign-out. Persist the port settings; do not force a fixed Origin or disable same-origin checks.'
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

function Show-LocalRegistrationGuidance {
    Write-Host @'

Registered app permissions and setup
===================================
Use an approved single-tenant Entra Web application.
Normal sign-in requests all implemented delegated permissions up front, including package changes.
Sign in without provider setup defers consent and requests only openid and profile.
Approve the intended permissions below; consent does not assign roles or licenses.

Entra admin center > App registrations > your app > API permissions >
Add a permission. Select the API and Delegated permissions for user-driven features.

Microsoft Graph - Delegated permissions:
  CopilotPackages.Read.All       Read the Copilot package catalog.
  CopilotPackages.ReadWrite.All  Block/unblock and other package controls.
                                Also satisfies package-read permission checks.
  User.ReadBasic.All             Look up users.
  Group.Read.All                 Look up groups.
  AuditLogsQuery.Read.All        Search Microsoft Purview audit records.
  ThreatHunting.Read.All         Run Defender advanced hunting queries.

Power Platform - Delegated permissions:
  ResourceQuery.Resources.Read   Read Power Platform inventory.
  CopilotStudio.AdminActions.Invoke  Read/change Copilot Studio quarantine.
  Resource/application ID: 8578e004-a5c6-46e7-913e-12f58912df43

Obtain the required tenant administrator consent for the selected permissions.
After sign-in, the app checks delegated access automatically without requiring
probe-button clicks. Interactive consent, MFA or Conditional Access may still
require the user's participation; the app cannot grant those permissions itself.
Automatic checks never change packages, quarantine agents or run investigations.
Token acquisition alone does not prove provider access, roles or licensing.
Optional Microsoft Graph Application permissions, ONLY for separately enabled
app-only features: CopilotPackages.Read.All, AuditLogsQuery.Read.All,
ThreatHunting.Read.All. A client secret does not require Application permissions;
do not add both permission types by default.

App roles (separate from API permissions):
  Add the appRoles entries from infra/entra-app-manifest.json, preserving the
  registration's other settings. When creating roles in the portal, select
  Users/Groups for Allowed member types. origin: Application describes where
  a role is defined, not who receives it.
  In Enterprise applications > your app > Properties, set Assignment required
  to Yes. Under Users and groups, assign one role to each approved user/group:
    AgentControl.Viewer  Observe inventory, reports and investigations.
    AgentControl.Admin   All viewing plus supported changes, imports and configuration.
  Admin includes Viewer access; only one role assignment is needed.
  Replace legacy role assignments explicitly; they do not grant these new roles.
  Sign out and back in after assignment. Provider permissions still apply.

Provider-side requirements still apply to the signed-in user:
  Inventory: one of Global Administrator, Power Platform Administrator, Dynamics 365
  Administrator, Global Reader, AI Administrator or AI Reader. AI roles are
  limited to AI-scoped resources.
  Quarantine: one of Global Administrator, AI Administrator or Power Platform Administrator.
  Purview: Audit Logs or View-Only Audit Logs access, with auditing enabled.
  Defender: Defender XDR RBAC and data-source access.
Applicable licensing is also required (including Microsoft Agent 365 for package
APIs). CSV report import and local application audit need no external API permission.
Consent alone does not enable unsupported operations or qualify provider writes.

This wizard displays guidance only; it does not verify or grant permissions.
See docs/deployment-setup.md and docs/provider-contract-inventory-2026-09-08.md
for setup details and capability-specific requirements.

'@
}

function Read-LocalIdentifier {
    param([string]$Prompt,[string]$Current,[switch]$AllowEmpty)
    if ($Current) { $Prompt += " [$Current; Enter to keep]" }
    elseif ($AllowEmpty) { $Prompt += ' [not configured; Enter to leave unset]' }
    while ($true) {
        $value = [string](Read-Host $Prompt)
        if ([string]::IsNullOrWhiteSpace($value)) {
            if ($Current -or $AllowEmpty) { return $Current }
            throw 'Configuration requires a tenant ID and client ID. Rerun start or edit-config in an interactive terminal to complete setup.'
        }
        $value = $value.Trim()
        if ($value -match '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') {
            if ($Current -and $value -ieq $Current) { return $Current }
            return $value
        }
        Write-Warning 'Enter an Entra GUID in the form xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.'
    }
}

function Read-LocalClientSecret {
    param([string]$Current,[switch]$AllowEmpty)
    $prompt = 'Entra client secret value (hidden input, not the secret ID)'
    if ($Current) { $prompt += ' [Enter to keep saved secret]' }
    elseif ($AllowEmpty) { $prompt += ' [not configured; Enter to leave unset]' }
    $secure = Read-Host $prompt -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim()
        if ([string]::IsNullOrWhiteSpace($value) -and ($Current -or $AllowEmpty)) { return $Current }
        if ([string]::IsNullOrWhiteSpace($value) -or $value -match '[\r\n]') { throw 'Configuration requires a non-empty, single-line client secret. Rerun start or edit-config in an interactive terminal to complete setup.' }
        return $value
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        if ($secure) { $secure.Dispose() }
    }
}

function Read-LocalPort {
    param([int]$Current)
    $default = if ($Current) { $Current } else { 3001 }
    while ($true) {
        $value = [string](Read-Host "Local port [$default; Enter to keep]")
        if ([string]::IsNullOrWhiteSpace($value)) { return $default }
        $port = 0
        if ([int]::TryParse($value.Trim(),[ref]$port) -and $port -ge 1024 -and $port -le 65535) { return $port }
        Write-Warning 'Enter a whole port number from 1024 to 65535.'
    }
}

function Write-LocalText {
    param([string]$Path,[string]$Value)
    if (-not (Test-Path -LiteralPath $Path) -or [IO.File]::ReadAllText($Path) -cne $Value) {
        [IO.File]::WriteAllText($Path,$Value)
    }
    Protect-LocalPath $Path
}

function Initialize-LocalState {
    param($Context,[bool]$ExistingVolume,[switch]$Onboard,[switch]$Edit)
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
    $settings = Read-LocalSettings $state
    $tenantId = ([string]$settings.tenantId).Trim()
    $clientId = ([string]$settings.clientId).Trim()
    $previousTenantId = $tenantId
    $previousClientId = $clientId
    $port = if ($settings.Contains('port')) { [int]$settings.port } else { 0 }
    $publicUrl = [string]$settings.publicUrl
    $settingsFile = Join-Path $state 'settings.json'
    foreach ($identifier in @($tenantId,$clientId)) { if ($identifier -and $identifier -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') { throw 'Saved tenant and client identifiers must be GUIDs. Restore the project settings; use a separate project for another tenant.' } }
    $clientFile = Join-Path $secretDirectory 'client-secret'
    $clientSecret = if (Test-Path -LiteralPath $clientFile) { [IO.File]::ReadAllText($clientFile).Trim() } else { '' }
    $previousSecret = $clientSecret
    $missingClientSecret = [string]::IsNullOrWhiteSpace($clientSecret)
    if ($Edit -or ($Onboard -and (-not $tenantId -or -not $clientId -or $missingClientSecret -or -not $port))) {
        Write-Host "Configure local project '$($Context.Project)'. Press Enter to keep saved values; secret input is hidden."
        Show-LocalRegistrationGuidance
        if ($Edit -or -not $tenantId) { $tenantId = Read-LocalIdentifier 'Entra tenant ID (directory GUID)' $tenantId -AllowEmpty:$Edit }
        if ($Edit -or -not $clientId) { $clientId = Read-LocalIdentifier 'Entra client ID (application GUID)' $clientId -AllowEmpty:$Edit }
        if ($Edit -or $missingClientSecret) { $clientSecret = Read-LocalClientSecret $clientSecret -AllowEmpty:$Edit }
        if ($Edit -or -not $port) { $port = Read-LocalPort $port }
        if ($Edit) { $publicUrl = Read-LocalPublicUrl $publicUrl $port }
        $origin = if ($publicUrl) { $publicUrl } else { "http://localhost:$port" }
        Write-Host "Register $origin/api/auth/callback as the application's Web reply URL. Begin sign-in at $origin."
    }
    if (-not $port) { throw 'Project port is missing. Run start or edit-config to complete the project wizard.' }
    if ($Edit -and $ExistingVolume -and $previousTenantId -and $previousTenantId -ine $tenantId) {
        throw 'This project has retained data for its saved tenant. Use a new project for another tenant; no configuration changes were saved.'
    }
    $tenantChanged = $previousTenantId -cne $tenantId
    $clientChanged = $previousClientId -cne $clientId
    $publicUrlChanged = [string]$settings.publicUrl -cne $publicUrl
    $settingsChanged = $tenantChanged -or $clientChanged -or $settings.port -ne $port -or $publicUrlChanged
    $secretChanged = $previousSecret -cne $clientSecret
    if (($Onboard -or $Edit) -and $settings.port -ne $port) { Assert-LocalPort $port }
    if ($Edit -and ($settingsChanged -or $secretChanged) -and $ExistingVolume) {
        if (-not (Test-Path -LiteralPath (Join-Path $state 'compose.env'))) { throw 'Existing project compose.env is missing. Run start to recover it before editing configuration.' }
        $controlDirectory = Join-Path $state 'control'
        [IO.Directory]::CreateDirectory($controlDirectory) | Out-Null
        Protect-LocalPath $controlDirectory -Directory
        Write-LocalText (Join-Path $controlDirectory 'maintenance') 'maintenance'
        Invoke-DockerCommand ($Context.Compose + @('stop','--timeout','130','app'))
        if ($previousClientId -and $previousClientId -ine $clientId) {
            Write-LocalText (Join-Path $controlDirectory 'reauthenticate') 'application-changed'
            Write-Host 'Application ID changed. Existing sessions will be cleared on the next start; users must sign in again.'
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
    if ($secretChanged -or (-not $Edit -and -not (Test-Path -LiteralPath $clientFile))) {
        Write-LocalText $clientFile $clientSecret
    }
    if (Test-Path -LiteralPath $clientFile) { Protect-LocalPath $clientFile }
    $userId = if ($IsWindows) { '1000' } else { (& id -u).Trim() }
    $groupId = if ($IsWindows) { '1000' } else { (& id -g).Trim() }
    if ($settingsChanged -or -not (Test-Path -LiteralPath $settingsFile)) {
        $settings.port = $port
        if ($tenantChanged) { $settings.tenantId = $tenantId }
        if ($clientChanged) { $settings.clientId = $clientId }
        if ($publicUrlChanged) { $settings.publicUrl = $publicUrl }
        Write-LocalText $settingsFile ($settings | ConvertTo-Json -Depth 20)
    }
    $Context.Port = $port
    $Context.Url = "http://localhost:$port"
    $Context.PublicUrl = if ($publicUrl) { $publicUrl } else { $Context.Url }
    $trustProxy = if ($publicUrl) { '1' } else { '0' }
    $lines = @("LOCAL_STATE_DIR='$state'","APP_PORT=$port","APP_UID=$userId","APP_GID=$groupId","APP_IMAGE=$($Context.Image)","TENANT_ID=$tenantId","CLIENT_ID=$clientId",
        "FRONTEND_ORIGIN=$($Context.PublicUrl)","REDIRECT_URI=$($Context.PublicUrl)/api/auth/callback","TRUST_PROXY=$trustProxy")
    Write-LocalText (Join-Path $state 'compose.env') (($lines -join [Environment]::NewLine) + [Environment]::NewLine)
    Protect-LocalPath $settingsFile
    Protect-LocalPath (Join-Path $state 'compose.env')
    if ($Edit) {
        if ($settingsChanged -or $secretChanged) { Write-Host "Configuration saved. Run deploy-local.ps1 start -Project $($Context.Project) to apply it." }
        else { Write-Host 'Configuration unchanged.' }
        if (-not $tenantId -or -not $clientId -or -not $clientSecret) {
            Write-Host 'Identity configuration is incomplete. start will ask for the missing values before launching the app.'
        }
    }
}

function Assert-LocalPort {
    param([int]$Port)
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$Port)
    try { $listener.Start() } catch { throw "Loopback port $Port is occupied. Free it or choose another port with edit-config and register its matching Entra callback." }
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
    param($Context,[string]$Action,[string]$BackupFile,[string]$RestoreDatabase,[string]$ConfirmCleanup,[int]$CleanupBatchSize=1000,[switch]$DryRun,[string]$ConfirmReset)
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
    if ($Action -notin @('Deploy','EditConfig') -and -not $existing) { throw 'Expected project volume is missing. Stop for recovery; use start for a new installation.' }
    Initialize-LocalState $Context $existing -Onboard:($Action -in @('Deploy','Start')) -Edit:($Action -eq 'EditConfig')
    if ($Action -eq 'EditConfig') { return }
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
    $reauthenticate = Join-Path $Context.State 'control/reauthenticate'
    if (Test-Path -LiteralPath $reauthenticate) {
        Write-LocalText $marker 'maintenance'
        if ($Action -eq 'Start') {
            Invoke-DockerCommand ($Context.Compose + @('stop','--timeout','130','app'))
            Invoke-DockerCommand ($Context.Compose + @('up','-d','--wait','--wait-timeout','90','postgres'))
        }
        Invoke-DockerCommand ($Context.Compose + @('exec','-T','postgres','psql','-U','agentcontrol_admin','-d','agentcontrol','-v','ON_ERROR_STOP=1','-c','DELETE FROM public.sessions;'))
        Remove-Item -LiteralPath $reauthenticate
    }
    if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
    try {
        Invoke-DockerCommand ($Context.Compose + @('up','-d','--no-build','--wait','--wait-timeout','90','app'))
        $health = Get-LocalHealth $Context.Url
        if (-not $health.authConfigured) { throw 'App sign-in configuration is missing despite saved onboarding settings. Check the project secret mounts and Compose configuration, then rerun start.' }
    } catch {
        [IO.File]::WriteAllText($marker,'maintenance')
        throw
    }
    Write-Host "Healthy local app: $($Context.Url)"
    if ($Context.PublicUrl -cne $Context.Url) {
        Write-Host "Open $($Context.PublicUrl) to sign in. Local health is verified; tunnel reachability is not checked."
        Show-LocalTunnelGuidance $Context.Port
    }
}