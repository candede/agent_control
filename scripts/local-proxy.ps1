function Test-LocalProxyNetworkName {
    param($Value)
    return ($Value -is [string] -and $Value -cmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$' -and
        $Value -cnotin @('bridge','host','none'))
}

function Assert-LocalProxyNetwork {
    param($Context,[string]$Name)
    if (-not (Test-LocalProxyNetworkName $Name) -or $Name -ceq $Context.Network) {
        throw 'ProxyNetwork must name a dedicated external shared bridge, not a built-in or project-private network.'
    }
    try {
        $network = Invoke-DockerCommand @('network','inspect','--format','{{json .}}',$Name) -Capture -CaptureError | ConvertFrom-Json -AsHashtable
    } catch { throw "Shared proxy network '$Name' is missing or cannot be inspected. Infrastructure must create it first; Agent Control never creates or manages it." }
    if ($network.Name -cne $Name -or $network.Id -cnotmatch '^[a-f0-9]{64}$' -or
        $network.Driver -cne 'bridge' -or $network.Scope -cne 'local' -or
        $network.Internal -cne $false -or $network.Ingress -cne $false -or $network.ConfigOnly -cne $false -or
        $network.Labels.'io.shared-proxy.managed' -cne 'true' -or
        -not $network.Labels.'io.shared-proxy.instance' -or -not $network.Labels.'io.shared-proxy.owner' -or
        @($network.Labels.Keys | Where-Object { $_ -match '^com\.docker\.(compose|stack)\.' }).Count -or
        $network.Options.'com.docker.network.bridge.default_bridge' -ceq 'true' -or
        $network.Options.'com.docker.network.bridge.enable_icc' -ceq 'false') {
        throw "Shared proxy network '$Name' is foreign or unsafe. Require an external local bridge with io.shared-proxy.managed=true, instance and owner labels, and no Compose/stack ownership."
    }
    foreach ($id in @($network.Containers.Keys)) {
        $endpoint = Invoke-DockerCommand @('inspect','--format',
            '{"labels":{{json .Config.Labels}},"networks":{{json .NetworkSettings.Networks}}}',$id) -Capture | ConvertFrom-Json -AsHashtable
        $labels = $endpoint.labels
        if ($labels.'com.docker.compose.project' -ceq $Context.Project -and $labels.'com.docker.compose.service' -ceq 'postgres') {
            throw 'PostgreSQL is already exposed on shared ingress. Stop for operator recovery; deployment will not disconnect or change it.'
        }
        foreach ($service in @('app','mcp')) {
            if ("$($Context.Project)-$service" -cin $endpoint.networks[$Name].Aliases -and
                ($labels.'com.docker.compose.project' -cne $Context.Project -or
                $labels.'com.docker.compose.project.working_dir' -cne $Context.Root -or
                $labels.'com.docker.compose.service' -cne $service)) { throw 'A shared ingress DNS alias belongs to another installation; deployment refused.' }
        }
    }
    return $network.Id
}

function Sync-LocalProxyContext {
    param($Context,$Settings)
    $Context.ProxyNetwork = [string]$Settings.proxyNetwork
    $compose = [Collections.Generic.List[string]]::new()
    for ($index=0; $index -lt $Context.Compose.Count; $index++) {
        if ($Context.Compose[$index] -eq '-f' -and
            [IO.Path]::GetFileName($Context.Compose[$index+1]) -cin @('compose.proxy.yaml','compose.mcp-proxy.yaml')) { $index++; continue }
        $compose.Add($Context.Compose[$index])
    }
    if ($Context.ProxyNetwork) {
        $baseIndex = $compose.IndexOf('-f')
        $root = Split-Path $compose[$baseIndex+1] -Parent
        $projectIndex = $compose.IndexOf('-p')
        $overlays = @('-f',(Join-Path $root 'compose.proxy.yaml'))
        if ($Context.Mcp) { $overlays += @('-f',(Join-Path $root 'compose.mcp-proxy.yaml')) }
        $compose.InsertRange($projectIndex,[string[]]$overlays)
    }
    $Context.Compose = $compose.ToArray()
}

function Get-LocalDatabaseCompose {
    param([string[]]$Compose)
    for ($index=0; $index -lt $Compose.Count; $index++) {
        if ($Compose[$index] -eq '-f' -and [IO.Path]::GetFileName($Compose[$index+1]) -cin
            @('compose.mcp.yaml','compose.mcp-metadata.yaml','compose.proxy.yaml','compose.mcp-proxy.yaml')) { $index++; continue }
        $Compose[$index]
    }
}

function Assert-LocalContainerNetworks {
    param($Context,$Networks,[ValidateSet('app','mcp','postgres')][string]$Service,[switch]$AllowRetainedIngress)
    if ($Networks -isnot [Collections.IDictionary] -or -not $Networks.Contains($Context.Network)) {
        throw 'Container must retain its project-private network.'
    }
    $extra = @($Networks.Keys | Where-Object { $_ -cne $Context.Network })
    if ($Service -eq 'postgres') {
        if ($extra.Count) { throw 'PostgreSQL must never join shared ingress or any other network.' }
        return
    }
    if ($extra.Count -gt 1) { throw 'Unexpected container network inventory.' }
    if ($AllowRetainedIngress) {
        if (-not $extra.Count) { return }
        Assert-LocalProxyNetwork $Context $extra[0] | Out-Null
    } elseif ($extra.Count -ne [int][bool]$Context.ProxyNetwork -or
        ($extra.Count -and $extra[0] -cne $Context.ProxyNetwork)) { throw 'Container shared ingress differs from saved configuration.' }
    if ($extra.Count -and "$($Context.Project)-$Service" -cnotin $Networks[$extra[0]].Aliases) {
        throw 'Container shared ingress requires its project-derived DNS alias.'
    }
}

function Assert-LocalIngressReady {
    param($Context)
    if (-not $Context.ProxyNetwork) { return }
    $identity = Assert-LocalProxyNetwork $Context $Context.ProxyNetwork
    if ($Context.ProxyNetworkId -and $Context.ProxyNetworkId -cne $identity) {
        throw 'Shared proxy network identity changed during deployment; retry before changing the application.'
    }
    $Context.ProxyNetworkId = $identity
}

function Assert-LocalApplicationIngress {
    param($Context,[string]$Id)
    if (-not $Context.ProxyNetwork -and -not $Context.ContainsKey('ProxyNetworkInput')) { return }
    $networks = Invoke-DockerCommand @('inspect','--format','{{json .NetworkSettings.Networks}}',$Id) -Capture | ConvertFrom-Json -AsHashtable
    Assert-LocalContainerNetworks $Context $networks 'app'
}
