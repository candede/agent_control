targetScope = 'resourceGroup'

@description('Non-secret exact MCP contract, validated by the existing Azure deployment owner.')
param mcp object
param location string
param vaultResourceId string
param logAnalyticsResourceId string
param actionGroupResourceId string
param tags object = {}

var vaultParts = split(vaultResourceId, '/')
var secretUri = 'https://${vaultParts[8]}${environment().suffixes.keyvaultDns}/secrets/'
var image = '${mcp.registryLoginServer}/${mcp.repository}@${mcp.imageDigest}'
var credentialNames = ['client', 'signing', 'encryption']
var credentialSettings = ['MCP_AZURE_CLIENT_SECRET', 'MCP_AZURE_JWT_SIGNING_KEY', 'MCP_AZURE_OAUTH_ENCRYPTION_KEY']
var credentials = [for (key, index) in credentialNames: {
  name: credentialSettings[index]
  value: '@Microsoft.KeyVault(SecretUri=${secretUri}${mcp.secrets[key].name}/${mcp.secrets[key].version})'
}]

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  scope: resourceGroup(split(mcp.identityResourceId, '/')[2], split(mcp.identityResourceId, '/')[4])
  name: last(split(mcp.identityResourceId, '/'))
}

resource plan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: mcp.planName
  location: location
  kind: 'linux'
  sku: { name: 'S1', tier: 'Standard', capacity: 1 }
  properties: { reserved: true, perSiteScaling: false }
  tags: union(tags, { app: 'agent-control-mcp' })
}

resource app 'Microsoft.Web/sites@2024-11-01' = {
  name: mcp.appServiceName
  location: location
  kind: 'app,linux,container'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${mcp.identityResourceId}': {} }
  }
  properties: {
    serverFarmId: plan.id
    keyVaultReferenceIdentity: mcp.identityResourceId
    virtualNetworkSubnetId: mcp.storage.subnetResourceId
    clientAffinityEnabled: false
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      vnetRouteAllEnabled: true
      alwaysOn: true
      numberOfWorkers: 1
      linuxFxVersion: 'DOCKER|${image}'
      acrUseManagedIdentityCreds: true
      acrUserManagedIdentityID: mcp.identityClientId
      ftpsState: 'Disabled'
      http20Enabled: true
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      remoteDebuggingEnabled: false
      autoHealEnabled: false
      healthCheckPath: '/ready'
      ipSecurityRestrictionsDefaultAction: 'Deny'
      ipSecurityRestrictions: [for (cidr, index) in mcp.network.inboundIpv4Cidrs: {
        ipAddress: cidr
        action: 'Allow'
        priority: 100 + index
        name: 'approved-${index}'
      }]
      scmIpSecurityRestrictionsUseMain: false
      scmIpSecurityRestrictionsDefaultAction: 'Deny'
      appSettings: concat([
        { name: 'WEBSITES_PORT', value: '8000' }
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
        { name: 'WEBSITES_CONTAINER_STOP_TIME_LIMIT', value: '75' }
        { name: 'WEBSITE_WARMUP_PATH', value: '/ready' }
        { name: 'WEBSITE_WARMUP_STATUSES', value: '200' }
        { name: 'MCP_SECRET_SOURCE', value: 'app-service-key-vault' }
        { name: 'MCP_TENANT_ID', value: mcp.tenantId }
        { name: 'MCP_CLIENT_ID', value: mcp.clientId }
        { name: 'MCP_API_CLIENT_ID', value: mcp.apiClientId }
        { name: 'MCP_API_ORIGIN', value: mcp.apiOrigin }
        { name: 'MCP_PUBLIC_URL', value: mcp.publicUrl }
        { name: 'MCP_ALLOWED_CLIENT_REDIRECT_URIS', value: string(mcp.redirectUris) }
        { name: 'MCP_AZURE_BLOB_ACCOUNT_URL', value: mcp.storage.accountUrl }
        { name: 'MCP_AZURE_BLOB_CONTAINER', value: mcp.storage.containerName }
        { name: 'MCP_AZURE_BLOB_NAME', value: mcp.storage.blobName }
        { name: 'MCP_AZURE_IDENTITY_CLIENT_ID', value: mcp.identityClientId }
      ], credentials)
    }
  }
  tags: union(tags, { app: 'agent-control-mcp', storageIdentity: mcp.storage.identity })
}

module vaultAccess './key-vault-access.bicep' = {
  name: '${mcp.appServiceName}-vault'
  scope: resourceGroup(vaultParts[2], vaultParts[4])
  params: {
    vaultName: vaultParts[8]
    runtimeSecretNames: [for key in credentialNames: mcp.secrets[key].name]
    appServicePrincipalId: identity.properties.principalId
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: app
  name: 'agent-control-mcp'
  properties: {
    workspaceId: logAnalyticsResourceId
    logAnalyticsDestinationType: 'Dedicated'
    logs: [{ category: 'AppServiceConsoleLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

var alerts = [
  { name: 'http-5xx', metric: 'Http5xx', operator: 'GreaterThanOrEqual', threshold: 5, aggregation: 'Total' }
  { name: 'health', metric: 'HealthCheckStatus', operator: 'LessThan', threshold: 100, aggregation: 'Average' }
  { name: 'latency', metric: 'AverageResponseTime', operator: 'GreaterThan', threshold: 2, aggregation: 'Average' }
  { name: 'memory', metric: 'MemoryWorkingSet', operator: 'GreaterThan', threshold: 805306368, aggregation: 'Average' }
]
resource alert 'Microsoft.Insights/metricAlerts@2018-03-01' = [for spec in alerts: {
  name: '${mcp.appServiceName}-${spec.name}'
  location: 'global'
  properties: {
    description: 'Independent MCP ${spec.name}; contain MCP only, preserve API/web.'
    severity: 1
    enabled: true
    scopes: [app.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [{
        name: spec.name
        metricNamespace: 'Microsoft.Web/sites'
        metricName: spec.metric
        operator: spec.operator
        threshold: spec.threshold
        timeAggregation: spec.aggregation
        criterionType: 'StaticThresholdCriterion'
      }]
    }
    actions: [{ actionGroupId: actionGroupResourceId }]
    autoMitigate: false
  }
}]

output appServiceResourceId string = app.id
output image string = image
output storageIdentity string = mcp.storage.identity
