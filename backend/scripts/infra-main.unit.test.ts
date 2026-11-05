import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(new URL("../../infra/main.bicep", import.meta.url), "utf8");
const parameters = readFileSync(new URL("../../infra/main.bicepparam", import.meta.url), "utf8");
const logRules = [...main.matchAll(/^resource \w+ 'Microsoft\.Insights\/scheduledQueryRules@[^']+' = \{[\s\S]*?^\}/gm)]
  .map(([rule]) => rule);

describe("API infrastructure contracts", () => {
  it("keeps the parameter example aligned with the current required inputs", () => {
    const declarations = [...main.matchAll(/^param (\w+) (.+)$/gm)];
    const assignments = [...parameters.matchAll(/^param (\w+) = /gm)].map(([, name]) => name);
    const declaredNames = declarations.map(([, name]) => name);
    expect(assignments.filter(name => !declaredNames.includes(name))).toEqual([]);
    expect(declarations.filter(([, , type]) => !type.includes(" = "))
      .map(([, name]) => name).filter(name => !assignments.includes(name))).toEqual([]);
    expect(parameters).toMatch(/^param tenantRegistrySecretName = 'agent-control-tenants-json'$/m);
    expect(parameters).toMatch(/^param tenantRegistrySecretVersion = '[^']+'$/m);
  });

  it("creates enabled log alerts before the first console log creates its table", () => {
    expect(logRules).toHaveLength(3);
    for (const rule of logRules) {
      expect(rule).toMatch(/^\s+enabled: true$/m);
      expect(rule).toMatch(/^\s+skipQueryValidation: true$/m);
    }
  });

  it("isolates API event counts from other applications sharing its workspace", () => {
    expect(logRules).toHaveLength(3);
    for (const rule of logRules) {
      expect(rule).toContain('query: \'AppServiceConsoleLogs | where _ResourceId =~ "${appService.id}" | extend AgentControlEvent');
    }
  });
});
