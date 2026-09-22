import { describe, expect, it, vi } from "vitest";
import { PurviewAuditRepository, type PurviewAuditScope } from "./purviewAudit.js";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./pool.js", () => ({
  pool: { query: mocks.query },
  secretValue: () => undefined,
  transaction: async (_database: unknown, work: (client: { query: typeof mocks.query }) => Promise<unknown>) =>
    work({ query: mocks.query }),
}));

const scope: PurviewAuditScope = {
  tenantId: "tenant-a", authorizationPrincipalId: "reader-a", tokenMode: "delegated",
  resultScope: { kind: "principal", scopeId: "reader-a", configurationRevision: null },
};
const id = "11111111-1111-4111-8111-111111111111";
const execution = { owner: "22222222-2222-4222-8222-222222222222", version: 1 };

describe("Purview audit failure persistence", () => {
  it.each([false, true])("derives remote continuation from the locked provider state, not inconclusive=%s", async inconclusive => {
    const repository = new PurviewAuditRepository();
    const getJob = vi.spyOn(repository, "getJob").mockResolvedValue(undefined);
    try {
      for (const attempted of [false, true]) {
        for (const status of [null, "notStarted", "running", "succeeded", "failed", "cancelled", "unknownFutureValue"]) {
          mocks.query.mockReset();
          mocks.query.mockResolvedValue({ rows: [], rowCount: 1 }).mockResolvedValueOnce({
            rows: [{ attempted_at: attempted ? new Date() : null, provider_status: status }], rowCount: 1,
          });
          await repository.fail(scope, id, execution, "provider_throttled", "Provider polling was throttled.", inconclusive);
          expect(mocks.query.mock.calls[0]).toEqual([
            expect.stringContaining("FOR UPDATE"),
            [id, scope.tenantId, "principal", "reader-a", null, "reader-a", "delegated", execution.owner, execution.version, ["running", "reconciling_create"]],
          ]);
          const remoteWorkMayContinue = attempted && (status === null || status === "notStarted" || status === "running");
          expect(mocks.query.mock.calls[1]).toEqual([
            expect.stringContaining("remote_work_may_continue=$7,"),
            [id, scope.tenantId, "reader-a", inconclusive ? "inconclusive" : "failed", "provider_throttled",
              "Provider polling was throttled.", remoteWorkMayContinue, execution.owner, execution.version],
          ]);
        }
      }
    } finally {
      getJob.mockRestore();
    }
  });
});
