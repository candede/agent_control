targetScope = 'resourceGroup'

@description('Approved Azure region for every newly created resource.')
param location string

@description('Exact approved Microsoft Entra tenant ID.')
param tenantId string

@description('Exact existing Microsoft Entra application/client ID. Registration changes are verified outside ARM.')
param appRegistrationClientId string

@description('Exact resource names approved by the operator.')
param appServicePlanName string
param appServiceName string
param postgresServerName string

@description('Canonical one-origin HTTPS URL and callback.')
param canonicalOrigin string
param redirectUri string

@description('Existing prepared Key Vault identity. The template never creates or modifies the vault or its values.')
param keyVaultSubscriptionId string
param keyVaultResourceGroupName string
param keyVaultName string

@description('Selected immutable versions for all six prepared secrets. Versions are non-secret receipt evidence.')
param tenantIdSecretVersion string
param clientIdSecretVersion string
param clientSecretVersion string
param sessionSecretVersion string
param postgresAdminPasswordSecretVersion string
param postgresAppPasswordSecretVersion string

@description('Exact approved App Service outbound IPv4 addresses. Empty means no database firewall access.')
param approvedAppOutboundIpv4Addresses array = []

@description('Existing action group used for release and budget alerts.')
param actionGroupResourceId string

@description('Approved monthly budget and bounded monitoring configuration.')
@minValue(1)
param monthlyBudgetAmount int
param budgetStartDate string
param budgetEndDate string
@allowed([30])
param monitoringRetentionDays int = 30
@allowed(['0.1'])
param monitoringDailyIngestionLimitGiB string = '0.1'

@description('Optional approved resource tags without secret values.')
param tags object = {}

var secretNames = {
  tenantId: 'agent-control-tenant-id'
  clientId: 'agent-control-client-id'
  clientSecret: 'agent-control-client-secret'
  sessionSecret: 'agent-control-session-secret'
  postgresAdminPassword: 'agent-control-postgres-admin-password'
  postgresAppPassword: 'agent-control-postgres-app-password'
}
var runtimeSecrets = [
  {
    name: secretNames.tenantId
    version: tenantIdSecretVersion
  }
  {
    name: secretNames.clientId
    version: clientIdSecretVersion
  }
  {
    name: secretNames.clientSecret
    version: clientSecretVersion
  }
  {
    name: secretNames.sessionSecret
    version: sessionSecretVersion
  }
  {
    name: secretNames.postgresAppPassword
    version: postgresAppPasswordSecretVersion
  }
]
var runtimeSecretSettingNames = [
  'TENANT_ID'
  'CLIENT_ID'
  'CLIENT_SECRET'
  'SESSION_SECRET'
  'PGPASSWORD'
]
var commonTags = union(tags, {
  app: 'agent-control'
  topology: 'single-app-managed-postgresql'
  approvedTenant: tenantId
  approvedApplication: appRegistrationClientId
})
var keyVaultUri = 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/'
var runtimeAppSettings = [for (secret, index) in runtimeSecrets: {
  name: runtimeSecretSettingNames[index]
  value: '@Microsoft.KeyVault(SecretUri=${keyVaultUri}secrets/${secret.name}/${secret.version})'
}]

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  scope: resourceGroup(keyVaultSubscriptionId, keyVaultResourceGroupName)
  name: keyVaultName
}

resource appServicePlan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: appServicePlanName
  location: location
  kind: 'linux'
  sku: {
    name: 'B1'
    tier: 'Basic'
    capacity: 1
  }
  properties: {
    reserved: true
    perSiteScaling: false
  }
  tags: commonTags
}

module postgres './postgres.bicep' = {
  name: 'agent-control-postgresql'
  params: {
    location: location
    serverName: postgresServerName
    administratorPassword: keyVault.getSecret(secretNames.postgresAdminPassword, postgresAdminPasswordSecretVersion)
    approvedAppOutboundIpv4Addresses: approvedAppOutboundIpv4Addresses
    tags: commonTags
  }
}

resource appService 'Microsoft.Web/sites@2024-11-01' = {
  name: appServiceName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    clientAffinityEnabled: false
    clientCertEnabled: false
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      alwaysOn: true
      linuxFxVersion: 'NODE|24-lts'
      numberOfWorkers: 1
      ftpsState: 'Disabled'
      http20Enabled: true
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      remoteDebuggingEnabled: false
      healthCheckPath: '/api/ready'
      appSettings: concat([
        {
          name: 'NODE_ENV'
          value: 'production'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~24'
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'false'
        }
        {
          name: 'ENABLE_ORYX_BUILD'
          value: 'false'
        }
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: '1'
        }
        {
          name: 'FRONTEND_ORIGIN'
          value: canonicalOrigin
        }
        {
          name: 'REDIRECT_URI'
          value: redirectUri
        }
        {
          name: 'PGHOST'
          value: postgres.outputs.fullyQualifiedDomainName
        }
        {
          name: 'PGPORT'
          value: '5432'
        }
        {
          name: 'PGDATABASE'
          value: 'agentcontrol'
        }
        {
          name: 'PGUSER'
          value: 'agentcontrol_app'
        }
        {
          name: 'PGSSLMODE'
          value: 'verify-full'
        }
        {
          name: 'PGPOOL_MAX'
          value: '4'
        }
        {
          name: 'MAINTENANCE_MODE'
          value: 'true'
        }
      ], runtimeAppSettings)
    }
  }
  tags: commonTags
}

module keyVaultRuntimeAccess './key-vault-access.bicep' = {
  name: 'agent-control-key-vault-runtime-access'
  scope: resourceGroup(keyVaultSubscriptionId, keyVaultResourceGroupName)
  params: {
    vaultName: keyVaultName
    runtimeSecretNames: [for secret in runtimeSecrets: secret.name]
    appServicePrincipalId: appService.identity.principalId
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: take('${appServiceName}-logs', 63)
  location: location
  properties: {
    retentionInDays: monitoringRetentionDays
    workspaceCapping: {
      dailyQuotaGb: json(monitoringDailyIngestionLimitGiB)
    }
    sku: {
      name: 'PerGB2018'
    }
  }
  tags: commonTags
}

resource appDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: appService
  name: 'agent-control-app'
  properties: {
    workspaceId: logAnalytics.id
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      {
        category: 'AppServiceConsoleLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: postgresServerName
}

resource postgresDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: postgresServer
  name: 'agent-control-postgresql'
  properties: {
    workspaceId: logAnalytics.id
    logs: []
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
  dependsOn: [postgres]
}

resource appHttp5xxAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${appServiceName}-http-5xx'
  location: 'global'
  properties: {
    description: 'Agent Control returned at least five HTTP 5xx responses in five minutes.'
    severity: 1
    enabled: true
    scopes: [appService.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'Http5xx'
          metricNamespace: 'Microsoft.Web/sites'
          metricName: 'Http5xx'
          operator: 'GreaterThanOrEqual'
          threshold: 5
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroupResourceId }]
    autoMitigate: false
  }
}

resource appHealthCheckAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${appServiceName}-health-check'
  location: 'global'
  properties: {
    description: 'Agent Control readiness health was below 100 percent for five minutes, including silent application failures.'
    severity: 1
    enabled: true
    scopes: [appService.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'HealthCheckStatus'
          metricNamespace: 'Microsoft.Web/sites'
          metricName: 'HealthCheckStatus'
          operator: 'LessThan'
          threshold: 100
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroupResourceId }]
    autoMitigate: false
  }
}

resource appLatencyAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${appServiceName}-latency'
  location: 'global'
  properties: {
    description: 'Agent Control average response time exceeded the two-second operating threshold.'
    severity: 2
    enabled: true
    scopes: [appService.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'AverageResponseTime'
          metricNamespace: 'Microsoft.Web/sites'
          metricName: 'AverageResponseTime'
          operator: 'GreaterThan'
          threshold: 2
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroupResourceId }]
    autoMitigate: false
  }
}

resource postgresStorageAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${postgresServerName}-storage'
  location: 'global'
  properties: {
    description: 'Agent Control PostgreSQL storage exceeded 80 percent.'
    severity: 1
    enabled: true
    scopes: [postgres.outputs.serverResourceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'StoragePercent'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          metricName: 'storage_percent'
          operator: 'GreaterThan'
          threshold: 80
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroupResourceId }]
    autoMitigate: false
  }
}

resource postgresCreditsAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${postgresServerName}-cpu-credits'
  location: 'global'
  properties: {
    description: 'Burstable CPU credits remaining fell below 20.'
    severity: 1
    enabled: true
    scopes: [postgres.outputs.serverResourceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'CpuCreditsRemaining'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          metricName: 'cpu_credits_remaining'
          operator: 'LessThan'
          threshold: 20
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroupResourceId }]
    autoMitigate: false
  }
}

resource postgresBackupStorageCostAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${postgresServerName}-backup-storage-cost'
  location: 'global'
  properties: {
    description: 'Backup storage usage exceeded 32 GiB and requires cost review; this metric is not backup-health evidence.'
    severity: 2
    enabled: true
    scopes: [postgres.outputs.serverResourceId]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT30M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'BackupStorageUsed'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          metricName: 'backup_storage_used'
          operator: 'GreaterThan'
          threshold: 34359738368
          timeAggregation: 'Maximum'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [{ actionGroupId: actionGroupResourceId }]
    autoMitigate: false
  }
}

resource runtimeRestartAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${appServiceName}-restarts'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'Agent Control repeated runtime starts'
    description: 'More than two bounded listening events in fifteen minutes indicates restarts.'
    severity: 2
    enabled: true
    scopes: [logAnalytics.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'AppServiceConsoleLogs | extend AgentControlEvent = tostring(parse_json(ResultDescription).event) | where AgentControlEvent == "listening"'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 2
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroupResourceId]
    }
    autoMitigate: false
    checkWorkspaceAlertsStorageConfigured: false
    skipQueryValidation: false
  }
}

resource providerFailureAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${appServiceName}-provider-failures'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'Agent Control provider failures'
    description: 'At least five redacted provider throttling/schema/failure events in five minutes.'
    severity: 2
    enabled: true
    scopes: [logAnalytics.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: 'AppServiceConsoleLogs | extend AgentControlEvent = tostring(parse_json(ResultDescription).event) | where AgentControlEvent in ("provider_throttled", "provider_schema_omission", "request_error")'
          timeAggregation: 'Count'
          operator: 'GreaterThanOrEqual'
          threshold: 5
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroupResourceId]
    }
    autoMitigate: false
    checkWorkspaceAlertsStorageConfigured: false
    skipQueryValidation: false
  }
}

resource safetyIncidentAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${appServiceName}-safety-incidents'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'Agent Control execution or cleanup safety incident'
    description: 'One redacted finite-deadline worker, uncertain write, pool, session-store or cleanup event requires review without replay.'
    severity: 1
    enabled: true
    scopes: [logAnalytics.id]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      allOf: [
        {
          query: 'AppServiceConsoleLogs | extend AgentControlEvent = tostring(parse_json(ResultDescription).event) | where AgentControlEvent in ("job_execution_stopped", "quarantine_job_stopped", "job_write_uncertain", "quarantine_write_uncertain", "official_usage_upload_cleanup_failed", "database_pool_error", "database_pool_saturated", "session_store_error")'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [actionGroupResourceId]
    }
    autoMitigate: false
    checkWorkspaceAlertsStorageConfigured: false
    skipQueryValidation: false
  }
}

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: '${appServiceName}-monthly-budget'
  properties: {
    amount: monthlyBudgetAmount
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
      endDate: budgetEndDate
    }
    notifications: {
      Forecasted100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: []
        contactGroups: [actionGroupResourceId]
        contactRoles: []
      }
      Actual80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: []
        contactGroups: [actionGroupResourceId]
        contactRoles: []
      }
    }
  }
}

output appServiceResourceId string = appService.id
output appServicePlanResourceId string = appServicePlan.id
output postgresServerResourceId string = postgres.outputs.serverResourceId
output postgresFullyQualifiedDomainName string = postgres.outputs.fullyQualifiedDomainName
output databaseName string = 'agentcontrol'
output appUrl string = canonicalOrigin
output runtimeNodeMajor int = 24
output appServiceSku string = 'B1'
output postgresSku string = 'Standard_B1ms'
output postgresStorageGiB int = 32
output postgresBackupRetentionDays int = 7
output monitoringWorkspaceResourceId string = logAnalytics.id
