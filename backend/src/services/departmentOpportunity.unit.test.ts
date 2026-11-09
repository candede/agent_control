import pg from "pg";
import { describe, expect, it } from "vitest";
import { DepartmentOpportunities, boundedOpportunity, opportunityRelations } from "./departmentOpportunity.js";
import { OfficeAppAdoptionReads } from "./officeAppAdoptionReads.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import type { OfficeContext } from "../types/officeAppAdoption.js";
import type { ReportReadContext } from "./largeTenantUsersReports.js";
import { emptyOfficeCoverage } from "./officeAppAdoption.js";

const office: OfficeContext = {
  observation: { id: "11111111-1111-4111-8111-111111111111", kind: "current", period: "D28", reportVersion: "v2",
    reportRefreshDate: "2026-11-01", windowStart: "2026-10-05", capturedAt: "2026-11-01", expiresAt: "2027-11-01",
    contentHash: "a", directoryGenerationId: "d", appGenerationId: "a", directoryObservedAt: "2026-11-01",
    appObservedAt: "2026-11-01", coverage: emptyOfficeCoverage() },
  query: { company: null, department: "Finance" }, baseline: null,
  status: { state: "available", message: null, errorCode: null },
  selection: { id: "s", revision: "r", evaluatedAt: "2026-11-01", validatedAt: "2026-11-01", expiresAt: "2026-11-01",
    publicationRevisions: { users: "1", graph_packages: "1", power_platform: "1" } },
};
const report = { identity: selectionIdentity, evaluatedAt: new Date("2026-11-01"), query: { lowResponseThreshold: 5 },
  report: { setId: "set", lineages: [{ kind: "users" }, { kind: "userAgents" }] } } as ReportReadContext;
describe("department opportunity bounds and exact shared identity SQL", () => {
  it("uses the whole frozen observation and existing ambiguity SQL before group filtering", () => {
    const result = opportunityRelations(office, report);
    expect(result.sql).toContain("FROM office_person_facts WHERE generation_id=$1 AND true");
    expect(result.sql).toContain("ambiguous_directory_identities");
    expect(result.sql).toContain("count(*) OVER(PARTITION BY identity) AS identity_count");
    expect(result.sql).toContain("coalesce(agents_used,0)>0");
    expect(result.sql.indexOf("ambiguous_directory_identities")).toBeLessThan(result.sql.indexOf("matching_groups"));
    expect(result.sql).not.toContain("directory_user_rows");
    expect(result.values).toEqual([office.observation!.id, JSON.stringify(office.query), report.evaluatedAt,
      selectionIdentity.tenantId, "set", 5]);
    expect(result.complete).toBe(true);
  });
  it("requires complete user evidence for negatives but permits definite positives", () => {
    const result = opportunityRelations(office, { ...report, report: { ...report.report, lineages: [] } });
    expect(result.complete).toBe(false);
    expect(result.sql).toContain("WHEN false AND NOT unresolved THEN 'no_reported'");
    expect(result.sql).toContain("THEN 'positive'");
  });
  it("keeps weekly aggregates while removing the person identity basis", () => {
    expect(opportunityRelations({ ...office, observation: { ...office.observation!, kind: "weekly" } }, report).sql)
      .toContain("FROM office_person_facts WHERE generation_id=$1 AND false");
  });
  it.each(["current", "weekly"] as const)("ranks %s groups by saved Office-active counts, independently of person evidence", kind => {
    const { sql } = opportunityRelations({ ...office, observation: { ...office.observation!, kind } }, report);
    expect(sql).toContain(`row_number() OVER(ORDER BY coalesce(c.no_reported,'0')::bigint DESC,
        (g.metrics->>'reportedActiveUsers')::bigint DESC,g.id COLLATE "C")::int AS rank`);
    expect(sql).not.toContain("coalesce(c.office_active,'0')::bigint DESC");
  });
  it("measures UTF-8 and explicitly rejects aggregate/child overflows", () => {
    const body = { text: "🧭".repeat(32765) };
    expect(boundedOpportunity(body)).toBe(body);
    expect(() => boundedOpportunity({ text: "🧭".repeat(32768) })).toThrow(expect.objectContaining({ code: "opportunity_response_bytes" }));
  });
  it("accepts exactly 128 KiB UTF-8 and rejects the next byte", () => {
    const text = "🧭".repeat(32765) + "a";
    const boundary = { text };
    expect(Buffer.byteLength(JSON.stringify(boundary))).toBe(131072);
    expect(boundedOpportunity(boundary)).toBe(boundary);
    const over = { text: text + "c" };
    expect(Buffer.byteLength(JSON.stringify(over))).toBe(131073);
    expect(() => boundedOpportunity(over)).toThrow(expect.objectContaining({
      code: "opportunity_response_bytes", status: 413,
    }));
  });
  it.each([0, 11, 100, 1.5, Number.NaN])("rejects unsupported group limit %s before capture", async limit => {
    const db = new pg.Pool({ max: 4 });
    const reads = new DepartmentOpportunities(new LargeTenantUsersReports(db, "synthetic-evidence-cursor-secret-32", 35),
      new OfficeAppAdoptionReads(db, "synthetic-evidence-cursor-secret-32"), new InventoryQueries(db, "synthetic-evidence-cursor-secret-32", 35));
    expect(() => reads.page(selectionIdentity, {}, { limit })).toThrow(expect.objectContaining({ code: "invalid_opportunity_limit" }));
    await db.end();
  });
});
