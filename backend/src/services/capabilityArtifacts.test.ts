import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isDeferredSecurityCapability } from "../../../frontend/src/deferredSecurityUi.js";
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
    const inventory = readRepositoryFile("docs/provider-contracts.md");

    expect(inventory).toContain("](../backend/src/services/capabilityRegistry.ts)");
    for (const permission of new Set(capabilityDefinitions.flatMap(definition => definition.permissions))) {
      expect(inventory).toContain(`\`${permission}\``);
    }
  });

  it.each([
    ["README.md", "## App registration permissions", "## Usage report access"],
    ["docs/user-roles-and-permissions.md", "## App registration permissions", "## CSV downloads and report import"],
    ["docs/deployment-setup.md", "### 5. Add API permissions", "## Start locally"],
    ["docs/provider-contracts.md", "## App registration permissions", "## Authorization and saved scope"],
    ["infra/entra-id-api-mcp-app-registrations.md", "## App registration permissions", "## Synchronization and reports"],
  ])("keeps %s aligned with the current Permissions page groups", (path, start, end) => {
    const document = readRepositoryFile(path);
    const startIndex = document.indexOf(`${start}\n`);
    const endIndex = document.indexOf(`${end}\n`, startIndex);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    const section = document.slice(startIndex, endIndex);
    const definitions = capabilityDefinitions.filter(definition => !isDeferredSecurityCapability(definition.id)
      && definition.probe.adapterRegistered && definition.mode !== "local");
    const groups = [
      ["Microsoft Graph / Application", definitions.filter(definition => definition.provider === "Microsoft Graph"
        && definition.mode === "application").flatMap(definition => definition.permissions)],
      ["Microsoft Graph / Delegated", definitions.filter(definition => definition.provider === "Microsoft Graph"
        && definition.mode === "delegated").flatMap(definition => definition.permissions)],
      ["Power Platform / Delegated", definitions.filter(definition => definition.provider === "Power Platform")
        .flatMap(definition => definition.permissions)],
      ["Sign-in / OpenID Connect", ["openid", "profile", "offline_access"]],
    ] as const;
    const headings = [...section.matchAll(/^#{3,4} (Microsoft Graph \/ (?:Application|Delegated)|Power Platform \/ Delegated|Sign-in \/ OpenID Connect)$/gm)];
    expect(headings.map(match => match[1])).toEqual(groups.map(([label]) => label));
    for (const [index, [, permissions]] of groups.entries()) {
      const groupSection = section.slice(headings[index].index, headings[index + 1]?.index ?? section.length);
      const documented = [...groupSection.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);
      expect(documented.sort()).toEqual([...new Set(permissions)].sort());
    }
    expect(section).not.toMatch(/AgentControl\.(?:Viewer|UsageReportUploader|Admin)/);
    const packagePermission = section.split("\n").find(line => line.startsWith("| `CopilotPackages.ReadWrite.All` |"));
    expect(packagePermission).toContain("Recommended signed-in administrator role: **AI Administrator**");
    expect(packagePermission).toContain("**Global Administrator** is a broader alternative");
    expect(packagePermission).toContain("delegated tenant admin consent");
    expect(packagePermission).toContain("Microsoft Agent 365 license");
    expect(packagePermission).toContain("delegated work or school accounts only");
    expect(section).toContain("both application and delegated forms");
    expect(section).toMatch(/application form does not authorize\s+these writes/);
    expect(section.replace(/\s+/g, " ")).toContain("not a confirmed exclusive API role requirement");
    expect(section.replace(/\s+/g, " ")).toContain("Microsoft 365 admin center");
    expect(section).not.toContain("no additional Entra administrator-role requirement");
    expect(section).toContain("**AI Reader**");
    for (const role of ["AI Administrator", "Power Platform Administrator", "Global Administrator"]) {
      expect(section).toContain(`**${role}**`);
    }
  });

  it("documents the current Copilot report endpoint and activity window", () => {
    const inventory = readRepositoryFile("docs/provider-contracts.md");
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