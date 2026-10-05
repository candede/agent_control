import { BoundedPool } from "../src/db/boundedPool.js";

export function bindCapacityDatabase(database: BoundedPool, name: string, environment = process.env) {
  const control = environment.PGDATABASE;
  if (environment.AGENT_CONTROL_ISOLATED_TESTS!=="1" || environment.PGHOST!=="test-postgres"
    || !/^agentcontrol_test_[a-f0-9]{32}_control$/.test(control ?? "")
    || !/^agentcontrol_test_[a-f0-9]{32}$/.test(name)
    || !environment.APP_PGPASSWORD || database.options.host!==environment.PGHOST
    || database.options.database!==control || database.options.max!==4
    || database.options.connectionTimeoutMillis!==5000 || database.options.statement_timeout!==15000) {
    throw new Error("capacity_database_binding");
  }
  if (database.totalCount || database.idleCount || database.waitingCount
    || database.admissionState.foreground || database.admissionState.queue || database.ended) {
    throw new Error("capacity_database_already_used");
  }
  // Existing app services retain this pool object. Bind it once, before any
  // connection, rather than opening a second pool against the empty control DB.
  database.options.database = name;
  database.options.user = "agentcontrol_app";
  database.options.password = environment.APP_PGPASSWORD;
  database.options.application_name = "agent-control-capacity-app";
  return database;
}
