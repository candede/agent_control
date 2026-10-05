import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { prepareTestSchemaTemplate, testSchemaTemplateIdentity } from "./testDatabaseTemplate.js";

afterEach(() => { vi.unstubAllEnvs(); });

describe("owned isolated schema template identity", () => {
  it("is scoped to a guarded base database and the current schema fingerprint", () => {
    const first = testSchemaTemplateIdentity("agentcontrol_test_first");
    expect(first.name).toMatch(/^agentcontrol_test_schema_[a-f0-9]{32}$/);
    expect(first.name.length).toBeLessThanOrEqual(63);
    expect(first).toEqual(testSchemaTemplateIdentity("agentcontrol_test_first"));
    expect(testSchemaTemplateIdentity("agentcontrol_test_second")).not.toEqual(first);
    expect(() => testSchemaTemplateIdentity("agentcontrol")).toThrow("test_schema_template_scope");
  });

  it("does not enable templates outside the explicitly isolated fixture", async () => {
    vi.stubEnv("AGENT_CONTROL_ISOLATED_TESTS", undefined);
    const connect = vi.fn();
    expect(await prepareTestSchemaTemplate({ connect } as unknown as pg.Pool, { database: "agentcontrol_test_base" }, "synthetic")).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    { owner: "someone_else" },
    { datallowconn: true },
    { marker: "unowned" },
  ])("refuses a pre-existing template with a mismatched ownership or seal: %j", async difference => {
    vi.stubEnv("AGENT_CONTROL_ISOLATED_TESTS", "1");
    const identity = testSchemaTemplateIdentity("agentcontrol_test_base");
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FROM pg_database")
      ? [{ owner: "agentcontrol_admin", datallowconn: false, marker: identity.marker, ...difference }] : [] }));
    const release = vi.fn(), client = { query, release };
    await expect(prepareTestSchemaTemplate({ connect: async () => client } as unknown as pg.Pool,
      { database: "agentcontrol_test_base" }, "synthetic")).rejects.toThrow("test_schema_template_identity");
    expect(query.mock.calls.some(([sql]) => /\b(CREATE|DROP|ALTER|COMMENT)\b/.test(sql))).toBe(false);
    expect(query).toHaveBeenLastCalledWith("SELECT pg_advisory_unlock(hashtextextended($1,0))", [identity.marker]);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
