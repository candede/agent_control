import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { purviewAuditPresets } from "../types/purviewAudit.js";
import { capabilityDefinitions } from "./capabilityRegistry.js";
import { createProviderQueryBody, validatePurviewAuditFilters } from "./graphAuditSearch.js";

function readRepositoryFile(path: string) {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

const guide = readRepositoryFile("docs/purview-audit-search.md");

describe("Purview reader workflow documentation", () => {
  it("uses a valid current search example and preset contract", () => {
    const examples = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map(match => JSON.parse(match[1]) as { tokenMode: string; filters: Record<string, unknown> });
    expect(examples).toHaveLength(1);
    const example = examples[0];
    expect(example.tokenMode).toBe("delegated");
    const filters = validatePurviewAuditFilters({
      ...example.filters,
      startDateTime: "2030-01-02T10:00:00.000Z",
      endDateTime: "2030-01-02T11:00:00.000Z",
    }, { now: new Date("2030-01-02T12:00:00.000Z") });
    expect(example.filters.startDateTime).toBe("<recent UTC start ending in Z>");
    expect(example.filters.endDateTime).toBe("<later UTC end ending in Z>");
    expect(filters.userPrincipalNames).toEqual(["person@example.invalid"]);
    const providerBody = createProviderQueryBody("agent-control-audit:11111111-1111-4111-8111-111111111111", filters);
    expect(providerBody).toMatchObject({
      serviceFilter: "Copilot",
      recordTypeFilters: ["copilotInteraction"],
      operationFilters: ["CopilotInteraction"],
      userPrincipalNameFilters: filters.userPrincipalNames,
    });
    expect(providerBody).not.toHaveProperty("serviceFilters");
    expect(providerBody).not.toHaveProperty("keywordFilter");
    for (const [id, preset] of Object.entries(purviewAuditPresets)) {
      expect(guide).toContain(`\`${id}\``);
      expect(guide).toContain(`\`${preset.serviceFilter}\``);
      for (const type of preset.recordTypeFilters) expect(guide).toContain(`\`${type}\``);
    }
  });

  it("documents every registered Audit Search route without inventing one", () => {
    const routes = readRepositoryFile("backend/src/routes/purviewAudit.ts");
    const registered = [...routes.matchAll(/policyRoute\(purviewAuditRouter, "(get|post|delete)", "([^"]+)"/g)]
      .map(match => `${match[1].toUpperCase()} /api${match[2]}`);
    const documented = [...guide.matchAll(/\b(GET|POST|DELETE) (\/api\/audit-search\/[^`\s]+)/g)]
      .map(match => `${match[1]} ${match[2].split("?")[0]}`);
    expect(new Set(documented)).toEqual(new Set(registered));
  });

  it("keeps the Microsoft grants and application sharing route source-backed", () => {
    for (const definition of capabilityDefinitions.filter(value => value.id.startsWith("purview.audit.search."))) {
      for (const permission of definition.permissions) expect(guide).toContain(`\`${permission}\``);
      for (const role of definition.providerRoles) expect(guide).toContain(`**${role}**`);
    }
    const configuration = guide.match(/`PUT \/api\/capabilities\/([^/]+)\/configuration`/);
    expect(configuration?.[1]).toBe("purview.audit.search.application");
    const settings = guide.match(/`(\{"enabled":true,"sharedDataScope":true\})`/);
    expect(JSON.parse(settings![1])).toEqual({ enabled: true, sharedDataScope: true });
    expect(readRepositoryFile("backend/src/routes/capabilities.ts"))
      .toContain('"put", "/capabilities/:id/configuration"');
  });
});
