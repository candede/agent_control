using './main.bicep'

param environmentName = 'dev'
param location = 'eastus2'
param namePrefix = 'agent-control'
param appRegistrationClientId = '<existing-entra-app-client-id>'
param keyVaultName = '<existing-key-vault-name>'
