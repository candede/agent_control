import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CopilotPackage, UnifiedAgentRecord } from "../api/client";
import { AgentOverview } from "./AgentOverview";

const resource: NonNullable<UnifiedAgentRecord["powerPlatformResource"]> = {
  tenantId: "tenant", nativeId: "native", environmentId: "environment", type: "microsoft.copilotstudio/agents",
  displayName: "Agent", location: null, createdAt: null, createdBy: null, lastPublishedAt: null,
  sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown", agentKind: "agent",
  lifecycle: "unknown", identityConfidence: "exact_native", identifiers: [], provenance: {}, details: {}, unknownFieldCount: 0,
};
const record: UnifiedAgentRecord = {
  id: "agent:11111111-1111-4111-8111-111111111111", displayName: "Agent", presence: "power_platform",
  environmentId: "environment", packages: [], powerPlatformResource: resource,
  identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
  observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
};
const peopleState = { people: {}, loading: false, error: undefined, unavailable: undefined, canRetry: false, retry: vi.fn() };
const field = (name: string) => screen.getByText(name, { selector: "dt" }).nextElementSibling;
const environment: NonNullable<UnifiedAgentRecord["environment"]> = {
  id: "environment", displayName: "Finance production", region: "europe", environmentType: "Production",
  isManaged: false, groupName: "Finance", groupId: "group", provenance: { isManaged: { sourceSystem: "power_platform", path: "properties.isManaged", maturity: "ga" } },
  observation: { id: "environment-snapshot", snapshotId: "environment-snapshot", current: true,
    observedAt: "2026-09-01T12:00:00Z", expiresAt: "2099-09-02T12:00:00Z" },
};

describe("purposeful saved agent context", () => {
  it.each(["fresh", "stale", "missing", "invalidated"] as const)("omits the package-detail freshness notice for %s summaries and full details", state => {
    const selectedPackage: CopilotPackage = {
      id: "package", displayName: "Agent", isBlocked: false,
      sourceSystem: "graph_packages", authoringTool: null, creatorType: "unknown",
      agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
      publisher: "Example publisher",
      detailFreshness: {
        state,
        observedAt: state === "missing" ? null : "2026-09-01T12:00:00Z",
        expiresAt: state === "missing" ? null : state === "fresh" ? "2099-09-01T13:00:00Z" : "2026-09-01T13:00:00Z",
      },
    };
    const props = { record: { ...record, packages: [selectedPackage] }, selectedPackage, peopleState };
    const { rerender } = render(<AgentOverview {...props} />);
    expect(screen.queryByRole("complementary", { name: "Package detail freshness" })).not.toBeInTheDocument();
    expect(field("Publisher")).toHaveTextContent("Example publisher");
    expect(screen.queryByText("Inventory observed", { selector: "dt" })).not.toBeInTheDocument();

    rerender(<AgentOverview {...props} packageDetail={{ ...selectedPackage, longDescription: "Saved package description." }} />);
    expect(screen.queryByRole("complementary", { name: "Package detail freshness" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Details collected:|Details expire:|Package details refresh hourly/)).not.toBeInTheDocument();
    expect(screen.getByText("Saved package description.")).toBeVisible();
    expect(field("Publisher")).toHaveTextContent("Example publisher");
  });

  it("opens only exact resolved responsibility identities, never unresolved or invalid people", () => {
    const open = vi.fn();
    render(<AgentOverview record={record} onOpenPerson={open} peopleState={{ ...peopleState, people: {
      owner: { id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", status: "resolved", displayName: "Exact owner" },
      createdBy: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "not_found" },
      lastModifiedBy: { id: "bad-id", status: "unverified", invalidId: true },
    } }} />);
    expect(field("Owner")).toHaveTextContent("Exact owner");
    expect(field("Created by")).toBeVisible();
    expect(field("Last modified by")).toBeVisible();
    expect(screen.queryByText(/Ownership, creation and last modification are distinct source relationships/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View responsibility for Exact owner" }));
    expect(open).toHaveBeenCalledWith("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(screen.getAllByText("User navigation unavailable until this exact identity is resolved.")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /View responsibility/ })).toHaveLength(1);
  });
  it("presents complete operation semantics without confusing operation creator with agent responsibility", () => {
    render(<AgentOverview record={{ ...record, powerPlatformResource: { ...resource, details: {
      connectors: [{ connectorId: "shared_test", operations: [{
        operationId: "read", usedAs: "Topic Tool", isEnabled: false, requiresEndUserConsent: false,
        whenCanBeUsed: "ViaDirectReferenceOnly", connectionProvider: "Maker", createdBy: "52bff06b-5db5-42cd-9919-28f95e3c07af",
      }] }], connectorDetailsStatus: "complete", distinctPowerPlatformConnectors: 1, distinctPowerPlatformConnectorsOperations: 1,
    } } }} peopleState={peopleState} />);
    expect(field("Used as")).toHaveTextContent("Topic Tool");
    expect(field("Enabled")).toHaveTextContent("No");
    expect(field("End-user consent required")).toHaveTextContent("No");
    expect(field("Connection provided by")).toHaveTextContent("Maker");
    expect(field("When available")).toHaveTextContent("Via Direct Reference Only");
    expect(screen.getByTitle("ViaDirectReferenceOnly")).toBeVisible();
    expect(field("Operation configured by (ID)")).toHaveTextContent("52bff06b-5db5-42cd-9919-28f95e3c07af");
    expect(field("Owner")).toHaveTextContent("Not reported");
    expect(field("Created by")).toHaveTextContent("Not reported");
    expect(screen.queryByText(/Source-declared configuration, not observed executions/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Operation creators configured individual operations/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Capability details are partial/)).not.toBeInTheDocument();
  });

  it.each([
    { connectors: undefined, connectorDetailsStatus: "not_supplied" as const, expected: "Configured connector details are not available" },
    { connectors: [], connectorDetailsStatus: "complete" as const, expected: "No configured connectors were reported." },
    { connectors: [], connectorDetailsStatus: "partial" as const, expected: "Configured connector details are not available" },
  ])("distinguishes supplied empty, missing and malformed configuration: $connectorDetailsStatus", details => {
    render(<AgentOverview record={{ ...record, powerPlatformResource: { ...resource, details } }} peopleState={peopleState} />);
    expect(field("Reported connector total")).toHaveTextContent("Unknown");
    expect(field("Reported operation total")).toHaveTextContent("Unknown");
    expect(screen.getByText(new RegExp(details.expected))).toBeVisible();
    expect(screen.getByText(/do not establish invoked-flow relationships/)).toBeVisible();
    expect(screen.queryByText(/No flows/)).not.toBeInTheDocument();
  });

  it("keeps exact zero totals independent from absent lists", () => {
    render(<AgentOverview record={{ ...record, powerPlatformResource: { ...resource, details: {
      connectorDetailsStatus: "not_supplied", distinctPowerPlatformConnectors: 0, distinctPowerPlatformConnectorsOperations: 0,
    } } }} peopleState={peopleState} />);
    expect(field("Reported connector total")).toHaveTextContent("0");
    expect(field("Reported operation total")).toHaveTextContent("0");
    expect(screen.getByText("No configured connectors were reported.")).toBeVisible();
    expect(screen.queryByText(/0 saved connector details/)).not.toBeInTheDocument();
  });

  it.each([
    { connectorDetailsStatus: "partial" as const },
    { capabilityDetailsTruncated: true },
  ])("does not present zero retained operations as a confirmed empty provider list: %j", partial => {
    render(<AgentOverview record={{ ...record, powerPlatformResource: { ...resource, details: {
      ...partial, connectors: [{ connectorId: "shared_test", operations: [] }],
    } } }} peopleState={peopleState} />);
    const connectors = screen.getByRole("list", { name: "Configured connector details" });
    expect(within(connectors).getByText("No operation details retained in this partial observation.")).toBeVisible();
    expect(within(connectors).queryByText("No operations reported in the supplied list.")).not.toBeInTheDocument();
  });

  it.each([
    { connectorDetailsStatus: "complete" as const, operations: [], expected: "No operations reported in the supplied list." },
    { connectorDetailsStatus: "partial" as const, operations: undefined, expected: "Operation details not supplied." },
  ])("distinguishes supplied empty operation lists from missing details: $connectorDetailsStatus", ({ connectorDetailsStatus, operations, expected }) => {
    render(<AgentOverview record={{ ...record, powerPlatformResource: { ...resource, details: {
      connectorDetailsStatus, connectors: [{ connectorId: "shared_test", operations }],
    } } }} peopleState={peopleState} />);
    const connectors = screen.getByRole("list", { name: "Configured connector details" });
    expect(within(connectors).getByText(expected)).toBeVisible();
  });

  it("uses the exact environment's own observation and preserves false managed state", () => {
    render(<AgentOverview record={{ ...record, environment }} peopleState={peopleState} />);
    expect(field("Environment name")).toHaveTextContent("Finance production");
    expect(field("Region")).toHaveTextContent("europe");
    expect(field("Managed environment")).toHaveTextContent("No");
    expect(field("Environment type")).toHaveTextContent("Production");
    expect(field("Environment observed")?.querySelector("time")).toHaveAttribute("dateTime", environment.observation.observedAt);
    expect(field("Configuration observed")).toHaveTextContent("Not available");
    expect(screen.getByText("Configuration and environment source evidence").closest("details")).not.toHaveAttribute("open");
    expect(field("Environment snapshot")).toHaveTextContent("environment-snapshot");
  });

  it.each([null, { ...environment, id: "other-environment" }])("does not use unrelated or unavailable environment metadata", context => {
    render(<AgentOverview record={{ ...record, environment: context }} peopleState={peopleState} />);
    expect(screen.getByText(/No current authorized saved environment metadata/)).toBeVisible();
    expect(screen.queryByText("Finance production")).not.toBeInTheDocument();
  });

  it("exposes expiry and unknown managed state rather than manufacturing current or unmanaged evidence", () => {
    render(<AgentOverview record={{ ...record, environment: {
      ...environment, isManaged: null, observation: { ...environment.observation, expiresAt: "2020-01-01T00:00:00Z" },
    } }} peopleState={peopleState} />);
    expect(field("Managed environment")).toHaveTextContent("Not reported");
    expect(screen.getByText(/saved environment observation has expired/)).toBeVisible();
  });

  it("keeps Graph-only descriptions without treating arbitrary names, URLs or flowIds as configured services", () => {
    const pkg = { id: "package", displayName: "Agent", isBlocked: false,
      sourceSystem: "graph_packages" as const, authoringTool: null, creatorType: "unknown" as const,
      agentKind: "copilot_package" as const, lifecycle: "unknown" as const, identityConfidence: "exact_native" as const, provenance: {} };
    render(<AgentOverview record={{ ...record, environmentId: null, powerPlatformResource: null, packages: [pkg], presence: "graph_packages" }}
      selectedPackage={pkg} packageDetail={{ ...pkg, longDescription: "Saved description", elementDetails: [{
        elementType: "AgentMetadatas", elements: [{ id: "", definition: '{"connectorId":"Fictional connector","flowIds":["not-a-relation"],"url":"https://malicious.invalid/?sig=secret"}' }],
      }] }} peopleState={peopleState} />);
    expect(screen.getByText("Saved description")).toBeVisible();
    expect(screen.queryByText("Fictional connector")).not.toBeInTheDocument();
    expect(screen.queryByText(/malicious.invalid/)).not.toBeInTheDocument();
    expect(field("Reported connector total")).toHaveTextContent("Unknown");
    expect(screen.getByText(/did not establish an environment identity/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Microsoft 365 admin center (console landing page)" })).toHaveAttribute("href", "https://admin.microsoft.com/");
    const capabilities = screen.getByRole("region", { name: "Configured connectors and operations" });
    expect(within(capabilities).getByText(/do not establish invoked-flow relationships/)).toBeVisible();
  });

  it("only links allowlisted Microsoft console landings, never source-supplied targets or callback credentials", () => {
    render(<AgentOverview record={{ ...record, environmentId: "https://malicious.invalid", powerPlatformResource: {
      ...resource, nativeId: "https://malicious.invalid?sig=secret",
    } }} peopleState={peopleState} />);
    const links = screen.getAllByRole("link");
    expect(links.map(link => link.getAttribute("href"))).toEqual([
      "https://admin.powerplatform.microsoft.com/", "https://copilotstudio.microsoft.com/",
    ]);
    for (const link of links) {
      expect(link).toHaveTextContent("console landing page");
      expect(link).toHaveAttribute("rel", "noreferrer");
    }
  });
});
