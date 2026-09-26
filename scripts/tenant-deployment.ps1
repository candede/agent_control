function ConvertTo-DeploymentDomain {
    param($Value)
    if ($Value -isnot [string]) { return $null }
    $rawDomain = $Value.Trim()
    if ($rawDomain -cnotmatch '^[\p{L}\p{N}\p{M}.-]+$') { return $null }
    try { $domain = ([Globalization.IdnMapping]::new().GetAscii($rawDomain)).ToLowerInvariant() }
    catch { return $null }
    if ($domain.Length -gt 253 -or $domain -cnotmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$') { return $null }
    return $domain
}

function Assert-DeploymentTenantProfiles {
    param([object[]]$Profiles)
    if (-not $Profiles.Count) { throw 'Tenant registry must contain at least one tenant profile.' }
    $tenants = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $domains = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($profile in $Profiles) {
        if ($profile -isnot [Collections.IDictionary] -and $profile -isnot [PSCustomObject]) { throw 'Tenant registry entries must be objects.' }
        foreach ($name in @('tenantId','clientId')) {
            if ($profile.$name -isnot [string] -or $profile.$name -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') {
                throw 'Tenant registry tenantId and clientId must be GUIDs.'
            }
        }
        if ($profile.clientSecret -isnot [string] -or [string]::IsNullOrWhiteSpace($profile.clientSecret) -or $profile.clientSecret -match '[\r\n\0]') {
            throw 'Tenant registry requires a non-empty, single-line client secret for every tenant.'
        }
        if (-not $tenants.Add($profile.tenantId)) { throw 'Tenant registry contains a duplicate tenant ID.' }
        if ($profile.domains -isnot [array] -or -not $profile.domains.Count) { throw 'Every tenant requires at least one exact accepted sign-in domain.' }
        foreach ($value in $profile.domains) {
            $domain = ConvertTo-DeploymentDomain $value
            if (-not $domain) { throw 'Accepted domains must be exact organization domains, without URLs, usernames or wildcards.' }
            if (-not $domains.Add($domain)) { throw 'Tenant registry contains a duplicate accepted domain.' }
        }
        $hasDisplayName = if ($profile -is [Collections.IDictionary]) { $profile.Contains('displayName') } else { $null -ne $profile.PSObject.Properties['displayName'] }
        if ($hasDisplayName -and ($profile.displayName -isnot [string] -or [string]::IsNullOrWhiteSpace($profile.displayName) -or
            $profile.displayName.Length -gt 128 -or $profile.displayName -match '[\x00-\x1f\x7f]')) {
            throw 'Tenant display name must contain 1 to 128 printable characters when supplied.'
        }
    }
}

function ConvertFrom-DeploymentTenantRegistry {
    param([string]$Json)
    try { $document = [Text.Json.JsonDocument]::Parse($Json) }
    catch { throw 'Tenant registry must contain a valid JSON array; secret contents are not displayed.' }
    try {
        if ($document.RootElement.ValueKind -ne [Text.Json.JsonValueKind]::Array) { throw 'Tenant registry must contain a JSON array of profiles.' }
        $profiles = [Collections.Generic.List[object]]::new()
        foreach ($entry in $document.RootElement.EnumerateArray()) {
            if ($entry.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw 'Tenant registry entries must be objects.' }
            $profile = [ordered]@{}
            # Preserve strings and case-sensitive field names exactly as Node's JSON parser does.
            foreach ($name in @('tenantId','clientId','clientSecret')) {
                $property = [Text.Json.JsonElement]::new()
                if ($entry.TryGetProperty($name,[ref]$property)) {
                    $profile[$name] = if ($property.ValueKind -eq [Text.Json.JsonValueKind]::String) { $property.GetString() } else { $null }
                }
            }
            $property = [Text.Json.JsonElement]::new()
            $profile.domains = $null
            if ($entry.TryGetProperty('domains',[ref]$property) -and $property.ValueKind -eq [Text.Json.JsonValueKind]::Array) {
                $domains = [Collections.Generic.List[object]]::new()
                foreach ($domain in $property.EnumerateArray()) {
                    $domains.Add($(if ($domain.ValueKind -eq [Text.Json.JsonValueKind]::String) { $domain.GetString() } else { $null }))
                }
                $profile.domains = $domains.ToArray()
            }
            $property = [Text.Json.JsonElement]::new()
            if ($entry.TryGetProperty('displayName',[ref]$property)) {
                $profile.displayName = if ($property.ValueKind -eq [Text.Json.JsonValueKind]::String) { $property.GetString() } else { $null }
            }
            $profiles.Add($profile)
        }
        $result = $profiles.ToArray()
        Assert-DeploymentTenantProfiles $result
        return ,$result
    } finally { $document.Dispose() }
}
