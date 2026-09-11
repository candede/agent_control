targetScope = 'resourceGroup'

@description('Existing administrator-prepared Key Vault. This module changes role assignments only.')
param vaultName string

@description('Exactly five runtime secret names; the administrator password is intentionally excluded.')
@minLength(5)
@maxLength(5)
param runtimeSecretNames array

@description('System-assigned App Service principal receiving per-secret read access.')
param appServicePrincipalId string

var keyVaultSecretsUserRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

resource runtimeSecrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = [for secretName in runtimeSecretNames: {
  parent: vault
  name: secretName
}]

resource runtimeSecretRoleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for index in range(0, length(runtimeSecretNames)): {
  name: guid(runtimeSecrets[index].id, appServicePrincipalId, keyVaultSecretsUserRoleDefinitionId)
  scope: runtimeSecrets[index]
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
    principalId: appServicePrincipalId
    principalType: 'ServicePrincipal'
  }
}]

output assignmentCount int = length(runtimeSecretRoleAssignments)
