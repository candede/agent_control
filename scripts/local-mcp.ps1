function Assert-LocalMcpSettings {
    param($Mcp,[int]$AppPort)
    $fields = @('tenantId','clientId','apiClientId','publicUrl','redirectUris','port')
    if ($Mcp -isnot [Collections.IDictionary] -or $Mcp.Count -ne $fields.Count -or
        @($Mcp.Keys | Where-Object { $_ -cnotin $fields }).Count) { throw 'MCP configuration must contain only tenantId, clientId, apiClientId, publicUrl, redirectUris and port.' }
    foreach ($name in @('tenantId','clientId','apiClientId')) {
        if ($Mcp[$name] -isnot [string] -or $Mcp[$name] -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') { throw 'MCP identities must be exact lowercase GUIDs.' }
    }
    if ($Mcp.clientId -ceq $Mcp.apiClientId) { throw 'MCP and API registrations must be distinct.' }
    if ($Mcp.port -isnot [int] -and $Mcp.port -isnot [long] -or $Mcp.port -lt 1024 -or $Mcp.port -gt 65535 -or $Mcp.port -eq $AppPort) { throw 'MCP requires a distinct loopback port from 1024 to 65535.' }
    $uri = $null
    if ($Mcp.publicUrl -isnot [string] -or -not [Uri]::TryCreate($Mcp.publicUrl,[UriKind]::Absolute,[ref]$uri) -or
        $uri.Scheme -cne 'https' -or -not (Test-LocalPublicUrl $uri.GetLeftPart([UriPartial]::Authority)) -or
        $uri.AbsoluteUri -cne $Mcp.publicUrl -or $uri.AbsolutePath -ceq '/' -or $uri.AbsolutePath.EndsWith('/') -or
        $uri.AbsolutePath -cin @('/health','/ready','/diagnostics','/authorize','/token','/consent','/auth/callback','/register','/revoke') -or
        $uri.AbsolutePath.StartsWith('/.well-known/') -or $uri.AbsolutePath.Contains('//') -or
        $uri.Query -or $uri.Fragment -or $Mcp.publicUrl -match "[%\\\s']") { throw 'MCP publicUrl must be one exact canonical HTTPS resource, separate from its internal API origin.' }
    if ($Mcp.redirectUris -isnot [array] -or $Mcp.redirectUris.Count -lt 1 -or $Mcp.redirectUris.Count -gt 32 -or
        @($Mcp.redirectUris | Sort-Object -Unique).Count -ne $Mcp.redirectUris.Count) { throw 'MCP requires 1-32 distinct exact client redirect URIs.' }
    foreach ($redirect in $Mcp.redirectUris) {
        $callback = $null
        if ($redirect -isnot [string] -or -not [Uri]::TryCreate($redirect,[UriKind]::Absolute,[ref]$callback) -or
            $callback.AbsoluteUri -cne $redirect -or $callback.UserInfo -or $callback.Query -or $callback.Fragment -or
            $redirect -match "[%\\\s'*]" -or
            ($callback.Scheme -cne 'https' -and -not ($callback.Scheme -ceq 'http' -and $callback.Host -cin @('localhost','127.0.0.1','[::1]')))) { throw 'MCP client callbacks must be exact canonical HTTPS or HTTP loopback URLs.' }
    }
}

function Assert-LocalMcpKey {
    param($Value)
    try {
        if ($Value -isnot [string] -or $Value -cnotmatch '^[A-Za-z0-9_-]{43}=$') { throw 'format' }
        $bytes = [Convert]::FromBase64String($Value.Replace('-','+').Replace('_','/'))
        if ($bytes.Length -ne 32 -or [Convert]::ToBase64String($bytes).Replace('+','-').Replace('/','_') -cne $Value) { throw 'encoding' }
    } catch { throw 'MCP keys must canonically encode 32 independent random bytes.' }
}

function Assert-LocalMcpSecretFile {
    param([string]$Path)
    if (-not [IO.Path]::IsPathRooted($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf) -or
        (Get-Item -LiteralPath $Path -Force).LinkType -or (Get-Item -LiteralPath $Path).Length -notin 1..8192) { throw 'MCP secret inputs must be existing absolute non-linked protected files (1-8192 bytes).' }
    if (-not $IsWindows -and ([int][IO.File]::GetUnixFileMode($Path) -band 63)) { throw 'MCP secret inputs must have 0600 permissions.' }
}

function Assert-LocalMcpSecretValues {
    param($Values,[string[]]$ApiSecrets=@())
    $clientSecret = $Values['mcp-client']
    $signing = $Values['mcp-signing']
    if ($clientSecret.Length -lt 16 -or [Text.Encoding]::UTF8.GetByteCount($clientSecret) -gt 8192 -or $clientSecret -match '[\r\n\0]') {
        throw 'MCP requires a single-line Entra client secret value of at least 16 characters and at most 8192 UTF-8 bytes.'
    }
    Assert-LocalMcpKey $signing
    try { $encryption = ConvertFrom-Json -InputObject $Values['mcp-encryption'] -NoEnumerate }
    catch { throw 'MCP encryption keys must be a JSON array.' }
    if ($encryption -isnot [array] -or $encryption.Count -lt 1 -or $encryption.Count -gt 3 -or
        @($encryption | Sort-Object -Unique).Count -ne $encryption.Count) { throw 'MCP requires a JSON ring of 1-3 independent encryption keys.' }
    foreach ($key in $encryption) { Assert-LocalMcpKey $key }
    if ($clientSecret -ceq $signing -or
        $clientSecret -cin $encryption -or $signing -cin $encryption) { throw 'MCP confidential, signing and encryption material must be independent.' }
    if ($clientSecret -cin $ApiSecrets -or $signing -cin $ApiSecrets -or @($encryption | Where-Object { $_ -cin $ApiSecrets }).Count) {
        throw 'MCP credentials and keys must not reuse an API tenant credential. Use the separate MCP Entra registration.'
    }
}

function Read-LocalMcpSettings {
    param($Settings,[object[]]$Profiles,$Current)
    if (-not $Profiles.Count -or @($Profiles | Where-Object { -not $_.tenantId -or -not $_.clientId -or -not $_.clientSecret -or -not $_.domains.Count }).Count) {
        throw 'Complete the API tenant setup before configuring MCP.'
    }
    Write-Host 'Configure MCP. Downstream clients register dynamically; the Entra application ID below identifies this server, not Claude/Copilot/OpenCode.'
    for ($index=0; $index -lt $Profiles.Count; $index++) {
        Write-Host "$($index+1): $($Profiles[$index].displayName) tenant=$($Profiles[$index].tenantId) API=$($Profiles[$index].clientId)"
    }
    $selected = 1
    for ($index=0; $index -lt $Profiles.Count; $index++) {
        if ($Profiles[$index].tenantId -ieq $Current.tenantId -and $Profiles[$index].clientId -ieq $Current.apiClientId) { $selected=$index+1 }
    }
    while ($true) {
        $answer = [string](Read-Host "API tenant profile [$selected; Enter to keep]")
        $choice = $selected
        if ([string]::IsNullOrWhiteSpace($answer) -or
            ([int]::TryParse($answer.Trim(),[ref]$choice) -and $choice -ge 1 -and $choice -le $Profiles.Count)) { break }
        Write-Warning 'Choose one of the listed API tenant profiles.'
    }
    $profile = $Profiles[$choice-1]
    $currentClient = if ($Current.clientId) { $Current.clientId } else { $profile.integration.clientId }
    $client = (Read-LocalIdentifier 'MCP Entra application ID (a separate confidential registration)' $currentClient).ToLowerInvariant()
    $url = [string](Read-Host "MCP public HTTPS resource URL [$($Current.publicUrl); Enter to keep]")
    if ([string]::IsNullOrWhiteSpace($url)) { $url = [string]$Current.publicUrl }
    $redirects = [string](Read-Host "Allowed client callback URLs, comma-separated [$(@($Current.redirectUris) -join ','); Enter to keep]")
    $redirectUris = if ([string]::IsNullOrWhiteSpace($redirects)) { @($Current.redirectUris) } else { @($redirects -split ',' | ForEach-Object { $_.Trim() }) }
    $port = if ($Current.port) { [int]$Current.port } elseif ($Settings.port -eq 8001) { 8002 } else { 8001 }
    return [ordered]@{
        tenantId=$profile.tenantId.ToLowerInvariant(); apiClientId=$profile.clientId.ToLowerInvariant(); clientId=$client
        publicUrl=$url.Trim(); redirectUris=@($redirectUris); port=(Read-LocalPort $port -Label 'MCP loopback port')
    }
}

function Get-LocalMcpPlan {
    param($Context,$Settings,[object[]]$Profiles)
    $mcp = $Settings.mcp
    $inputs = [ordered]@{}
    if ($Context.McpConfigInput) {
        $inputPath = [IO.Path]::GetFullPath($Context.McpConfigInput)
        if ((Get-Item -LiteralPath $inputPath -Force).LinkType) { throw 'MCP configuration input must not be a link.' }
        $supplied = [IO.File]::ReadAllText($inputPath) | ConvertFrom-Json -AsHashtable
        if ($supplied -isnot [Collections.IDictionary] -or
            @($supplied.Keys | Where-Object { $_ -cnotin @('tenantId','clientId','apiClientId','publicUrl','redirectUris','port','clientSecretFile','signingKeyFile','encryptionKeyFile') }).Count) { throw 'Unknown MCP configuration fields.' }
        $mcp = [ordered]@{}
        foreach ($name in @('tenantId','clientId','apiClientId','publicUrl','redirectUris','port')) { $mcp[$name] = $supplied[$name] }
        foreach ($pair in @(@('clientSecretFile','mcp-client'),@('signingKeyFile','mcp-signing'),@('encryptionKeyFile','mcp-encryption'))) {
            if ($supplied.Contains($pair[0])) {
                if ($supplied[$pair[0]] -isnot [string]) { throw 'MCP secret input paths must be absolute strings.' }
                $inputs[$pair[1]] = $supplied[$pair[0]]
            }
        }
    }
    if ($Context.ConfigureMcp) { $mcp = Read-LocalMcpSettings $Settings $Profiles $mcp }
    if ($null -eq $mcp) { return $null }
    Assert-LocalMcpSettings $mcp $Settings.port
    $binding = @($Profiles | Where-Object { $_.tenantId -ieq $mcp.tenantId -and $_.clientId -ieq $mcp.apiClientId })
    if ($binding.Count -ne 1) { throw 'MCP must explicitly match one existing tenant/API integration binding; no implicit tenant selection or registration is performed.' }
    $profile = $binding[0]
    $configure = $Context.ConfigureMcp -or [bool]$Context.McpConfigInput
    if ($profile.integration) {
        if ($profile.integration.clientId -ine $mcp.clientId -or $profile.integration.audience -ine $mcp.apiClientId -or
            $profile.integration.scope -cne 'AgentControl.Access') { throw 'MCP must explicitly match the saved tenant/API integration binding; another integration is not overwritten.' }
    } elseif (-not $configure) {
        throw 'MCP must explicitly match one existing tenant/API integration binding; run the explicit MCP setup wizard to configure it.'
    }
    if ($Context.ConfigureMcp -or ($Context.McpConfigInput -and -not $Settings.Contains('mcp'))) {
        $origin = ([Uri]$mcp.publicUrl).GetLeftPart([UriPartial]::Authority)
        Write-Host "MCP Entra Web reply URL: $origin/auth/callback"
        Write-Host "Expose MCP delegated scope: api://$($mcp.clientId)/Mcp.Access"
        Write-Host "MCP registration needs delegated API permission: api://$($mcp.apiClientId)/AgentControl.Access"
    }
    $values = [ordered]@{}
    foreach ($name in @('mcp-client','mcp-signing','mcp-encryption')) {
        $path = if ($inputs.Contains($name)) { $inputs[$name] } else { Join-Path $Context.State "secrets/$name" }
        if ($inputs.Contains($name) -or (Test-Path -LiteralPath $path)) {
            Assert-LocalMcpSecretFile $path
            $values[$name] = [IO.File]::ReadAllText($path).Trim()
        }
        $inputs[$name] = $path
    }
    if (@($inputs.Values | Sort-Object -Unique).Count -ne 3) { throw 'MCP secret input files must be independent.' }
    $missingKeys = @('mcp-signing','mcp-encryption') | Where-Object { -not $values.Contains($_) }
    if ($missingKeys.Count) {
        $retained = $Settings.Contains('mcp') -or @('mcp-storage.json','mcp-deployment.json','mcp-operation.json' |
            Where-Object { Test-Path -LiteralPath (Join-Path $Context.State $_) }).Count
        if (-not $configure -or $retained) { throw 'Existing MCP signing/encryption keys are missing. Restore the original protected state; keys are not regenerated.' }
        $volumes = (Invoke-DockerCommand @('volume','ls','--format','{{.Name}}') -Capture) -split "`n"
        if ($Context.McpVolume -in $volumes) { throw 'An existing MCP OAuth volume requires its original keys. Restore protected state; keys are not regenerated.' }
        foreach ($name in $missingKeys) {
            $key = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).Replace('+','-').Replace('/','_')
            $values[$name] = if ($name -eq 'mcp-encryption') { ConvertTo-Json -InputObject @($key) -Compress } else { $key }
        }
    }
    if ($Context.ConfigureMcp -or (-not $values.Contains('mcp-client') -and $configure)) {
        $values['mcp-client'] = Read-LocalClientSecret $values['mcp-client'] -Label 'MCP Entra client secret value (hidden input, not the secret ID)'
    }
    if (-not $values.Contains('mcp-client')) { throw 'MCP client credential is missing. Restore it or run -ConfigureMcp to supply the Entra credential securely.' }
    Assert-LocalMcpSecretValues $values -ApiSecrets @($Profiles | ForEach-Object { $_.clientSecret })
    if (-not $profile.integration) {
        $profile.integration = [ordered]@{ clientId=$mcp.clientId; audience=$profile.clientId; scope='AgentControl.Access' }
    }
    $changed = @($values.Keys | Where-Object {
        $destination = Join-Path $Context.State "secrets/$_"
        -not (Test-Path -LiteralPath $destination) -or [IO.File]::ReadAllText($destination).Trim() -cne $values[$_]
    }).Count -gt 0
    return @{ Settings=$mcp; Inputs=$inputs; SecretValues=$values; SecretsChanged=$changed }
}

function Sync-LocalMcpContext {
    param($Context,$Settings)
    $Context.Mcp = $Settings.mcp
    $Context.McpVolume = "$($Context.Project)_mcp-oauth"
    if (-not $Context.McpImage) { $Context.McpImage = "$($Context.Project)-mcp:local" }
    $baseIndex = [Array]::IndexOf($Context.Compose,'-f')
    $overlay = Join-Path (Split-Path $Context.Compose[$baseIndex+1] -Parent) 'compose.mcp.yaml'
    $compose = [Collections.Generic.List[string]]::new()
    for ($index=0; $index -lt $Context.Compose.Count; $index++) {
        if ($Context.Compose[$index] -eq '-f' -and [IO.Path]::GetFileName($Context.Compose[$index+1]) -ceq 'compose.mcp.yaml') { $index++; continue }
        $compose.Add($Context.Compose[$index])
    }
    if ($Context.Mcp) {
        $index = $compose.IndexOf('-f')
        $compose.InsertRange($index+2,[string[]]@('-f',$overlay))
    }
    $Context.Compose = $compose.ToArray()
}

function Save-LocalMcpConfiguration {
    param($Context,$Plan)
    if (-not $Plan) { return }
    foreach ($directory in @($Context.State,(Join-Path $Context.State 'secrets'),(Join-Path $Context.State 'mcp'))) {
        if ((Test-Path -LiteralPath $directory) -and (Get-Item -LiteralPath $directory -Force).LinkType) { throw 'MCP protected paths must not be symbolic links.' }
    }
    foreach ($name in $Plan.SecretValues.Keys) {
        $destination = Join-Path $Context.State "secrets/$name"
        if ((Test-Path -LiteralPath $destination) -and [IO.File]::ReadAllText($destination).Trim() -ceq $Plan.SecretValues[$name]) {
            Protect-LocalPath $destination
        } else { Write-LocalText $destination $Plan.SecretValues[$name] }
    }
}

function Get-LocalMcpRunArguments {
    param($Context)
    $uid = if ($IsWindows) { '1000' } else { (& id -u).Trim() }
    $gid = if ($IsWindows) { '1000' } else { (& id -g).Trim() }
    if ($uid -eq '0') { throw 'MCP requires a non-root operator UID matching its protected files.' }
    $arguments = @('--user',"${uid}:${gid}",'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--cpus','0.5','--pids-limit','128')
    foreach ($name in @('mcp-client','mcp-signing','mcp-encryption')) {
        $arguments += @('--mount',"type=bind,source=$($Context.State)/secrets/$name,target=/run/secrets/$name,readonly")
    }
    $arguments += @('--mount',"type=volume,source=$($Context.McpVolume),target=/var/lib/agent-control-mcp/oauth,volume-nocopy")
    $values = [ordered]@{
        MCP_TENANT_ID=$Context.Mcp.tenantId; MCP_CLIENT_ID=$Context.Mcp.clientId; MCP_API_CLIENT_ID=$Context.Mcp.apiClientId
        MCP_API_ORIGIN='http://app:3001'; MCP_PUBLIC_URL=$Context.Mcp.publicUrl
        MCP_ALLOWED_CLIENT_REDIRECT_URIS=(ConvertTo-Json -InputObject @($Context.Mcp.redirectUris) -Compress)
        MCP_CLIENT_SECRET_FILE='/run/secrets/mcp-client'; MCP_JWT_SIGNING_KEY_FILE='/run/secrets/mcp-signing'
        MCP_OAUTH_ENCRYPTION_KEY_FILE='/run/secrets/mcp-encryption'; MCP_OAUTH_STORAGE_PATH='/var/lib/agent-control-mcp/oauth'
    }
    foreach ($name in $values.Keys) { $arguments += @('--env',"$name=$($values[$name])") }
    return $arguments
}

function Build-LocalMcpArtifact {
    param($Context,$Snapshot,[string]$Target='runtime')
    $file = Join-Path $Snapshot.Directory "mcp-$Target.iid"
    $labels = if ($Context.SourceHash) { @('--label',"io.agent-control.source-sha256=$($Context.SourceHash)") } else { @() }
    Invoke-DockerCommand (@('build','--provenance=false','-f',(Join-Path $Snapshot.Root 'mcp/Dockerfile'),'--target',$Target,
        '--iidfile',$file,'-t',"$($Context.McpImage)$(if ($Target -ne 'runtime') {'-test'})") + $labels + @($Snapshot.Root))
    $identity = [IO.File]::ReadAllText($file).Trim()
    if ($identity -cnotmatch '^sha256:[a-f0-9]{64}$') { throw 'MCP build did not return an immutable image identity.' }
    return $identity
}

function Test-LocalMcpConfiguration {
    param($Context)
    if (-not $Context.Mcp) { return }
    Initialize-LocalMcpStorage $Context
    Invoke-DockerCommand (@('run','--rm','--network','none') + (Get-LocalMcpRunArguments $Context) +
        @('--entrypoint','python',$Context.McpImageId,'-c','from agent_control_mcp.config import Settings; from agent_control_mcp.storage import OAuthStore; OAuthStore(Settings.from_env())')) -Capture -CaptureError | Out-Null
}

function Initialize-LocalMcpStorage {
    param($Context)
    $names = (Invoke-DockerCommand @('volume','ls','--format','{{.Name}}') -Capture) -split "`n"
    $receiptPath = Join-Path $Context.State 'mcp-storage.json'
    $receipt = if (Test-Path -LiteralPath $receiptPath) { [IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json } else { $null }
    if ($Context.McpVolume -notin $names) {
        if ($receipt) { throw 'Recorded MCP state volume is missing; restore it, never silently recreate/reset OAuth connections.' }
        Invoke-DockerCommand @('volume','create','--label',"com.docker.compose.project=$($Context.Project)",'--label','com.docker.compose.volume=mcp-oauth',
            '--label','io.agent-control.purpose=encrypted-oauth-state',$Context.McpVolume) | Out-Null
    }
    $volume = Get-LocalMcpVolume $Context
    $uid = if ($IsWindows) { '1000' } else { (& id -u).Trim() }
    $gid = if ($IsWindows) { '1000' } else { (& id -g).Trim() }
    Invoke-DockerCommand @('run','--rm','--network','none','--user','0:0','--read-only','--cap-drop','ALL','--cap-add','CHOWN',
        '--cap-add','FOWNER','--security-opt','no-new-privileges','--memory','64m','--cpus','0.25','--pids-limit','16',
        '--mount',"type=volume,source=$($Context.McpVolume),target=/var/lib/agent-control-mcp/oauth,volume-nocopy",
        '--entrypoint','python',$Context.McpImageId,'-m','agent_control_mcp.initialize_storage',$uid,$gid) -Capture -CaptureError | Out-Null
    Write-LocalText $receiptPath (@{version=1;name=$volume.name;driver=$volume.driver;createdAt=$volume.createdAt} | ConvertTo-Json)
}

function Get-LocalMcpVolume {
    param($Context)
    $volume = Invoke-DockerCommand @('volume','inspect','--format',
        '{"name":{{json .Name}},"driver":{{json .Driver}},"createdAt":{{json .CreatedAt}},"labels":{{json .Labels}}}',$Context.McpVolume) -Capture | ConvertFrom-Json
    if ($volume.name -cne $Context.McpVolume -or $volume.driver -cne 'local' -or
        $volume.labels.'com.docker.compose.project' -cne $Context.Project -or
        $volume.labels.'com.docker.compose.volume' -cne 'mcp-oauth' -or
        $volume.labels.'io.agent-control.purpose' -cne 'encrypted-oauth-state') { throw 'MCP volume ownership/purpose differs.' }
    $receiptPath = Join-Path $Context.State 'mcp-storage.json'
    $receipt = if (Test-Path -LiteralPath $receiptPath) { [IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json } else { $null }
    if ($receipt -and ($receipt.version -ne 1 -or $receipt.name -cne $volume.name -or
        $receipt.createdAt -cne $volume.createdAt -or $receipt.driver -cne $volume.driver)) { throw 'Recorded MCP volume identity changed; restore exact state before retrying.' }
    return $volume
}

function Assert-LocalMcpContainer {
    param($Context,[string]$Id)
    $details = Invoke-DockerCommand @('inspect','--format',
        '{"mounts":{{json .Mounts}},"ports":{{json .HostConfig.PortBindings}},"networks":{{json .NetworkSettings.Networks}},"user":{{json .Config.User}}}',$Id) -Capture | ConvertFrom-Json -AsHashtable
    $expected = @{
        '/run/secrets/mcp-client'='secrets/mcp-client'; '/run/secrets/mcp-signing'='secrets/mcp-signing'
        '/run/secrets/mcp-encryption'='secrets/mcp-encryption'; '/var/lib/agent-control-mcp/oauth'=$Context.McpVolume
    }
    if ($details.mounts.Count -ne 4 -or $details.networks.Count -ne 1 -or -not $details.networks.Contains($Context.Network) -or
        $details.user -notmatch '^[1-9][0-9]*:[0-9]+$' -or $details.ports.Count -ne 1 -or $details.ports['8000/tcp'].Count -ne 1 -or
        $details.ports['8000/tcp'][0].HostIp -cne '127.0.0.1' -or
        ($Context.Mcp -and $details.ports['8000/tcp'][0].HostPort -cne [string]$Context.Mcp.port)) { throw 'MCP container user/network/loopback identity differs.' }
    foreach ($mount in $details.mounts) {
        if ($mount.Destination -ceq '/var/lib/agent-control-mcp/oauth') {
            if ($mount.Type -cne 'volume' -or $mount.Name -cne $Context.McpVolume -or -not $mount.RW) { throw 'MCP protected volume identity differs.' }
        } elseif (-not $expected.ContainsKey($mount.Destination) -or $mount.Type -cne 'bind' -or
            -not (Test-LocalBindSource $mount.Source (Join-Path $Context.State $expected[$mount.Destination])) -or
            $mount.RW) { throw 'MCP protected mount identity/access differs.' }
    }
    Get-LocalMcpVolume $Context | Out-Null
}

function Start-LocalMcp {
    param($Context)
    if (-not $Context.Mcp) { return }
    Test-LocalMcpConfiguration $Context
    $containers = @(Get-OwnedLocalContainers $Context | Where-Object Service -eq 'mcp')
    if ($containers.Count -gt 1) { throw 'Expected at most one exact MCP container.' }
    if (-not $containers.Count -or -not $containers[0].State.Running) { Assert-LocalPort $Context.Mcp.port }
    $key = [Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText((Join-Path $Context.State 'secrets/session')))
    $hmac = [Security.Cryptography.HMACSHA256]::new($key)
    try {
        $hashes = @('mcp-client','mcp-signing','mcp-encryption') | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $Context.State "secrets/$_")).Hash }
        $text = (@($Context.McpImageId,($Context.Mcp | ConvertTo-Json -Compress)) + $hashes) -join "`n"
        $identity = [Convert]::ToHexString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant()
    } finally { $hmac.Dispose(); [Array]::Clear($key,0,$key.Length) }
    $receiptPath = Join-Path $Context.State 'mcp-deployment.json'
    $receipt = if (Test-Path -LiteralPath $receiptPath) { [IO.File]::ReadAllText($receiptPath) | ConvertFrom-Json } else { $null }
    # Bind-mounted secret files are atomically replaced; recreate to see new inodes.
    $force = if (-not $receipt -or $receipt.identity -cne $identity) { @('--force-recreate') } else { @() }
    Write-LocalText (Join-Path $Context.State 'mcp-operation.json') (@{version=1;image=$Context.McpImageId;identity=$identity;step='prepared'} | ConvertTo-Json)
    Invoke-DockerCommand ($Context.Compose + @('up','-d','--no-build','--no-deps','--wait','--wait-timeout','90') + $force + @('mcp'))
    $running = @(Get-OwnedLocalContainers $Context | Where-Object Service -eq 'mcp')
    if ($running.Count -ne 1 -or $running[0].Image -cne $Context.McpImageId -or -not $running[0].State.Running -or
        $running[0].State.Health.Status -cne 'healthy') { throw 'MCP runtime identity/readiness differs.' }
    Invoke-DockerCommand @('exec',$running[0].Id,'python','-m','agent_control_mcp.healthcheck')
    $receipt = @{version=1;image=$Context.McpImageId;identity=$identity;step='verified'}
    Write-LocalText $receiptPath ($receipt | ConvertTo-Json)
    Write-LocalText (Join-Path $Context.State 'mcp-operation.json') ($receipt | ConvertTo-Json)
    Write-Host "[MCP READINESS] Local encrypted-state readiness verified; resource $($Context.Mcp.publicUrl). Public ingress and live OAuth are not asserted."
}

function Invoke-LocalMcpChecks {
    param($Context,$Snapshot,[string]$Image)
    if (-not $Context.Mcp) { return }
    if (-not $Image) { $Image = Build-LocalMcpArtifact $Context $Snapshot -Target test }
    if ($Image -cnotmatch '^sha256:[a-f0-9]{64}$') { throw 'MCP checks require an immutable image identity.' }
    $uid = if ($IsWindows) { '1000:1000' } else { "$((& id -u).Trim()):$((& id -g).Trim())" }
    $ids = $uid.Split(':')
    Invoke-DockerCommand @('run','--rm','--network','none','--user',$uid,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--memory','512m','--cpus','0.5','--pids-limit','128','--env','TMPDIR=/work','--tmpfs',"/work:rw,noexec,nosuid,size=64m,uid=$($ids[0]),gid=$($ids[1]),mode=0700",
        '--entrypoint','python',$Image,'-m','pytest','--basetemp=/work/tests','-p','no:cacheprovider','tests/test_config_storage.py','tests/test_oauth.py','tests/test_api_origin.py')
}
