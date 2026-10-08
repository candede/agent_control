import { spawnSync, type SpawnSyncOptionsWithBufferEncoding, type SpawnSyncReturns } from "node:child_process";
import { pathToFileURL } from "node:url";
import { browserFixtureTestFiles } from "./fixtureSupport.js";

const appSessionFiles = ["src/App.session.test.tsx", "src/App.inventory.test.tsx", "src/App.commands.test.tsx"];

export function fixtureCommands(suite: string): string[][] {
  if (suite === "production-frontend") return [
    ["run", "test", "--workspace", "frontend"],
  ];
  if (suite === "lifecycle-publication-contract") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/publishedInventoryLifecycle.test.ts",
      "scripts/databasePreflight.test.ts", "scripts/databaseReset.test.ts", "src/db/packageInventoryUnifiedSource.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "lifecycle-read-contract") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/selectedLifecycle.test.ts", "src/db/publishedInventoryLifecycle.test.ts",
      "scripts/databasePreflight.test.ts", "scripts/databaseReset.test.ts", "src/db/dataGenerations.test.ts", "src/db/inventoryGenerations.test.ts",
      "src/db/schema.test.ts", "src/services/largeTenantUserSources.test.ts", "scripts/database.test.ts",
      "src/services/dataSelections.test.ts", "src/services/dataExports.test.ts", "src/services/inventoryExports.test.ts",
      "src/services/inventoryReconciliation.test.ts", "src/db/packageInventoryUnifiedSource.test.ts",
      "src/services/largeTenantUsersReports.test.ts", "src/db/officialUsageHistorySelection.test.ts",
      "src/db/dataRetention.test.ts", "src/routes/largeTenantInventory.test.ts",
      "src/db/packageControlState.test.ts", "src/db/copilotStudioQuarantine.test.ts",
      "src/db/automaticRevisions.unit.test.ts", "src/services/officialReportQuery.test.ts", "scripts/largeTenantFixture.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "production-publication") return [
    ["run","test","--workspace","backend","--","src/db/inventoryGenerations.test.ts",
      "src/services/automaticRefreshIntegration.test.ts","src/services/packageInventory.test.ts","src/services/powerPlatformInventory.test.ts"],
    ["run","typecheck","--workspace","backend"],
  ];
  if (suite === "production-gate-repairs") return [
    ["run","test","--workspace","backend","--","scripts/recordPersistence.test.ts",
      "src/db/inventoryCutoverSchema.test.ts","src/db/inventoryProviderSchema.test.ts",
      "src/db/unifiedAgentsIntegration.test.ts","src/services/automaticRefreshIntegration.test.ts",
      "src/services/officialReportReads.test.ts","src/services/providerJson.test.ts",
      "src/services/inventoryProjectionMetadata.test.ts","src/db/inventoryGenerations.test.ts",
      "src/services/packageInventory.test.ts","src/services/powerPlatformInventory.test.ts",
      "src/db/publishedInventoryLifecycle.test.ts","src/db/powerPlatformInventory.test.ts","src/db/dataSync.test.ts",
      "src/services/copilotUsage.test.ts","src/routes/dataPages.test.ts","src/services/officialUsageViews.test.ts",
      "scripts/dataSyncPersistence.test.ts","src/db/agentControlIdentity.test.ts","src/db/packageInventory.test.ts",
      "src/db/savedAgentPeople.test.ts","src/routes/policy.test.ts","src/services/capabilityArtifacts.test.ts",
      "scripts/largeTenantCapacity.test.ts","scripts/largeTenantFixture.test.ts"],
    ["run","typecheck","--workspace","backend"],
  ];
  if (suite === "production-counts") return [
    ["run","test","--workspace","backend","--","src/db/reportMembershipCounts.test.ts","scripts/backup.test.ts","scripts/largeTenantRestore.test.ts"],
    ["run","typecheck","--workspace","backend"],
  ];
  if (suite === "production-gate-cost") return [
    ["run","test","--workspace","backend","--","src/db/agentIdentity.test.ts","src/db/powerPlatformInventory.test.ts"],
  ];
  if (suite === "production-prerequisites") return [
    ["run","test","--workspace","backend","--","src/db/reportMembershipCounts.test.ts",
      "src/db/schema.test.ts","scripts/database.test.ts","scripts/backup.test.ts","scripts/largeTenantRestore.test.ts",
      "src/db/officialUsageHistorySelection.test.ts","src/services/largeTenantUsersReports.test.ts",
      "src/db/inventoryGenerations.test.ts","scripts/largeTenantCapacity.test.ts","scripts/largeTenantFixture.test.ts"],
    ["run","typecheck","--workspace","backend"],
  ];
  if (suite === "capacity-core") return [
    ["run","test","--workspace","backend","--","src/db/schema.test.ts","src/db/inventoryGenerations.test.ts",
      "src/db/dataGenerations.test.ts","src/db/dataRetention.test.ts","src/services/dataSelections.test.ts","src/db/childInsertFence.test.ts","src/db/reportMembershipCounts.test.ts",
      "scripts/largeTenantCapacity.test.ts","scripts/largeTenantFixture.test.ts"],
    ["run","typecheck","--workspace","backend"],
  ];
  if (suite === "capacity-software") return fixtureCommands("all");
  if (suite === "capacity-cost") return [
    ["run","test","--workspace","backend","--","src/db/unifiedAgentsIntegration.test.ts",
      "src/db/powerPlatformInventory.test.ts","src/db/dataGenerations.test.ts",
      "src/services/inventoryReconciliation.test.ts","src/db/dataRetention.test.ts",
      "src/services/inventoryExports.test.ts"],
    ["run","typecheck","--workspace","backend"],
  ];
  if (suite === "capacity-schema") return [
    ["run","test","--workspace","backend","--","src/db/schema.test.ts","scripts/largeTenantFixture.test.ts"],
    ["run","typecheck","--workspace","backend"],
  ];
  if (suite === "capacity-retention") return [
    ["run","test","--workspace","backend","--","src/db/officialUsage.test.ts","scripts/database.test.ts",
      "src/db/dataRetention.test.ts","scripts/backup.test.ts","scripts/largeTenantRestore.test.ts",
      "src/db/lifecycleAcceptance.test.ts","src/db/schema.test.ts","scripts/largeTenantCapacity.test.ts",
      "scripts/largeTenantFixture.test.ts","src/services/inventoryReconciliation.test.ts",
      "src/db/inventoryGenerations.test.ts","scripts/officialUsageSupersession.unit.test.ts",
      "src/services/inventoryExports.test.ts","src/db/unifiedAgentsIntegration.test.ts","src/db/dataGenerations.test.ts",
      "scripts/testDatabase.test.ts","scripts/testDatabaseTemplate.test.ts"],
    ["run","typecheck","--workspace","backend"],
  ];
  if (suite === "capacity-focused") return [
    ["run", "test", "--workspace", "backend", "--", "scripts/largeTenantCapacity.test.ts", "scripts/largeTenantFixture.test.ts",
      "src/services/inventoryReconciliation.test.ts", "src/db/packageInventoryFilters.test.ts", "src/db/dataGenerations.test.ts",
      "src/db/inventoryGenerations.test.ts", "src/services/inventoryExports.test.ts",
      "scripts/backupFingerprintStream.test.ts", "scripts/backup.test.ts", "src/db/officialUsageImports.test.ts",
      "src/db/officialUsageHistorySelection.test.ts", "src/services/largeTenantUserSources.test.ts",
      "scripts/largeTenantRestore.test.ts","src/db/schema.test.ts","src/services/largeTenantUsersReports.test.ts",
      "src/db/dataLifecycle.test.ts","src/db/automaticRevisions.unit.test.ts","src/db/dataSyncSelection.test.ts",
      "scripts/officialUsageSupersession.unit.test.ts","src/routes/largeTenantInventory.test.ts",
      "src/db/powerPlatformInventory.test.ts","src/db/officialUsage.test.ts","scripts/database.test.ts",
      "src/db/unifiedAgentsIntegration.test.ts","scripts/testDatabase.test.ts","scripts/testDatabaseTemplate.test.ts",
      "src/db/dataRetention.test.ts","src/routes/unifiedAgents.test.ts","src/db/childInsertFence.test.ts","src/db/reportMembershipCounts.test.ts","src/services/dataSelections.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "lifecycle-acceptance-related") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/lifecycleAcceptance.test.ts", "src/routes/quarantineJobReads.test.ts",
      "src/db/jobs.test.ts", "src/db/copilotStudioQuarantine.test.ts", "src/db/copilotStudioQuarantine.unit.test.ts",
      "src/services/copilotStudioQuarantineJobs.test.ts", "src/services/copilotStudioQuarantineJobs.unit.test.ts",
      "src/services/bulkJobs.test.ts", "src/services/bulkJobs.unit.test.ts", "scripts/database.test.ts",
      "src/db/officialUsage.test.ts", "src/db/agentUsage.test.ts", "src/db/officialUsageImports.test.ts", "src/db/officialUsageHistorySelection.test.ts",
      "src/db/dataRetention.test.ts", "src/db/schema.test.ts", "src/server.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "lifecycle-acceptance") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/lifecycleAcceptance.test.ts", "src/routes/quarantineJobReads.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "lifecycle-repair") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/dataLifecycle.test.ts", "scripts/database.test.ts", "src/db/schema.test.ts",
      "src/services/automaticRefreshIntegration.test.ts", "src/db/jobs.test.ts", "src/db/copilotStudioQuarantine.test.ts",
      "src/db/copilotStudioQuarantine.unit.test.ts", "src/server.test.ts", "src/services/dataMetrics.test.ts"],
    ["run", "test", "--workspace", "frontend"],
    ["run", "typecheck", "--workspace", "backend"], ["run", "lint", "--workspace", "frontend"], ["run", "build", "--workspace", "frontend"],
  ];
  if (suite === "lifecycle") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/dataLifecycle.test.ts", "src/services/dataExportLifecycle.test.ts",
      "src/db/dataSyncCleanup.test.ts", "src/db/multiTenantIsolation.test.ts", "src/db/sessionsIsolation.test.ts",
      "src/services/automaticRefreshIntegration.test.ts", "src/services/maintenance.test.ts", "src/services/operationalState.test.ts",
      "scripts/backup.test.ts", "scripts/largeTenantRestore.test.ts", "scripts/dataSyncPersistence.test.ts",
      "src/db/dataRetention.test.ts", "src/db/officialUsageHistorySelection.test.ts", "src/services/dataExports.test.ts",
      "src/db/jobs.test.ts", "src/db/inventoryGenerations.test.ts", "src/db/schema.test.ts", "src/routes/dataPages.test.ts"],
    ["run", "test", "--workspace", "frontend", "--", "src/components/AutomaticRefreshStatus.test.tsx", "src/components/DataSyncPanel.test.tsx",
      "src/components/SyncHistoryView.test.tsx", "src/components/OfficialUsageManageReports.test.tsx", ...appSessionFiles, "src/savedQueries.test.tsx",
      "src/api/reportData.test.ts", "src/components/ReportExportButton.test.tsx"],
    ["run", "typecheck", "--workspace", "backend"],
    ["run", "lint", "--workspace", "frontend"],
  ];
  if (suite === "restore") return [
    ["run", "test", "--workspace", "backend", "--", "scripts/largeTenantRestore.test.ts", "scripts/backup.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "lifecycle-core") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/dataLifecycle.test.ts", "src/services/dataExportLifecycle.test.ts",
      "src/db/dataRetention.test.ts", "src/services/dataSelections.test.ts", "src/services/dataExports.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "restore-inventory") return [["run", "test", "--workspace", "backend", "--", "scripts/largeTenantRestore.test.ts"]];
  if (suite === "lifecycle-race") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/dataLifecycle.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-acceptance-repair") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/inventoryMutationStages.test.ts",
      "src/db/jobs.test.ts", "src/db/schema.test.ts", "src/services/bulkJobs.test.ts", "src/services/bulkJobs.unit.test.ts",
      "src/db/copilotStudioQuarantine.test.ts", "src/db/copilotStudioQuarantine.unit.test.ts",
      "src/services/copilotStudioQuarantineJobs.test.ts", "src/services/copilotStudioQuarantineJobs.unit.test.ts",
      "src/routes/quarantineJobReads.test.ts", "src/routes/packageCanaryAuthorization.test.ts",
      "src/services/packageCanaryMutation.unit.test.ts", "src/server.test.ts"],
    ["run", "test", "--workspace", "frontend", "--", "src/agentInventoryQueries.test.ts", ...appSessionFiles],
    ["run", "typecheck", "--workspace", "backend"],
    ["run", "lint", "--workspace", "frontend"],
    ["run", "build", "--workspace", "frontend"],
  ];
  if (suite === "inventory-acceptance-recovery") return [
    ["run", "test", "--workspace", "backend", "--", "scripts/database.test.ts", "src/db/copilotStudioQuarantine.test.ts",
      "src/db/copilotStudioQuarantine.unit.test.ts", "src/routes/quarantineJobReads.test.ts", "src/server.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-controller-contract") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/agentIdentityPublication.test.ts",
      "src/services/copilotStudioQuarantineJobs.unit.test.ts", "src/services/workbenchMetadata.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "report-source-scale") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/largeTenantUsersReports.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "backend-shard-1" || suite === "backend-shard-2") return [
    ["run", "test", "--workspace", "backend", "--", `--shard=${suite.endsWith("1") ? 1 : 2}/2`],
  ];
  if (suite === "inventory-http-contract") return [
    ["run", "test", "--workspace", "backend", "--", "src/app.test.ts", "src/routes/inventory.test.ts",
      "src/routes/policy.test.ts", "src/routes/workbenchJobs.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-route-contract") return [
    ["run", "test", "--workspace", "backend", "--", "src/routes/agents.test.ts", "src/routes/dataPages.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-integration") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/unifiedAgentsIntegration.test.ts", "src/db/unifiedAgentRegistry.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-registry") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/unifiedAgentRegistry.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-parity") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/unifiedAgents.test.ts", "src/db/powerPlatformInventorySorting.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory") return [
    ["run", "test", "--workspace", "backend", "--", "src/routes/largeTenantInventory.test.ts",
      "src/db/packageInventory.test.ts", "src/db/packageInventoryUnifiedSource.test.ts", "src/db/powerPlatformInventorySorting.test.ts",
      "src/db/unifiedAgentsIntegration.test.ts", "src/services/unifiedAgents.test.ts", "src/services/unifiedAgentsSnapshot.test.ts",
      "src/services/agentUsage.test.ts", "src/services/agentInvestigations.test.ts", "src/services/agentPeople.test.ts",
      "src/routes/unifiedAgents.test.ts", "src/routes/agents.test.ts", "src/routes/agentUsage.test.ts",
      "src/routes/packageCanaryAuthorization.test.ts", "src/services/inventoryCsv.test.ts", "src/services/inventoryRuntime.test.ts"],
    ["run", "test", "--workspace", "frontend", "--", "src/components/LargeTenantInventory.test.tsx",
      "src/components/UnifiedAgentTable.test.tsx", "src/components/UnifiedAgentDetailModal.test.tsx",
      "src/components/AgentInventoryFilters.test.tsx", "src/components/UserAgentResponsibility.test.tsx",
      "src/components/AgentUsagePanel.test.tsx", "src/components/AgentInvestigationsPanel.test.tsx",
      "src/agentInventoryQueries.test.ts", "src/agentExport.test.ts", "src/api/inventoryExport.test.ts", "src/packageSelectionSession.test.ts"],
  ];
  if (suite === "inventory-jobs") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/jobPages.test.ts", "src/db/jobs.test.ts", "src/db/schema.test.ts",
      "src/services/bulkJobs.test.ts", "src/routes/agents.test.ts", "src/routes/packageCanaryAuthorization.test.ts", "src/routes/policy.test.ts",
      "src/app.test.ts", "src/server.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
    ["run", "test", "--workspace", "frontend", "--", "src/components/LargeTenantInventory.test.tsx", "src/components/BulkActions.test.tsx", ...appSessionFiles],
    ["run", "build", "--workspace", "frontend"],
  ];
  if (suite === "inventory-route") return [
    ["run", "test", "--workspace", "backend", "--", "src/routes/largeTenantInventory.test.ts"],
  ];
  if (suite === "inventory-exports") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/inventoryCsv.test.ts",
      "src/services/inventoryExports.test.ts", "src/services/dataExports.test.ts", "src/services/unifiedAgentsSnapshot.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-refresh-services") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/packageInventory.test.ts",
      "src/services/powerPlatformInventory.test.ts", "src/services/automaticRefreshIntegration.test.ts",
      "src/db/generationAdmission.test.ts", "src/db/dataGenerations.test.ts", "src/db/packageInventoryPublication.test.ts",
      "src/db/packageEnrichment.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-identity") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/agentIdentity.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-identity-proof") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/agentIdentity.test.ts",
      "-t", "source-bound|seeds verified account batch 0"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-cleanup") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/dataSyncCleanup.test.ts", "src/db/dataSync.test.ts",
      "src/db/automaticDataSync.test.ts", "src/db/userSourceInitialization.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-native-source") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/powerPlatformInventory.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-expiry") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/packageInventoryUnifiedSource.test.ts",
      "src/services/inventoryReconciliation.test.ts", "src/db/inventoryCutoverSchema.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-verification") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/inventoryVerification.test.ts", "src/db/savedAgentPeople.test.ts",
      "src/db/powerPlatformInventory.unit.test.ts", "src/db/packageInventoryUnifiedSource.test.ts", "src/db/packageInventory.test.ts",
      "src/db/packageControlState.test.ts", "src/db/inventoryOrderingSchema.test.ts", "src/db/powerPlatformInventory.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-control-integration") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/bulkJobs.test.ts", "src/db/jobs.test.ts",
      "src/db/agentPeople.test.ts", "src/services/copilotStudioQuarantineCanaries.test.ts",
      "src/services/copilotStudioQuarantineCanaries.unit.test.ts", "src/services/copilotStudioQuarantineJobs.test.ts",
      "src/db/copilotStudioQuarantine.test.ts", "src/db/copilotStudioQuarantineCanaries.test.ts",
      "src/db/quarantineTenantIsolation.test.ts", "src/db/agentControlIdentity.test.ts", "src/db/multiTenantIsolation.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-facets") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/packageInventoryFilters.test.ts", "src/routes/unifiedAgents.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
    ["run", "test", "--workspace", "frontend", "--", "src/components/InventoryFacetSelect.test.tsx",
      "src/components/AgentInventoryFilters.test.tsx", "src/components/LargeTenantInventory.test.tsx",
      "src/workbenchRouting.test.ts", "src/api/client.test.ts"],
    ["run", "build", "--workspace", "frontend"],
    ["run", "lint", "--workspace", "frontend"],
  ];
  if (suite === "inventory-details") return [
    ["run", "test", "--workspace", "backend", "--", "src/routes/largeTenantInventory.test.ts", "-t", "serves an exact counted page|selected saved package details|counted responsibility|selected refresh targets"],
    ["run", "typecheck", "--workspace", "backend"],
    ["run", "test", "--workspace", "frontend", "--", "src/api/client.test.ts", "src/components/LargeTenantInventory.test.tsx"],
    ["run", "test", "--workspace", "frontend", "--", ...appSessionFiles, "-t", "durable inventory export|invalidates an export selection|off-preview published"],
    ["run", "build", "--workspace", "frontend"],
    ["run", "lint", "--workspace", "frontend"],
  ];
  if (suite === "inventory-lifecycle") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/inventoryCutoverSchema.test.ts", "scripts/backup.test.ts", "scripts/cache-load.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-metadata") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/packageInventoryAdmission.test.ts", "src/db/packageInventoryFilters.test.ts",
      "src/db/inventoryProviderSchema.test.ts", "src/db/packageInventoryAudit.test.ts", "src/db/inventoryRefreshContractSchema.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
    ["run", "test", "--workspace", "frontend", "--", "src/agentInventoryQueries.test.ts", "src/components/SavedInventoryVerification.test.tsx",
      "src/components/AgentSyncTools.test.tsx", "src/useOfficialUsageOverview.test.tsx", "src/components/LargeTenantInventory.test.tsx",
      "src/packageSelectionSession.test.ts", "src/workbenchRouting.test.ts", "src/components/UnifiedAgentTable.test.tsx"],
    ["run", "test", "--workspace", "frontend", "--", ...appSessionFiles, "-t",
      "5000 all-matching|logical package group|restores all 5000|restores pinned|rejects a restored group"],
    ["run", "build", "--workspace", "frontend"],
    ["run", "lint", "--workspace", "frontend"],
  ];
  if (suite === "inventory-cutover") return [
    ["run", "test", "--workspace", "backend", "--", "src/routes/largeTenantInventory.test.ts",
      "src/services/inventoryReconciliation.test.ts", "src/services/streamedInventory.test.ts", "src/services/agentInvestigations.test.ts",
      "src/routes/agentPeople.test.ts", "src/routes/agentInvestigationHttp.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
    ["run", "test", "--workspace", "frontend", "--", "src/components/LargeTenantInventory.test.tsx",
      "src/components/UnifiedAgentTable.test.tsx", "src/components/UnifiedAgentDetailModal.test.tsx",
      "src/components/AgentInventoryFilters.test.tsx", "src/components/UserAgentResponsibility.test.tsx", "src/agentInventoryQueries.test.ts",
      "src/workbenchRouting.test.ts", "src/components/AuditLogView.test.tsx", "src/downloadFile.test.ts",
      "src/api/client.test.ts", "src/api/inventoryExport.test.ts", "src/agentExport.test.ts"],
    ["run", "build", "--workspace", "frontend"],
  ];
  if (suite === "inventory-usage-authority") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/agentUsage.test.ts", "src/services/agentUsage.test.ts",
      "src/db/agentUsageSchema.test.ts", "src/routes/agentUsage.test.ts"],
    ["run", "typecheck", "--workspace", "backend"], ["run", "build", "--workspace", "frontend"],
  ];
  if (suite === "inventory-native-evidence") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/inventoryIdentityQueries.test.ts",
      "src/db/defenderHunting.test.ts", "src/db/purviewAudit.test.ts", "src/db/agentPeople.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-staging") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/inventoryMutationStages.test.ts", "src/routes/largeTenantInventory.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
    ["run", "test", "--workspace", "frontend", "--", ...appSessionFiles, "--reporter=json", "--outputFile=/evidence/inventory-staging-app.json"],
    ["run", "build", "--workspace", "frontend"],
  ];
  if (suite === "inventory-foundation") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/inventoryGenerations.test.ts", "src/services/inventoryReconciliation.test.ts",
      "src/services/streamedInventory.test.ts", "src/db/packageInventoryPublication.test.ts", "src/db/packageInventoryAdmission.test.ts",
      "src/db/packageInventoryFilters.test.ts", "src/db/powerPlatformInventory.test.ts", "src/db/unifiedAgentRegistry.test.ts",
      "src/services/packageAgentIdentity.test.ts", "src/services/packageMutationState.test.ts", "src/services/packageControlProjection.test.ts",
      "src/services/powerPlatformResourceQuery.test.ts", "src/services/graphPackagePacing.test.ts", "src/services/graphPackageReadBudget.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-core") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/inventoryGenerations.test.ts", "src/services/inventoryReconciliation.test.ts",
      "src/services/streamedInventory.test.ts", "src/db/inventoryMutationStages.test.ts", "src/db/packageInventory.test.ts", "src/services/inventoryRuntime.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-reconciliation") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/inventoryReconciliation.test.ts", "src/db/inventoryCutoverSchema.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "inventory-native-ui") return [
    ["run", "test", "--workspace", "frontend", "--", "src/components/UnifiedAgentTable.test.tsx",
      "src/components/UnifiedAgentDetailModal.test.tsx", "src/components/CopilotStudioQuarantineControls.test.tsx",
      "src/components/UserAgentResponsibility.test.tsx", "src/components/LargeTenantInventory.test.tsx",
      "src/components/AgentOverview.test.tsx", "src/components/AccessAssignmentModal.test.tsx"],
    ["run", "build", "--workspace", "frontend"],
    ["run", "lint", "--workspace", "frontend"],
  ];
  if (suite === "inventory-groups") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/inventoryMutationStages.test.ts", "src/services/inventoryReconciliation.test.ts",
      "src/db/automaticRevisions.unit.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
    ["run", "test", "--workspace", "frontend", "--", ...appSessionFiles, "-t", "confirms.*(?:all-matching|logical package group)"],
    ["run", "build", "--workspace", "frontend"],
    ["run", "lint", "--workspace", "frontend"],
  ];
  if (suite === "inventory-protocol") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/streamedInventory.test.ts", "src/services/packageAgentIdentity.test.ts",
      "src/services/graphPackages.test.ts", "src/services/powerPlatformResourceQuery.test.ts",
      "src/services/packageObservation.test.ts", "src/services/providerJson.test.ts"],
    ["run", "test", "--workspace", "backend", "--", "src/services/graphPackageReadBudget.test.ts", "src/services/graphPackagePacing.test.ts",
      "src/services/packageScanDiagnostics.test.ts"],
    ["run", "test", "--workspace", "backend", "--", "src/services/powerPlatformInventory.test.ts"],
    ["run", "test", "--workspace", "backend", "--", "src/db/inventoryGenerations.test.ts", "-t", "native identities across streamed pages"],
    ["run", "test", "--workspace", "backend", "--", "src/db/inventoryProviderSchema.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "cutover-compiled-restart") return [
    ["run", "build", "--workspace", "backend"],
    ["exec", "--no", "--workspace", "backend", "--", "tsx", "scripts/compiledRestartFixture.ts"],
  ];
  if (suite === "cutover-report-profile") return [["exec", "--no", "--workspace", "backend", "--", "tsx", "scripts/reportReadProfile.ts"]];
  if (suite === "cutover-native-views") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/officialUsageViews.test.ts", "src/routes/policy.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "cutover-overview-contract") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/officialUsageOverview.test.ts", "src/services/officialReportReads.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "cutover-history-contract") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/officialUsageHistory.test.ts",
      "src/db/officialUsageHistorySelection.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "cutover-native-authority") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/officialUsage.test.ts", "src/db/officialUsageImports.test.ts", "src/routes/officialUsageImports.test.ts",
      "src/routes/dataPages.test.ts", "src/db/officialUsageHistory.test.ts", "src/db/officialUsageHistorySelection.test.ts",
      "src/db/schema.test.ts", "src/db/officialUsageOverview.test.ts", "src/services/officialReportReads.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "cutover-user-protocol") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/largeTenantUserSources.test.ts",
      "src/services/userSourceGraphFields.test.ts", "src/services/copilotUsageGraph.test.ts", "src/services/providerJson.test.ts",
      "scripts/largeTenantFixture.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "cutover-http-lifecycle") return [
    ["run", "test", "--workspace", "backend", "--", "src/app.test.ts", "src/routes/dataPages.test.ts", "src/services/telemetry.test.ts",
      "scripts/officialUsageSupersession.unit.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "cutover-automatic-contract") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/dataGenerations.test.ts", "src/db/automaticDataSync.test.ts", "src/db/dataSyncCleanup.test.ts",
      "src/services/automaticRefreshIntegration.test.ts", "src/services/dataSync.test.ts", "src/services/providerJson.test.ts", "src/routes/workbenchJobs.test.ts",
      "src/appRedirect.test.ts", "src/services/defenderHunting.test.ts", "src/services/telemetry.test.ts", "src/services/workbenchMetadata.test.ts",
      "src/db/schema.test.ts", "src/db/sessionsIsolation.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "cutover-agent-usage") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/agentUsage.test.ts", "src/services/agentUsage.test.ts",
      "src/routes/agentUsage.test.ts", "src/routes/dataPages.test.ts", "src/services/bulkJobs.test.ts",
      "src/services/unifiedAgents.test.ts", "src/services/unifiedAgentsSnapshot.test.ts", "src/db/unifiedAgentsIntegration.test.ts", "src/db/agentUsageSchema.test.ts",
      "src/services/savedAgentPeople.test.ts", "src/db/multiTenantIsolation.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "cutover-retention-contract") return [
    ["run", "test", "--workspace", "backend", "--", "scripts/database.test.ts",
      "scripts/backup.test.ts", "scripts/recordPersistence.test.ts", "scripts/officialUsageSupersession.unit.test.ts", "scripts/dataSyncPersistence.test.ts", "scripts/largeTenantFixture.test.ts", "src/db/userSourceInitialization.test.ts",
      "src/db/dataRetention.test.ts",
      "src/server.test.ts", "src/services/purviewAudit.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "cutover-capability-admission") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/capabilities.test.ts", "src/services/mapWithConcurrency.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "cutover-browser-ui-contract") return [
    ["run", "test", "--workspace", "frontend", "--", "src/components/LargeTenantUsersReports.test.tsx",
      "src/components/CopilotUsersView.test.tsx", "src/components/OfficialUsageViews.test.tsx", "src/test/selectedUsageFixture.test.ts", "src/test/selectedImportData.test.ts"],
    ["run", "lint", "--workspace", "frontend"],
  ];
  if (suite === "cutover-browser-contract") return [
    ["exec", "--no", "--workspace", "frontend", "--", "vite", "build"],
    ["exec", "--no", "--workspace", "backend", "--", "vitest", "run", "--config", "scripts/browser-fixture.config.ts"],
  ];
  if (suite === "cutover-runtime-contract") return [
    ["run", "test", "--workspace", "backend", "--", "src/routes/dataPages.test.ts", "src/services/largeTenantUsersReports.test.ts",
      "src/services/largeTenantUserSources.test.ts", "src/services/dataSelections.test.ts", "src/services/dataExports.test.ts",
      "src/services/officialUsageParser.test.ts", "src/services/csvExport.test.ts", "src/services/inventoryCsv.test.ts",
      "scripts/softwareChecks.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
    ...fixtureCommands("cutover-ui-contract"),
  ];
  if (suite === "cutover-ui-contract") return [
    ["run", "test", "--workspace", "frontend", "--", "src/components/LargeTenantUsersReports.test.tsx",
      "src/components/CopilotServiceDetails.test.tsx", "src/components/CopilotLicenseStatus.test.tsx",
      "src/components/officialUsageImportPresentation.test.ts", "src/components/ReportedUserAgents.test.tsx",
      "src/components/OfficialUsageImportModal.test.tsx", "src/components/OfficialUsageHistoryPanel.test.tsx", "src/components/OfficialUsageReportSelector.test.tsx",
      "src/components/OfficialUsageManageReports.test.tsx", "src/components/OfficialUsageSnapshot.test.tsx", "src/components/OfficialUsageImportPanel.test.tsx",
      "src/components/CopilotUsersView.test.tsx", "src/components/ReportedUserActivity.test.tsx", "src/components/UserPurviewAudit.test.tsx",
      "src/components/OfficialUsageViews.test.tsx", "src/components/AgentUsagePanel.test.tsx", "src/components/UnifiedAgentDetailModal.test.tsx",
      "src/components/UnifiedAgentTable.test.tsx", "src/components/CsvUsageReportsSection.test.tsx",
      "src/agentInventoryQueries.test.ts", "src/useOfficialUsageOverview.test.tsx", "src/api/client.test.ts"],
    ["run", "lint", "--workspace", "frontend"],
  ];
  if (suite === "cutover-source-activation") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/copilotUsage.test.ts",
      "src/db/dataSync.test.ts", "src/db/dataSyncSnapshot.test.ts", "src/services/largeTenantUsersReports.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
    ...fixtureCommands("cutover-ui-contract"),
  ];
  if (suite === "cutover-types") return [
    ["run", "typecheck", "--workspace", "backend"], ["run", "build", "--workspace", "frontend"],
  ];
  if (suite === "cutover-app-contract") return [
    ["run", "test", "--workspace", "frontend", "--", ...appSessionFiles, "src/test/permissionFixtures.test.ts"],
    ["run", "lint", "--workspace", "frontend"],
  ];
  if (suite === "inventory-app-exports") return [
    ["run", "test", "--workspace", "frontend", "--", ...appSessionFiles, "--testNamePattern", "export|bulk-reference|off-preview"],
    ["run", "lint", "--workspace", "frontend"],
  ];
  if (suite === "cutover-people-fences") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/largeTenantUserSources.test.ts",
      "src/services/savedAgentPeople.test.ts", "src/db/savedAgentPeople.test.ts",
      "src/services/agentPeople.test.ts", "src/db/agentPeople.test.ts", "src/db/dataSyncSnapshot.test.ts",
      "src/db/automaticRevisions.unit.test.ts", "src/db/automaticDataSync.test.ts", "src/db/dataSyncCleanup.test.ts",
      "src/services/automaticRefreshIntegration.test.ts", "src/db/dataSync.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "users-reports-cutover") return [
    ["run", "test", "--workspace", "backend", "--", "src/routes/dataPages.test.ts", "src/routes/officialUsageCsv.test.ts",
      "src/routes/officialUsageImports.test.ts", "src/services/largeTenantUserSources.test.ts", "src/services/largeTenantUsersReports.test.ts",
      "src/db/officialUsageHistorySelection.test.ts", "src/services/copilotUsage.test.ts", "src/services/savedAgentPeople.test.ts", "src/services/agentUsage.test.ts"],
    ["run", "test", "--workspace", "frontend", "--", "src/components/LargeTenantUsersReports.test.tsx", "src/components/CopilotUsersView.test.tsx",
      "src/components/CopilotServiceDetails.test.tsx", "src/components/OfficialUsageViews.test.tsx", "src/components/OfficialUsageImportModal.test.tsx",
      "src/components/OfficialUsageHistoryPanel.test.tsx", "src/components/ReportedUserAgents.test.tsx", "src/api/client.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "data-page-contract") return [
    ["run", "test", "--workspace", "backend", "--", "src/routes/dataPages.test.ts", "src/routes/officialUsageImports.test.ts",
      "src/routes/officialUsageCsv.test.ts", "src/services/csvExport.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "official-reports-foundation") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/largeTenantUsersReports.test.ts",
      "src/db/officialUsageHistorySelection.test.ts", "src/db/officialUsage.test.ts", "src/db/officialUsageImports.test.ts",
      "src/db/officialUsageHistory.test.ts", "src/services/officialUsageParser.test.ts", "src/services/officialUsageViews.test.ts",
      "src/services/copilotUsage.test.ts", "src/services/agentUsage.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "user-sources-foundation") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/largeTenantUserSources.test.ts",
      "src/db/dataSync.test.ts", "src/services/copilotUsageGraph.test.ts", "src/services/copilotUsage.test.ts",
      "src/services/copilotServicePlans.test.ts", "src/services/userSourceGraphFields.test.ts", "src/services/savedAgentPeople.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "selected-reads") return [
    ["run", "test", "--workspace", "backend", "--", "src/services/dataSelections.test.ts", "src/services/dataExports.test.ts"],
  ];
  if (suite === "foundation") return [
    ["run", "test", "--workspace", "backend", "--", "src/db/dataGenerations.test.ts",
      "src/services/dataSelections.test.ts", "src/services/dataExports.test.ts", "src/db/schema.test.ts",
      "src/db/sessionsConcurrency.test.ts", "scripts/largeTenantFixture.test.ts",
      "scripts/databasePreflight.test.ts", "scripts/databaseReset.test.ts"],
    ["run", "typecheck", "--workspace", "backend"],
  ];
  if (suite === "all") return [
    ["run", "test", "--workspace", "backend"], ["run", "test", "--workspace", "frontend"],
    ["run", "typecheck", "--workspace", "backend"], ["run", "lint", "--workspace", "frontend"], ["run", "build"],
  ];
  throw new Error(`Suite ${suite} is not yet implemented.`);
}

export function fixtureEnvironment(): NodeJS.ProcessEnv {
  if (process.env.AGENT_CONTROL_ISOLATED_TESTS !== "1" || process.env.PGHOST !== "127.0.0.1"
    || process.env.PGDATABASE !== "agentcontrol_test_control" || process.env.PGUSER !== "agentcontrol_admin"
    || process.env.PGPASSWORD !== "isolated-fixture-admin-password-never-production-01"
    || process.env.APP_PGPASSWORD !== "isolated-fixture-password-never-production-01"
    || Object.keys(process.env).some(key => /^(TENANT|CLIENT_|SESSION_SECRET|PG.*FILE|APP_PGPASSWORD_FILE)/.test(key))) {
    throw new Error("large_tenant_fixture_identity_required");
  }
  return {
    PATH: process.env.PATH, HOME: "/app", TMPDIR: "/app", CI: "1",
    NODE_OPTIONS: "--max-old-space-size=768", DEBUG_PRINT_LIMIT: "1200",
    AGENT_CONTROL_ISOLATED_TESTS: "1", PGHOST: "127.0.0.1", PGPORT: "5432",
    PGDATABASE: "agentcontrol_test_control", PGUSER: "agentcontrol_admin",
    PGPASSWORD: process.env.PGPASSWORD, APP_PGPASSWORD: process.env.APP_PGPASSWORD,
    PGSSLMODE: "disable", NPM_CONFIG_REGISTRY: "https://packagefeedproxy.microsoft.io/npm/",
  };
}

type FixtureExecutor = (command: string, args: string[], options: SpawnSyncOptionsWithBufferEncoding) => SpawnSyncReturns<Buffer>;

export function runFixtureCommand(args: string[], environment: NodeJS.ProcessEnv,
  execute: FixtureExecutor = spawnSync, kill: (pid: number, signal: NodeJS.Signals) => unknown = process.kill) {
  const result = execute("npm", args, {
    env: environment, stdio: "inherit",
    timeout: args.join(" ") === "run test --workspace frontend" ? 300_000 : 600_000, cwd: "/app", detached: true,
  });
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
    if (!Number.isSafeInteger(result.pid) || result.pid <= 0) throw new Error("fixture_timeout_process_group_missing", { cause: result.error });
    // npm may exit while its test workers survive; each command owns its process group.
    try { kill(-result.pid, "SIGKILL"); }
    catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH") {
        throw new AggregateError([result.error, error], "fixture_timeout_process_group_cleanup");
      }
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const environment = fixtureEnvironment();
  if (process.argv[2] === "cutover-browser-contract") Object.assign(environment, {
    AGENT_CONTROL_FIXTURE_MODE: "browser", PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
    PLAYWRIGHT_EVIDENCE_DIR: "/evidence", AGENT_CONTROL_BROWSER_TEST_FILES: browserFixtureTestFiles(process.argv[3] ?? "reportSets.spec.ts").join(","),
  });
  const failures: Error[] = [];
  const receipts: { command: string; exit: number | null; signal: string | null; elapsedMs: number; error: string | null }[] = [];
  for (const args of fixtureCommands(process.argv[2])) {
    const startedAt = performance.now();
    console.log(`RUN npm ${args.join(" ")}`);
    const result = runFixtureCommand(args, environment);
    console.log(`RESULT npm ${args.join(" ")}: exit=${result.status}, signal=${result.signal}`);
    receipts.push({ command: `npm ${args.join(" ")}`, exit: result.status, signal: result.signal,
      elapsedMs: Math.round(performance.now() - startedAt), error: result.error?.message ?? null });
    if (result.status !== 0 || result.error) failures.push(new Error(`npm ${args.join(" ")} failed`, { cause: result.error }));
  }
  console.log(`QUALIFICATION_RECEIPTS ${JSON.stringify(receipts)}`);
  if (failures.length) throw new AggregateError(failures, "Qualification commands failed");
}
