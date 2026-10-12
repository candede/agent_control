import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appRoles } from "../types/capability.js";
import { copilotAppActivityPeriod, copilotAppActivityReportVersion } from "../types/copilotUsage.js";
import { capabilityDefinitions } from "./capabilityRegistry.js";
import { buildCopilotReportUrl } from "./userSourceGraphFields.js";

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

  it("documents every required permission and links the current capability/source registry", () => {
    const inventory = readRepositoryFile("docs/provider-contract-inventory-2026-09-08.md");

    expect(inventory).toContain("](../backend/src/services/capabilityRegistry.ts)");
    for (const permission of new Set(capabilityDefinitions.flatMap(definition => definition.permissions))) {
      expect(inventory).toContain(`\`${permission}\``);
    }
  });

  it("documents the current Copilot report endpoint and activity window", () => {
    const inventory = readRepositoryFile("docs/provider-contract-inventory-2026-09-08.md");
    const row = inventory.split("\n").find(line => line.startsWith("| `reports.copilotUsage.read` |"));
    const activityDescription = readRepositoryFile("docs/copilot-license-usage.md").split("\n")
      .find(line => line.startsWith("Imported response counts and last activity"));

    expect(row?.match(/`GET ([^`]+)`/)?.[1]).toBe(new URL(buildCopilotReportUrl()).pathname);
    expect(row).toContain(`Required ${copilotAppActivityReportVersion} CSV headers`);
    expect(activityDescription).toContain(
      `The current ${copilotAppActivityPeriod}/${copilotAppActivityReportVersion} Microsoft report supplies`,
    );
  });

  it("documents the exact prepared-vault contract and excludes the admin password from runtime", () => {
    const setup = readRepositoryFile("docs/azure-production-deployment.md");
    const documentedNames = [...setup.matchAll(/^\| `((?:agent-control-)[^`]+)` \|/gm)].map(match => match[1]);
    const { preparedVaultContract } = JSON.parse(readRepositoryFile("infra/production-target.example.json"));
    const runtimeDescription = readRepositoryFile("docs/security-model.md").split("\n")
      .find(line => line.startsWith("- Azure runtime configuration"));
    const rotationDescription = readRepositoryFile("docs/operations.md").split("\n")
      .find(line => line.startsWith("Follow the") && line.includes("runtime-consumer contract"));

    expect(documentedNames).toEqual([
      "agent-control-tenants-json",
      "agent-control-session-secret",
      "agent-control-postgres-admin-password",
      "agent-control-postgres-app-password",
    ]);
    expect(setup).toContain("Only the three rows other than `agent-control-postgres-admin-password`");
    expect(setup).not.toContain("agent-control-evidence-expiry");
    expect(documentedNames).toEqual(preparedVaultContract.secretNames);
    expect(preparedVaultContract.runtimeConsumers).toEqual(
      documentedNames.filter(name => name !== "agent-control-postgres-admin-password"),
    );
    expect(runtimeDescription).toContain(
      `uses ${preparedVaultContract.runtimeConsumers.length} native Key Vault references: \`TENANTS_JSON\`, \`SESSION_SECRET\`, and \`PGPASSWORD\``,
    );
    expect(rotationDescription).toContain(
      `${documentedNames.length}-name/${preparedVaultContract.runtimeConsumers.length}-runtime-consumer contract`,
    );
  });
});