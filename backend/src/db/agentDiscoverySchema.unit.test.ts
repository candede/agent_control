import { describe, expect, it, vi } from "vitest";
import { agentDiscoverySchemaSql, verifyAgentDiscoverySchema } from "./agentDiscoverySchema.js";
import { parseDirectoryUser } from "../services/userSourceGraphFields.js";

describe("discovery text SQL source contract", () => {
  it.each(["李", "Ｘ", "ﬃ"])("accepts the single-character directory name %s that must be redacted", name => {
    const id = "80000000-0000-4000-8000-000000000001";
    const person = parseDirectoryUser({
      id, userPrincipalName: "owner@example.invalid", displayName: name,
      assignedLicenses: [], assignedPlans: [], accountEnabled: true, userType: "Member",
    }, new Map(), { kind: "reported", identities: [id] });
    expect(person?.identity.displayName).toBe(name);
    expect(agentDiscoverySchemaSql).toContain("SELECT DISTINCT normalize(item,NFKC) AS token");
    expect(agentDiscoverySchemaSql).toContain("WHERE item IS NOT NULL AND item<>''");
    expect(agentDiscoverySchemaSql).not.toContain("length(item)>1");
  });

  it("replaces all identity tokens in one pass without rewriting markers or shorter-name fragments", () => {
    expect(agentDiscoverySchemaSql).toContain("FROM jsonb_array_elements(evidence) person");
    expect(agentDiscoverySchemaSql).toContain("ARRAY[person->>'id',person->>'name',person->>'contact']");
    expect(agentDiscoverySchemaSql).toContain(String.raw`regexp_replace(token,'([\\.^$|?*+(){}\[\]])','\\\1','g')`);
    expect(agentDiscoverySchemaSql).toContain("'|' ORDER BY length(token) DESC,token COLLATE \"C\"");
    expect(agentDiscoverySchemaSql).toMatch(/IF identity_pattern IS NOT NULL THEN\s+result := regexp_replace\(result,identity_pattern,'\[identity withheld\]','gi'\);/);
    expect(agentDiscoverySchemaSql).not.toMatch(/FOR (person|token)\b/);
  });
});

describe("discovery schema verification", () => {
  it("accepts the installed current function", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ valid: true }] });
    await expect(verifyAgentDiscoverySchema({ query })).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(
      "to_regprocedure('discovery_safe_text(text,jsonb,boolean,boolean)') IS NOT NULL",
    ));
  });

  it.each([{ rows: [] }, { rows: [{ valid: false }] }])("rejects a missing current function: %j", async ({ rows }) => {
    const query = vi.fn().mockResolvedValue({ rows });
    await expect(verifyAgentDiscoverySchema({ query })).rejects.toThrow("discovery_schema_invalid");
  });
});
