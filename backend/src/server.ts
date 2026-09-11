import { config, validateRuntimeConfig } from "./config.js";
import { createApp } from "./app.js";
import { PackageMutationQualificationRepository } from "./db/packageMutationQualifications.js";
import { CopilotStudioQuarantineCanaryRepository } from "./db/copilotStudioQuarantineCanaries.js";
import { pool } from "./db/pool.js";
import { bulkJobs, drainBulkJobs } from "./services/bulkJobs.js";
import { copilotStudioQuarantineJobs, drainCopilotStudioQuarantineJobs } from "./services/copilotStudioQuarantineJobs.js";
import { enterMaintenance } from "./services/maintenance.js";
import { defenderHunting } from "./services/defenderHunting.js";
import { packageInventory } from "./services/packageInventory.js";
import { powerPlatformInventory } from "./services/powerPlatformInventory.js";
import { purviewAudit } from "./services/purviewAudit.js";
import { loadOperationalState } from "./services/operationalState.js";
import { observeDatabasePool, operationalLog } from "./services/telemetry.js";

validateRuntimeConfig();
const operationalState = await loadOperationalState(pool);
if (operationalState.mode === "normal") {
  await powerPlatformInventory.recover();
  await packageInventory.recover();
  await purviewAudit.recover();
  await defenderHunting.recover();
  await copilotStudioQuarantineJobs.recoverInterrupted(true);
  if (config.tenantId) await bulkJobs.recover(config.tenantId, true);
  if (config.tenantId) await new PackageMutationQualificationRepository().recoverInterrupted(config.tenantId);
  if (config.tenantId) await new CopilotStudioQuarantineCanaryRepository().recoverInterrupted(config.tenantId);
}
const { app, store } = createApp();
const server = app.listen(config.port, "0.0.0.0", () => {
  operationalLog("info", "listening", { count: config.port });
});
const poolObservation = setInterval(() => observeDatabasePool(pool.waitingCount), 30_000);
poolObservation.unref();

async function shutdown() {
  enterMaintenance();
  clearInterval(poolObservation);
  server.close();
  const deadline = setTimeout(() => process.exit(1), 125_000);
  deadline.unref();
  const drained = await Promise.allSettled([drainBulkJobs(), drainCopilotStudioQuarantineJobs(), packageInventory.drain(), powerPlatformInventory.drain(), purviewAudit.drain(), defenderHunting.drain()]);
  const failure = drained.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  store.close();
  await pool.end();
  clearTimeout(deadline);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());