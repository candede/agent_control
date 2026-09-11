import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appRoles } from "../types/capability.js";
import { capabilityDefinitions } from "./capabilityRegistry.js";

function readRepositoryFile(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)), "utf8");
}

describe("capability documentation artifacts", () => {
  it("keeps the Entra manifest aligned with the exact app-role contract", () => {
    const manifest = JSON.parse(readRepositoryFile("infra/entra-app-manifest.json")) as Record<string, unknown>;
    const roles = manifest.appRoles as Array<Record<string, unknown>>;

    expect(roles.map(role => role.value)).toEqual(appRoles);
    expect(new Set(roles.map(role => role.id)).size).toBe(appRoles.length);
    expect(roles.every(role => role.isEnabled === true)).toBe(true);
    expect(roles.every(role => JSON.stringify(role.allowedMemberTypes) === JSON.stringify(["User"]))).toBe(true);
    expect(manifest).not.toHaveProperty("requiredResourceAccess");
  });

  it("lists every registry capability exactly once with its source", () => {
    const inventory = readRepositoryFile("docs/provider-contract-inventory-2026-09-08.md");

    expect(inventory).toContain("Inventory date: 2026-09-08");
    for (const definition of capabilityDefinitions) {
      expect(inventory.split(`\`${definition.id}\``)).toHaveLength(2);
      for (const source of definition.sources) expect(inventory).toContain(source);
    }
  });

  it("documents the exact prepared-vault contract and excludes the admin password from runtime", () => {
    const setup = readRepositoryFile("docs/deployment-setup.md");
    const bindingReadme = readRepositoryFile("plans/admin-poc-production/README.md");
    const documentedNames = [...setup.matchAll(/^\| `((?:agent-control-)[^`]+)` \|/gm)].map(match => match[1]);
    const contractNames = [...bindingReadme.matchAll(/^\| `(agent-control-[^`]+)`\s+\|/gm)].map(match => match[1]);

    expect(documentedNames).toEqual([
      "agent-control-tenant-id",
      "agent-control-client-id",
      "agent-control-client-secret",
      "agent-control-session-secret",
      "agent-control-postgres-admin-password",
      "agent-control-postgres-app-password",
    ]);
    expect(documentedNames).toEqual(contractNames);
    expect(setup).toContain("Only the five rows other than `agent-control-postgres-admin-password`");
    expect(setup).not.toContain("agent-control-evidence-expiry");
  });
});