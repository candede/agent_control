using './main.bicep'

param location = 'approved-region'
param tenantId = '00000000-0000-0000-0000-000000000000'
param appRegistrationClientId = '00000000-0000-0000-0000-000000000000'
// Select the required tenant registry's immutable version; never paste its JSON value.
param tenantRegistrySecretName = 'agent-control-tenants-json'
param tenantRegistrySecretVersion = 'approved-version'
param appServicePlanName = 'approved-agent-control-plan'
param appServiceName = 'approved-agent-control-app'
param postgresServerName = 'approved-agent-control-postgres'
param canonicalOrigin = 'https://approved-agent-control-app.azurewebsites.net'
param redirectUri = 'https://approved-agent-control-app.azurewebsites.net/api/auth/callback'
param keyVaultSubscriptionId = '00000000-0000-0000-0000-000000000000'
param keyVaultResourceGroupName = 'approved-security-resource-group'
param keyVaultName = 'approved-vault-name'
param sessionSecretVersion = 'approved-version'
// This parameter-file function emits a native ARM reference, not a secret value.
param postgresAdminPassword = az.getSecret('00000000-0000-0000-0000-000000000000', 'approved-security-resource-group', 'approved-vault-name', 'agent-control-postgres-admin-password', 'approved-version')
param postgresAppPasswordSecretVersion = 'approved-version'
param approvedAppOutboundIpv4Addresses = []
param actionGroupResourceId = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/approved-monitoring-resource-group/providers/Microsoft.Insights/actionGroups/approved-operator-action-group'
param monthlyBudgetAmount = 1
param budgetStartDate = '2026-10-01'
param budgetEndDate = '2027-10-01'
param monitoringRetentionDays = 30
param monitoringDailyIngestionLimitGiB = '0.1'
