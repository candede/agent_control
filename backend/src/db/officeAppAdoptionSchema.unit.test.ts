import { describe, expect, it, vi } from "vitest";
import { officeAppAdoptionSchemaSql, verifyOfficeAppAdoptionSchema } from "./officeAppAdoptionSchema.js";

async function verificationQuery() {
  const query = vi.fn().mockResolvedValue({ rows: [{ valid: true }] });
  await verifyOfficeAppAdoptionSchema({ query });
  const [statement, values] = query.mock.calls[0];
  return { statement: String(statement), values };
}

describe("Office schema verification without a database", () => {
  it("requires every table grant rather than PostgreSQL's any-privilege list", async () => {
    const { statement } = await verificationQuery();
    for (const table of ["office_observations", "office_person_facts", "office_group_facts"]) {
      for (const privilege of ["SELECT", "INSERT", "DELETE"]) {
        expect(statement).toContain(`has_table_privilege('agentcontrol_app','public.${table}','${privilege}')`);
      }
      expect(statement).not.toContain(`'public.${table}','SELECT,INSERT,DELETE'`);
      expect(statement).toContain(`NOT has_table_privilege('agentcontrol_app','public.${table}','UPDATE,TRUNCATE')`);
    }
    for (const column of ["coverage", "metrics"]) {
      expect(statement).toContain(`has_column_privilege('agentcontrol_app','public.office_observations','${column}','UPDATE')`);
    }
    expect(statement).toContain("a.attname NOT IN ('coverage','metrics')");
    expect(statement).toContain("has_column_privilege('agentcontrol_app',a.attrelid,a.attnum,'UPDATE')");
    for (const table of ["office_person_facts", "office_group_facts"]) {
      expect(statement).toContain(`NOT has_any_column_privilege('agentcontrol_app','public.${table}','UPDATE')`);
    }
  });

  it("binds every evidence trigger to its table, timing, function and transition rows", async () => {
    const { statement } = await verificationQuery();
    for (const tuple of [
      "('public.office_observations','office_observation_guard',31,NULL)",
      "('public.office_person_facts','office_person_guard',27,NULL)",
      "('public.office_person_facts','office_person_insert_guard',4,'office_inserted_facts')",
      "('public.office_group_facts','office_group_guard',27,NULL)",
      "('public.office_group_facts','office_group_insert_guard',4,'office_inserted_facts')",
    ]) expect(statement).toContain(tuple);
    expect(statement).toContain("t.tgrelid=to_regclass(expected.table_name)");
    expect(statement).toContain("t.tgname=expected.trigger_name");
    expect(statement).toContain("t.tgtype=expected.trigger_type");
    expect(statement).toContain("t.tgfoid=to_regprocedure('public.office_evidence_guard()')");
    expect(statement).toContain("t.tgnewtable IS NOT DISTINCT FROM expected.transition_rows");
    expect(statement).toContain("t.tgoldtable IS NULL");
    expect(statement).toContain("t.tgqual IS NULL");
    expect(statement).toContain("NOT t.tgisinternal AND t.tgenabled='O'");
  });

  it("requires the enabled source-clear trigger and unchanged fenced guard bodies", async () => {
    const { statement, values } = await verificationQuery();
    expect(statement).toContain("t.tgrelid='public.data_scope_epochs'::regclass");
    expect(statement).toContain("t.tgname='office_source_clear'");
    expect(statement).toContain("t.tgtype=17");
    expect(statement).toContain("t.tgfoid=to_regprocedure('public.office_source_clear()')");
    expect(statement).toContain("t.tgattr::text=epoch.attnum::text");
    expect(statement).toContain("WHEN ((new.source = ANY (ARRAY[''directory''::text, ''app_activity''::text])))");
    expect(values).toEqual(["office_evidence_guard", "office_source_clear"].map(name =>
      officeAppAdoptionSchemaSql.match(new RegExp(`CREATE FUNCTION ${name}\\(\\)[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1]));
    expect(statement).toContain("p.prosrc=$1 AND NOT p.prosecdef");
    expect(statement).toContain("p.prosrc=$2 AND p.prosecdef");
    expect(statement).toContain("p.proconfig=ARRAY['search_path=pg_catalog, public']");
    for (const name of ["office_evidence_guard", "office_source_clear"]) {
      expect(statement).toContain(`NOT has_function_privilege('agentcontrol_app','public.${name}()','EXECUTE')`);
    }
  });

  it("checks composite foreign-key owners and columns, not just constraint names", async () => {
    const { statement } = await verificationQuery();
    for (const tuple of [
      "('public.office_observations','public.data_generations')",
      "('public.office_person_facts','public.office_observations')",
      "('public.office_group_facts','public.office_observations')",
    ]) expect(statement).toContain(tuple);
    expect(statement).toContain("c.conrelid=to_regclass(expected.table_name)");
    expect(statement).toContain("c.confrelid=to_regclass(expected.parent_table)");
    expect(statement).toContain("c.contype='f' AND c.convalidated");
    expect(statement).toContain("c.conkey=ARRAY[1,2,3]::smallint[] AND c.confkey=ARRAY[1,2,3]::smallint[]");
    expect(statement).toContain("c.confdeltype='a' AND c.confupdtype='a'");
    expect(statement).toContain("NOT c.condeferrable AND NOT c.condeferred");
  });

  it.each([{ rows: [] }, { rows: [{ valid: false }] }, { rows: [{ valid: null }] }])("rejects an absent or invalid contract: %j", async ({ rows }) => {
    const query = vi.fn().mockResolvedValue({ rows });
    await expect(verifyOfficeAppAdoptionSchema({ query })).rejects.toThrow("office_app_adoption_schema");
  });

  it("propagates a catalog query failure", async () => {
    const failure = new Error("catalog unavailable");
    const query = vi.fn().mockRejectedValue(failure);
    await expect(verifyOfficeAppAdoptionSchema({ query })).rejects.toBe(failure);
  });
});
