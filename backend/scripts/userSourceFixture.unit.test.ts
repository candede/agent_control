import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationLease } from "../src/db/dataGenerations.js";
import { dataLimits } from "../src/db/dataBounds.js";
import { UserSourceStages } from "../src/db/userSourceStages.js";
import { directorySourceRecord } from "../src/services/userSourceRecords.js";
import { selectionIdentity } from "./largeTenantFixtures.js";
import { fixtureDirectoryUser, publishFixtureDirectory, publishFixtureEmptyActivity } from "./userSourceFixture.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const database = new pg.Pool({ max: 4 });
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
  const identity = { ...selectionIdentity, tenantId: "fixture-tenant", principalId: "fixture-actor", sessionEpoch: "7" };
  const lease: GenerationLease = {
    id: "generation", scopeId: "scope", tenantId: identity.tenantId, owner: "owner",
    version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1,
  };
  const result = { generationId: lease.id, scopeId: lease.scopeId, revision: "1",
    rows: 0, children: 0, batches: 0, pages: 1, wireRows: 0, bytes: 0 };
  const execute = vi.spyOn(UserSourceStages.prototype, "execute").mockImplementation(async (_input, work, options) => {
    const signal = new AbortController().signal;
    await work(lease, signal);
    await options.beforePublish(signal);
    return result;
  });
  const query = vi.spyOn(UserSourceStages.prototype, "query").mockResolvedValue("query");
  const page = vi.spyOn(UserSourceStages.prototype, "page").mockResolvedValue(undefined);
  const directory = vi.spyOn(UserSourceStages.prototype, "directory").mockResolvedValue(undefined);
  const finish = vi.spyOn(UserSourceStages.prototype, "finishQuery").mockResolvedValue(undefined);
  return { database, identity, lease, result, execute, query, page, directory, finish };
}

const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("user source fixture contracts without infrastructure", () => {
  it("creates independent valid unknown-license users and preserves explicit empty or null identity fields", () => {
    const user = fixtureDirectoryUser(objectId);
    expect(directorySourceRecord(user)).toMatchObject({
      identity: objectId, display_name: "Saved person", upn: "person@example.invalid",
      service_state: "unknown", plan_count: 0,
    });
    expect(fixtureDirectoryUser(objectId, null, "other@example.invalid").identity).toMatchObject({
      displayName: null, userPrincipalName: "other@example.invalid",
    });
    expect(fixtureDirectoryUser(objectId, "").identity.displayName).toBe("");
    const next = fixtureDirectoryUser(objectId);
    expect(next.identity).not.toBe(user.identity);
    expect(next.servicePlans).not.toBe(user.servicePlans);
  });

  it.each(["directory", "app_activity"] as const)("publishes %s with tenant ownership, actor fencing and explicit dates", async source => {
    const f = fixture();
    const options = { observedAt: new Date("2026-10-28T10:00:00Z"), expiresAt: new Date("2026-10-29T10:00:00Z") };
    const result = source === "directory"
      ? await publishFixtureDirectory(f.database, f.identity, [fixtureDirectoryUser(objectId)], options)
      : await publishFixtureEmptyActivity(f.database, f.identity, options);
    expect(result).toBe(f.result);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.execute.mock.calls[0][0]).toMatchObject({
      scope: { kind: "tenant", tenantId: f.identity.tenantId, principalId: null,
        source, selector: "complete", tokenMode: "tenant" },
      actorPrincipalId: f.identity.principalId, sessionEpoch: f.identity.sessionEpoch,
      jobKind: "fixture", schemaVersion: 1, ...options,
    });
    expect(f.query).toHaveBeenCalledExactlyOnceWith(f.lease,
      source === "directory" ? "discovery" : "activity",
      source === "directory" ? "synthetic:exact-people" : "synthetic:empty-activity");
    const count = source === "directory" ? 1 : 0;
    expect(f.page).toHaveBeenCalledExactlyOnceWith(f.lease, "query",
      source === "directory" ? "synthetic:exact-people" : "synthetic:empty-activity", count, count);
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.lease, "query");
    if (source === "directory") expect(f.directory).toHaveBeenCalledExactlyOnceWith(f.lease, "query", [fixtureDirectoryUser(objectId)]);
    else expect(f.directory).not.toHaveBeenCalled();
  });

  it("completes an empty directory query without attempting an empty append", async () => {
    const f = fixture();
    await publishFixtureDirectory(f.database, f.identity, []);
    expect(f.page).toHaveBeenCalledExactlyOnceWith(f.lease, "query", "synthetic:exact-people", 0, 0);
    expect(f.directory).not.toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(f.lease, "query");
  });

  it("keeps directory evidence and counts stable while query creation is pending", async () => {
    const f = fixture(), pending = Promise.withResolvers<string>();
    f.query.mockReturnValueOnce(pending.promise);
    const users = [fixtureDirectoryUser(objectId)];
    const expected = structuredClone(users);
    const publication = publishFixtureDirectory(f.database, f.identity, users);
    users[0].identity.displayName = "Changed after publication started";
    users[0].servicePlans.push({
      servicePlanId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", service: "Changed", displayName: "Changed",
      state: "disabled", capabilityStatus: null, assignedDateTime: null,
    });
    users.push(fixtureDirectoryUser("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
    pending.resolve("query");
    await publication;
    expect(f.page).toHaveBeenCalledExactlyOnceWith(f.lease, "query", "synthetic:exact-people", 1, 1);
    expect(f.directory).toHaveBeenCalledExactlyOnceWith(f.lease, "query", expected);
    expect(f.directory.mock.calls[0][2]).not.toBe(users);
  });

  it.each(["getter", "toJSON", "proxy"] as const)("rejects %s evidence without executing it or starting a generation", async boundary => {
    const f = fixture(), user = fixtureDirectoryUser(objectId);
    const trap = vi.fn(() => "Changed during serialization");
    if (boundary === "getter") Object.defineProperty(user.identity, "displayName", { get: trap });
    if (boundary === "toJSON") Object.defineProperty(user.identity, "toJSON", { value: trap });
    const users = [boundary === "proxy" ? new Proxy(user, { get: trap }) : user];
    await expect(publishFixtureDirectory(f.database, f.identity, users)).rejects.toMatchObject({ code: "provider_schema" });
    expect(trap).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("preserves row and encoded-byte limits before generation creation", async () => {
    const f = fixture(), user = fixtureDirectoryUser(objectId);
    await expect(publishFixtureDirectory(f.database, f.identity, Array.from({ length: dataLimits.batchRows + 1 }, () => user)))
      .rejects.toMatchObject({ code: "data_batch_rows" });
    user.identity.displayName = "x".repeat(dataLimits.batchBytes);
    await expect(publishFixtureDirectory(f.database, f.identity, [user])).rejects.toMatchObject({ code: "data_batch_bytes" });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(["directory", "app_activity"] as const)("propagates %s staging failures without completing the query", async source => {
    const f = fixture(), failure = new Error("synthetic page failure");
    f.page.mockRejectedValueOnce(failure);
    const publication = source === "directory"
      ? publishFixtureDirectory(f.database, f.identity, [fixtureDirectoryUser(objectId)])
      : publishFixtureEmptyActivity(f.database, f.identity);
    await expect(publication).rejects.toBe(failure);
    expect(f.directory).not.toHaveBeenCalled();
    expect(f.finish).not.toHaveBeenCalled();
  });
});
