targetScope = 'resourceGroup'

@description('Short environment name used in resource names and tags, such as dev, test, or prod.')
@minLength(2)
@maxLength(8)
param environmentName string

@description('Azure region for regional resources. Static Web Apps supports a subset of Azure regions; choose a supported SWA region.')
param location string = resourceGroup().location

@description('Globally unique resource name prefix. Use lowercase letters, numbers, and hyphens.')
@minLength(3)
@maxLength(18)
param namePrefix string

@description('Microsoft Entra tenant ID for the app registration.')
param tenantId string = tenant().tenantId

@description('Existing Microsoft Entra app registration client ID.')
param appRegistrationClientId string

@description('Existing RBAC-enabled Key Vault name that already contains the configured client and session secrets.')
param keyVaultName string

@description('Frontend origin. Leave empty to derive from the Static Web Apps default hostname.')
param frontendOrigin string = ''

@description('MSAL redirect URI. Leave empty to derive from the Static Web Apps default hostname.')
param redirectUri string = ''

@description('Linux runtime stack for the backend App Service. If Node 24 is unavailable in your region, deploy the backend as a custom container instead.')
param backendLinuxFxVersion string = 'NODE|24-lts'

@description('App Service Plan SKU name for the single-instance backend.')
param appServicePlanSkuName string = 'B1'

@description('App Service Plan SKU tier for the single-instance backend.')
param appServicePlanSkuTier string = 'Basic'

@description('Azure Static Web Apps SKU. Standard is required for linked App Service backends.')
@allowed([
  'Standard'
])
param staticWebAppSkuName string = 'Standard'

@description('Name of the Key Vault secret that stores the Entra app client secret.')
param clientSecretName string = 'agent-control-client-secret'

@description('Name of the Key Vault secret that stores the Express session secret.')
param sessionSecretName string = 'agent-control-session-secret'

@description('Optional resource tags.')
param tags object = {}

var normalizedPrefix = toLower(replace(namePrefix, '_', '-'))
var normalizedEnvironment = toLower(environmentName)
var resourceToken = take('${normalizedPrefix}-${normalizedEnvironment}', 32)
var staticWebAppName = take('${resourceToken}-swa', 40)
var appServicePlanName = take('${resourceToken}-plan', 40)
var backendAppName = take('${resourceToken}-api', 60)
var appInsightsName = take('${resourceToken}-appi', 255)
var resolvedFrontendOrigin = empty(frontendOrigin) ? 'https://${staticSite.properties.defaultHostname}' : frontendOrigin
var resolvedRedirectUri = empty(redirectUri) ? '${resolvedFrontendOrigin}/api/auth/callback' : redirectUri
var commonTags = union(tags, {
  app: 'agent-control'
  environment: normalizedEnvironment
})
var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

resource staticSite 'Microsoft.Web/staticSites@2025-03-01' = {
  name: staticWebAppName
  location: location
  sku: {
    name: staticWebAppSkuName
    tier: staticWebAppSkuName
  }
  properties: {
    allowConfigFileUpdates: true
    buildProperties: {
      appLocation: 'frontend'
      outputLocation: 'dist'
      apiLocation: ''
      skipGithubActionWorkflowGeneration: true
    }
    stagingEnvironmentPolicy: 'Disabled'
    publicNetworkAccess: 'Enabled'
  }
  tags: commonTags
}

resource appServicePlan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: appServicePlanName
  location: location
  kind: 'linux'
  sku: {
    name: appServicePlanSkuName
    tier: appServicePlanSkuTier
    capacity: 1
  }
  properties: {
    reserved: true
  }
  tags: commonTags
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
  tags: commonTags
}

resource backendApp 'Microsoft.Web/sites@2024-11-01' = {
  name: backendAppName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      linuxFxVersion: backendLinuxFxVersion
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appCommandLine: 'npm start --workspace backend'
    }
  }
  tags: commonTags
}

resource backendAppSettings 'Microsoft.Web/sites/config@2024-11-01' = {
  parent: backendApp
  name: 'appsettings'
  properties: {
    NODE_ENV: 'production'
    TENANT_ID: tenantId
    CLIENT_ID: appRegistrationClientId
    CLIENT_SECRET: '@Microsoft.KeyVault(VaultName=${keyVault.name};SecretName=${clientSecretName})'
    SESSION_SECRET: '@Microsoft.KeyVault(VaultName=${keyVault.name};SecretName=${sessionSecretName})'
    FRONTEND_ORIGIN: resolvedFrontendOrigin
    REDIRECT_URI: resolvedRedirectUri
    AGENT_CONTROL_DATA_DIR: '/home/data/agent-control'
    AUDIT_LOG_ENABLED: 'true'
    APPLICATIONINSIGHTS_CONNECTION_STRING: appInsights.properties.ConnectionString
    SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'
  }
}

resource keyVaultSecretsUserAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, backendApp.id, keyVaultSecretsUserRoleDefinitionId)
  scope: keyVault
  properties: {
    principalId: backendApp.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
  }
}

resource linkedBackend 'Microsoft.Web/staticSites/linkedBackends@2025-03-01' = {
  parent: staticSite
  name: backendApp.name
  properties: {
    backendResourceId: backendApp.id
    region: location
  }
}

output staticWebAppName string = staticSite.name
output staticWebAppDefaultHostname string = staticSite.properties.defaultHostname
output staticWebAppUrl string = 'https://${staticSite.properties.defaultHostname}'
output backendAppName string = backendApp.name
output backendAppUrl string = 'https://${backendApp.properties.defaultHostName}'
output keyVaultName string = keyVaultName
output appInsightsName string = appInsights.name
output redirectUri string = resolvedRedirectUri
output frontendOrigin string = resolvedFrontendOrigin
output clientSecretName string = clientSecretName
output sessionSecretName string = sessionSecretName
