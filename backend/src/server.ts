import { config, validateRuntimeConfig } from "./config.js";
import { createApp } from "./app.js";
import { PackageMutationQualificationRepository } from "./db/packageMutationQualifications.js";
import { CopilotStudioQuarantineCanaryRepository } from "./db/copilotStudioQuarantineCanaries.js";
import { pool } from "./db/pool.js";
import { verifySchema } from "./db/schema.js";
import { errorTelemetry } from "./errors.js";
import { bulkJobs, drainBulkJobs } from "./services/bulkJobs.js";
import { copilotStudioQuarantineJobs, drainCopilotStudioQuarantineJobs } from "./services/copilotStudioQuarantineJobs.js";
import { enterMaintenance, maintenanceActive } from "./services/maintenance.js";
import { defenderHunting } from "./services/defenderHunting.js";
import { dataSync } from "./services/dataSync.js";
import { packageInventory } from "./services/packageInventory.js";
import { powerPlatformInventory } from "./services/powerPlatformInventory.js";
import { purviewAudit } from "./services/purviewAudit.js";
import { loadOperationalState } from "./services/operationalState.js";
import { observeDatabasePool, observeRuntimeResources, operationalLog } from "./services/telemetry.js";
import { flushDataWorkMetrics } from "./services/dataMetrics.js";
import { reportRuntime } from "./services/reportExportDispatcher.js";
import { inventoryRuntime } from "./services/inventoryRuntime.js";

validateRuntimeConfig();
let shutdownStarted = false;
await verifySchema(pool);
const operationalState = await loadOperationalState(pool);
startupRecovery: if (operationalState.mode === "normal") {
  if (!await recoveryAdmissionsOpen()) break startupRecovery;
  await powerPlatformInventory.recover(recoveryAdmissionsOpen);
  if (!await recoveryAdmissionsOpen()) break startupRecovery;
  await packageInventory.recover();
  if (!await recoveryAdmissionsOpen()) break startupRecovery;
  await dataSync.recover(recoveryAdmissionsOpen);
  if (!await recoveryAdmissionsOpen()) break startupRecovery;
  await purviewAudit.recover();
  if (!await recoveryAdmissionsOpen()) break startupRecovery;
  await defenderHunting.recover(recoveryAdmissionsOpen);
  for (const tenant of config.tenants) {
    while (await recoveryAdmissionsOpen() && await bulkJobs.recover(tenant.tenantId, true) > 0) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (!await recoveryAdmissionsOpen()) break startupRecovery;
    while (await recoveryAdmissionsOpen() && await copilotStudioQuarantineJobs.recoverInterrupted(tenant.tenantId, true) > 0) {
      // Finish bounded orphan batches before accepting new jobs in this process.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (!await recoveryAdmissionsOpen()) break startupRecovery;
    await new PackageMutationQualificationRepository().recoverInterrupted(tenant.tenantId);
    if (!await recoveryAdmissionsOpen()) break startupRecovery;
    await new CopilotStudioQuarantineCanaryRepository().recoverInterrupted(tenant.tenantId);
    if (!await recoveryAdmissionsOpen()) break startupRecovery;
  }
}
const { app, store } = createApp();
reportRuntime().start();
inventoryRuntime().start();
const server = app.listen(config.port, "0.0.0.0", () => {
  operationalLog("info", "listening", { count: config.port });
});
const poolObservation = setInterval(() => {
  observeDatabasePool(pool.waitingCount);
  observeRuntimeResources(pool);
  flushDataWorkMetrics();
}, 30_000);
poolObservation.unref();

let jobRecovery: Promise<void> | undefined;
async function recoveryAdmissionsOpen() {
  if (shutdownStarted || maintenanceActive()) return false;
  const state = await loadOperationalState(pool);
  return !shutdownStarted && !maintenanceActive() && state.mode === "normal";
}
const jobRecoveryTimer = setInterval(() => {
  if (shutdownStarted || maintenanceActive() || jobRecovery) return;
  jobRecovery = (async () => {
    for (const tenant of config.tenants) {
      if (!await recoveryAdmissionsOpen()) break;
      await bulkJobs.recover(tenant.tenantId);
      if (!await recoveryAdmissionsOpen()) break;
      await copilotStudioQuarantineJobs.recoverInterrupted(tenant.tenantId);
    }
  })().catch(error => operationalLog("error", "job_recovery_failed", errorTelemetry(error, "job_recovery_failed")))
    .finally(() => { jobRecovery = undefined; });
}, 30_000);
jobRecoveryTimer.unref();
async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  enterMaintenance();
  clearInterval(poolObservation);
  clearInterval(jobRecoveryTimer);
  // Keep the deadline referenced: an unresolved cleanup promise must not exit successfully.
  const deadline = setTimeout(() => {
    operationalLog("error", "shutdown_timeout");
    process.exit(1);
  }, 125_000);
  try {
    const httpDrained = Promise.allSettled([new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    })]);
    const syncDrained = await Promise.allSettled([dataSync.drain()]);
    const workersDrained = await Promise.allSettled([
      drainBulkJobs(), drainCopilotStudioQuarantineJobs(), packageInventory.drain(),
      powerPlatformInventory.drain(), purviewAudit.drain(), defenderHunting.drain(),
      reportRuntime().drain(),
      inventoryRuntime().drain(),
      jobRecovery ?? Promise.resolve(),
    ]);
    const failure = [...syncDrained, ...workersDrained, ...await httpDrained].find(result => result.status === "rejected");
    flushDataWorkMetrics();
    if (failure?.status === "rejected") throw failure.reason;
    store.close();
    await pool.end();
    clearTimeout(deadline);
  } catch (error) {
    operationalLog("error", "shutdown_failed", errorTelemetry(error, "shutdown_failed"));
    process.exit(1);
  }
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());