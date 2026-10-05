import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { JobRepository, createJobConfirmation, type JobIntentInput } from "./jobs.js";
import { DataGenerations } from "./dataGenerations.js";

describe("bounded job result projections", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  let jobs: JobRepository;
  beforeAll(async () => { fixture = await testDatabase(); jobs = new JobRepository(fixture.runtime); });
  afterAll(async () => { await fixture?.close(); });
  it("keeps 5,000 outcomes out of metadata and uses one history query", async () => {
    const scope = { tenantId: "job-pages", principalId: randomUUID() };
    const identity = { ...selectionIdentity, ...scope,
      sessionEpoch: await new DataGenerations(fixture.runtime).sessionEpoch(scope.tenantId, scope.principalId) };
    const intent: JobIntentInput = { action: "block", scope: "bulk", requestPath: "/api/agents/block",
      actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, username: "fixture@example.invalid", displayName: "Fixture" },
      targets: Array.from({ length: 5000 }, (_, index) => ({ id: `package-${String(index).padStart(5, "0")}`,
        displayName: `Package ${index}`, prestate: { kind: "block", isBlocked: false } })) };
    const submitted = await jobs.submit(scope, { ...intent, idempotencyKey: randomUUID(), confirmationHash: createJobConfirmation(intent).confirmationHash });
    await fixture.runtime.query(`UPDATE job_items SET status=CASE WHEN ordinal<2000 THEN 'succeeded' WHEN ordinal<3000 THEN 'failed'
      WHEN ordinal<4000 THEN 'inconclusive' ELSE 'cancelled' END,
      reconciliation_status=CASE WHEN ordinal>=3000 AND ordinal<4000 THEN 'required' ELSE 'not_required' END WHERE job_id=$1`, [submitted.id]);
    const query = vi.spyOn(fixture.runtime, "query");
    const metadata = (await jobs.get(submitted.id, scope))!;
    expect(query).toHaveBeenCalledTimes(1);
    expect(metadata).toMatchObject({ total: 5000, completed: 5000, succeeded: 2000, failed: 1000,
      inconclusive: 1000, cancelled: 1000, reconciliationRequired: 1000, retryEligible: 0, canResume: false });
    expect(metadata).not.toHaveProperty("results");
    expect(metadata).not.toHaveProperty("result");
    expect(metadata.confirmation).not.toHaveProperty("targets");
    expect(String(query.mock.calls[0][0])).not.toMatch(/SELECT \* FROM job_items/i);
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThan(8192);
    query.mockClear();
    expect((await jobs.list(scope)).value).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();
    const first = await jobs.items(submitted.id, identity, { limit: 100, revision: metadata.resultRevision });
    expect(first.value).toHaveLength(100);
    expect(first.counts.total).toBe(5000);
    const middle = await jobs.items(submitted.id, identity, { limit: 100, revision: first.revision, cursor: first.page.nextCursor! });
    expect(middle.value[0].id).toBe("package-00100");
    const previous = await jobs.items(submitted.id, identity, { limit: 100, revision: first.revision, cursor: middle.page.previousCursor! });
    expect(previous.value).toEqual(first.value);
    let last = middle, observed = first.value.length + middle.value.length;
    while (last.page.nextCursor) {
      last = await jobs.items(submitted.id, identity, { limit: 100, revision: first.revision, cursor: last.page.nextCursor });
      expect(last.value.length).toBeLessThanOrEqual(100);
      expect(Buffer.byteLength(JSON.stringify(last))).toBeLessThanOrEqual(1_048_576);
      observed += last.value.length;
    }
    expect(observed).toBe(5000);
    expect(last.value.at(-1)?.id).toBe("package-04999");
    expect(last.page.previousCursor).toEqual(expect.any(String));
    expect(last.page.nextCursor).toBeNull();
    expect(() => jobs.items(submitted.id, identity, { limit: 101 })).toThrowError(expect.objectContaining({ code: "invalid_cursor" }));
    expect(() => jobs.items(submitted.id, identity, { cursor: first.page.nextCursor! })).toThrowError(expect.objectContaining({ code: "invalid_cursor" }));
    await expect(jobs.items(submitted.id, identity, { revision: first.revision, cursor: `${first.page.nextCursor!}x` })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(jobs.items(submitted.id, { ...identity, principalId: "other" })).rejects.toMatchObject({ status: 404 });
    await expect(jobs.items(submitted.id, { ...identity, tenantId: "other" })).rejects.toMatchObject({ status: 404 });
    await expect(jobs.items(submitted.id, { ...identity, sessionEpoch: String(BigInt(identity.sessionEpoch) + 1n) })).rejects.toMatchObject({ status: 404 });
    await expect(jobs.items(submitted.id, { ...identity, authorizationHash: "other" },
      { revision: first.revision, cursor: first.page.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    await fixture.runtime.query("UPDATE job_items SET message='Updated' WHERE job_id=$1 AND ordinal=4999", [submitted.id]);
    await expect(jobs.items(submitted.id, identity, { revision: first.revision, cursor: first.page.nextCursor! }))
      .rejects.toMatchObject({ code: "selection_invalidated" });
    expect(BigInt((await jobs.get(submitted.id, scope))!.resultRevision)).toBeGreaterThan(BigInt(first.revision));
    await fixture.runtime.query("UPDATE job_items SET message=repeat(chr(1),1024) WHERE job_id=$1 AND ordinal<100", [submitted.id]);
    const byteShort = await jobs.items(submitted.id, identity, { limit: 100 });
    expect(byteShort.value.length).toBeGreaterThan(0);
    expect(byteShort.value.length).toBeLessThan(100);
    expect(byteShort.page.nextCursor).toEqual(expect.any(String));
    expect(Buffer.byteLength(JSON.stringify(byteShort))).toBeLessThanOrEqual(1_048_576);
    const continuation = await jobs.items(submitted.id, identity, { limit: 100, revision: byteShort.revision, cursor: byteShort.page.nextCursor! });
    expect(continuation.value[0].id).toBe(`package-${String(byteShort.value.length).padStart(5, "0")}`);
    expect((await jobs.items(submitted.id, identity, { limit: 100, revision: byteShort.revision, cursor: continuation.page.previousCursor! })).value).toEqual(byteShort.value);
  });
});
