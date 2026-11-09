import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { eraseAdoptionPrivate } from "./database.js";
import { AdoptionContent } from "../src/services/adoptionContent.js";
import { manualDraft } from "../src/services/adoptionContentTestSupport.js";
import { currentSchemaSql } from "../src/db/currentSchema.js";
import { verifyPrincipalBearerFenceSchema } from "../src/db/principalBearerFenceSchema.js";

vi.mock("../src/db/schema.js", () => ({ verifySchema: vi.fn() }));
vi.mock("../src/services/reportIdentity.js", () => ({
  reportIdentity: vi.fn(async () => ({
    tenantId: "tenant", principalId: "principal", sessionEpoch: "1", authorizationHash: "synthetic",
  })),
}));

afterEach(() => { vi.restoreAllMocks(); });

const now = 1_794_225_600_000;
const futureRequest = `${now + 30_000}.10000000-0000-4000-8000-000000000001`;
const user = { tenantId: "tenant", homeAccountId: "principal", username: "staff", displayName: "Staff",
  roles: ["AgentControl.Viewer" as const] };

function fixture() {
  const database = new pg.Pool({ database: "agentcontrol_test_erasure", max: 4 });
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const connect = vi.spyOn(database, "connect").mockImplementation(async () => client);
  vi.spyOn(Date, "now").mockReturnValue(now);
  return { database, client, connect };
}

it("fences erased future-dated create identities before deleting receipts without moving bearer issuance into the future", async () => {
  const { database, client } = fixture();
  const query = vi.spyOn(client, "query").mockImplementation(async statement => {
    if (typeof statement !== "string") throw new Error("Unexpected operator query shape.");
    if (statement.startsWith("SELECT current_user")) return { rows: [{ name: "agentcontrol_admin" }], rowCount: 1 };
    if (statement.startsWith("SELECT id FROM adoption_content")) return { rows: [], rowCount: 0 };
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement) || statement.includes("pg_advisory_xact_lock")
      || statement.startsWith("INSERT INTO data_principal_epochs") || statement.startsWith("UPDATE")
      || statement.startsWith("DELETE FROM adoption_content_receipts")) return { rows: [], rowCount: 0 };
    throw new Error("Unexpected operator query.");
  });
  await expect(eraseAdoptionPrivate(database, user.tenantId, user.homeAccountId,
    `${database.options.database}/${user.tenantId}/${user.homeAccountId}`))
    .resolves.toEqual({ removedRecords: 0, removedReceipts: 0 });
  const statements = query.mock.calls.map(([statement]) => String(statement));
  const update = statements.find(statement => statement.startsWith("UPDATE data_principal_epochs"))!;
  expect(update).toContain("adoption_request_cutoff=GREATEST(adoption_request_cutoff");
  expect(update).toContain("max(substring(request_id FROM '^([0-9]{13})[.]')::bigint)");
  expect(update).toContain("FROM adoption_content_receipts WHERE tenant_id=$1 AND actor_id=$2");
  expect(update.slice(update.indexOf("bearer_issued_after="), update.indexOf("adoption_request_cutoff=")))
    .not.toContain("request_id");
  expect(statements.indexOf(update)).toBeLessThan(statements.findIndex(statement =>
    statement.startsWith("DELETE FROM adoption_content_receipts")));
  expect(client.release).toHaveBeenCalledOnce();
});

it.each([false, true])("rejects a future-dated erased retry using its separate request fence (inside lock=%s)", async insideLock => {
  const { database, client, connect } = fixture();
  const cutoff = (statement: string) => statement.includes("GREATEST(bearer_issued_after,adoption_request_cutoff)")
    ? now + 30_000 : now;
  const poolQuery = vi.spyOn(database, "query").mockImplementation(async statement => {
    if (typeof statement !== "string") throw new Error("Unexpected content query shape.");
    if (statement.startsWith("SELECT * FROM adoption_content_receipts")) return { rows: [], rowCount: 0 };
    if (statement.includes("AS cutoff FROM data_principal_epochs")) {
      return { rows: [{ cutoff: String(insideLock ? 0 : cutoff(statement)) }], rowCount: 1 };
    }
    throw new Error("Erased content must not be recreated.");
  });
  const query = vi.spyOn(client, "query").mockImplementation(async statement => {
    if (typeof statement !== "string") throw new Error("Unexpected content query shape.");
    if (statement.startsWith("SELECT * FROM adoption_content_receipts")) return { rows: [], rowCount: 0 };
    if (statement.includes("AS cutoff FROM data_principal_epochs")) return { rows: [{ cutoff: String(cutoff(statement)) }], rowCount: 1 };
    if (["BEGIN", "ROLLBACK"].includes(statement) || statement.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
    throw new Error("Erased content must not be recreated.");
  });
  await expect(new AdoptionContent(database).create(user, futureRequest, manualDraft()))
    .rejects.toMatchObject({ code: "adoption_request_revoked" });
  expect(poolQuery).toHaveBeenCalledTimes(2);
  expect(query).not.toHaveBeenCalledWith("COMMIT");
  if (insideLock) {
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  } else expect(connect).not.toHaveBeenCalled();
});

it.each([0, now + 30_000])("allows an explicit new manual save above the request cutoff without an evidence prerequisite (%s)", async cutoff => {
  const { database, client } = fixture();
  const { agentIds: _agents, linkedIds: _links, ...payload } = manualDraft();
  let id = "";
  const query = vi.spyOn(client, "query").mockImplementation(async (statement, values) => {
    if (typeof statement !== "string") throw new Error("Unexpected content query shape.");
    if (statement.startsWith("SELECT * FROM adoption_content_receipts")) return { rows: [], rowCount: 0 };
    if (statement.includes("AS cutoff FROM data_principal_epochs")) return { rows: [{ cutoff: String(cutoff) }], rowCount: 1 };
    if (statement.startsWith("SELECT records::text")) return { rows: [{ records: "0", bytes: "0" }], rowCount: 1 };
    if (statement.startsWith("SELECT sum(octet_length")) return { rows: [{ bytes: "1" }], rowCount: 1 };
    if (statement.startsWith("INSERT INTO adoption_content(")) id = String(values?.[0]);
    else if (!["BEGIN", "COMMIT", "ROLLBACK"].includes(statement) && !statement.includes("pg_advisory_xact_lock")
      && !statement.startsWith("INSERT INTO adoption_content_receipts")) throw new Error("Unexpected content mutation.");
    return { rows: [], rowCount: 0 };
  });
  vi.spyOn(database, "query").mockImplementation(async statement => {
    if (typeof statement !== "string") throw new Error("Unexpected content query shape.");
    if (statement.startsWith("SELECT * FROM adoption_content_receipts")) return { rows: [], rowCount: 0 };
    if (statement.includes("AS cutoff FROM data_principal_epochs")) return { rows: [{ cutoff: String(cutoff) }], rowCount: 1 };
    if (statement.startsWith("SELECT * FROM adoption_content WHERE")) return { rows: [{
      id, creator_id: user.homeAccountId, revision: 1, payload, baseline: null,
      agent_references: [], linked_references: [], created_at: new Date(now), updated_at: new Date(now),
    }], rowCount: 1 };
    if (statement.startsWith("SELECT count(*)::int AS count")) return { rows: [{ count: 1 }], rowCount: 1 };
    throw new Error("Unexpected content read.");
  });
  await expect(new AdoptionContent(database).create(user,
    `${now + 30_001}.10000000-0000-4000-8000-000000000002`, manualDraft())).resolves.toMatchObject({
    state: "saved", replayed: false, record: { title: payload.title, evidence: { state: "unmeasured" } },
  });
  expect(query).toHaveBeenCalledWith("COMMIT");
  expect(client.release).toHaveBeenCalledOnce();
});

it("provisions and verifies the separate nonnegative request cutoff in the current principal schema", async () => {
  const { database } = fixture();
  expect(currentSchemaSql).toContain("adoption_request_cutoff bigint DEFAULT 0 NOT NULL");
  expect(currentSchemaSql).toContain("CHECK (adoption_request_cutoff >= 0)");
  const query = vi.spyOn(database, "query").mockResolvedValue({ rows: [{ valid: true }], rowCount: 1,
    command: "SELECT", oid: 0, fields: [] });
  await verifyPrincipalBearerFenceSchema(database);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("a.attname='adoption_request_cutoff'"));
  expect(query).toHaveBeenCalledWith(expect.stringContaining("pg_get_expr(conbin,conrelid)='(adoption_request_cutoff >= 0)'"));
});
