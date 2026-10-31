import { describe, expect, it } from "vitest";
import { currentSchemaSql } from "./currentSchema.js";
import { readableReportVersionSql } from "./reportCapacitySchema.js";

describe("current official report schema contracts", () => {
  it("permits only the current report audit actions", () => {
    const actions = currentSchemaSql.match(
      /CONSTRAINT official_usage_audit_action_check CHECK \(action IN \(([^)]*)\)\)/,
    )?.[1].match(/'([^']+)'/g);
    expect(actions).toEqual(["'staged'", "'accepted'", "'deleted'", "'discarded'"]);
  });

  it("reserves report confirmations for deletion, not personal report selection", () => {
    expect(currentSchemaSql).toContain(
      "official_usage_confirmations_operation_check CHECK (operation = CAST('delete' AS text))",
    );
  });

  it("allows associations to readable published history independently of the default head", () => {
    const guard = currentSchemaSql.match(
      /CREATE FUNCTION protect_agent_usage_association\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
    )?.[1];
    expect(guard).toContain("public.official_usage_history_memberships");
    expect(guard).toContain("history.valid_to_revision IS NULL");
    expect(guard).not.toContain("official_usage_state");
    expect(guard).toContain("AND 3=(SELECT count(*)");
    expect(guard).toContain(readableReportVersionSql("v.id", "v.tenant_id", "v.kind", "v.row_count"));
    expect(guard).toContain("source.authority_expires_at>clock_timestamp()");
  });
});
