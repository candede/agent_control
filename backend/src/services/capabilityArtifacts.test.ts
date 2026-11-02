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
    const permissions = readRepositoryFile("docs/user-roles-and-permissions.md");

    expect(inventory).toContain("](../backend/src/services/capabilityRegistry.ts)");
    for (const permission of new Set(capabilityDefinitions.flatMap(definition => definition.permissions))) {
      expect(`${permissions}\n${inventory}`).toContain(`\`${permission}\``);
    }
  });

  it.each([
    ["README.md", "## App registration permissions", "## Usage report access"],
    ["docs/user-roles-and-permissions.md", "## App registration permissions", "## CSV downloads and report import"],
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
  });

  it.each([
    "docs/deployment-setup.md",
    "docs/provider-contracts.md",
    "docs/security-model.md",
  ])("links %s to the authoritative permission reference", path => {
    expect(readRepositoryFile(path)).toMatch(
      /\]\(user-roles-and-permissions\.md(?:#[^)]+)?\)/,
    );
  });

  it("explains permission purposes and provider requirements in the authoritative reference", () => {
    const reference = readRepositoryFile("docs/user-roles-and-permissions.md");
    const normalized = reference.replace(/\s+/g, " ");
    const delegated = normalized.split("### Microsoft Graph / Delegated")[1]
      .split("### Power Platform / Delegated")[0];
    const reportPermission = reference.split("\n").find(line => line.startsWith("| `Reports.Read.All` |"));
    const catalogPermission = reference.split("\n").find(line => line.startsWith("| `LicenseAssignment.Read.All` |"));

    expect(reportPermission).toMatch(/per-user.*Copilot.*Office apps/);
    expect(reportPermission).toContain("28 days");
    expect(reportPermission).toMatch(/dashboard.*Users/);
    expect(catalogPermission).toMatch(/catalog.*identify Copilot entitlement/);
    expect(normalized).toContain("Grant admin consent");
    expect(normalized).toContain("signed-in user does not need Microsoft directory or reporting roles");
    expect(delegated).toContain("Microsoft Agent 365 license");
    expect(delegated).toContain("delegated work or school accounts only");
    expect(delegated).toContain("both application and delegated forms");
    expect(delegated).toContain("application form does not authorize these writes");
    expect(delegated).toMatch(/Recommended.*AI Administrator/);
    expect(delegated).toContain("Global Administrator is a broader alternative");
    expect(delegated).toContain("does not publish an explicit minimum user role");
    expect(reference).toContain("**AI Reader**");
    for (const role of ["AI Administrator", "Power Platform Administrator", "Global Administrator"]) {
      expect(reference).toContain(`**${role}**`);
    }
  });

  it("documents the current Copilot report endpoint and activity window", () => {
    const inventory = readRepositoryFile("docs/provider-contracts.md");
    const row = inventory.split("\n").find(line => line.startsWith("| `reports.copilotUsage.read` |"));
    const activityDescription = readRepositoryFile("docs/copilot-license-usage.md").replace(/\s+/g, " ");

    expect(row?.match(/`GET ([^`]+)`/)?.[1]).toBe(new URL(buildCopilotReportUrl()).pathname);
    expect(row).toContain(`Required ${copilotAppActivityReportVersion} CSV headers`);
    expect(activityDescription).toMatch(new RegExp(
      `${copilotAppActivityPeriod}[^\\n]{0,20}${copilotAppActivityReportVersion}`,
    ));
  });

  it("documents the exact prepared-vault contract and excludes the admin password from runtime", () => {
    const setup = readRepositoryFile("docs/azure-production-deployment.md");
    const documentedNames = [...setup.matchAll(/^\| `((?:agent-control-)[^`]+)` \|/gm)].map(match => match[1]);
    const { preparedVaultContract } = JSON.parse(readRepositoryFile("infra/production-target.example.json"));
    const runtimeDescription = readRepositoryFile("docs/security-model.md").split("\n")
      .find(line => line.startsWith("- Azure runtime configuration"));
    const rotationDescription = readRepositoryFile("docs/operations.md");

    expect(documentedNames).toEqual([
      "agent-control-tenants-json",
      "agent-control-session-secret",
      "agent-control-postgres-admin-password",
      "agent-control-postgres-app-password",
    ]);
    const adminPassword = setup.split("\n").find(line => line.startsWith("| `agent-control-postgres-admin-password` |"));
    expect(adminPassword).toMatch(/provision|maintenance|operator/i);
    expect(setup).not.toContain("agent-control-evidence-expiry");
    expect(documentedNames).toEqual(preparedVaultContract.secretNames);
    expect(preparedVaultContract.runtimeConsumers).toEqual(
      documentedNames.filter(name => name !== "agent-control-postgres-admin-password"),
    );
    expect([...(runtimeDescription?.matchAll(/`([A-Z_]+)`/g) ?? [])].map(match => match[1])).toEqual(
      ["TENANTS_JSON", "SESSION_SECRET", "PGPASSWORD"],
    );
    expect(rotationDescription).toMatch(
      /\]\(azure-production-deployment\.md(?:#[^)]+)?\)/,
    );
  });
});