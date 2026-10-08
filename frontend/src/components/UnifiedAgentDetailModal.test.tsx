import { act, fireEvent, render, screen, waitFor, within, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import * as api from "../api/client";
import type { CapabilityView, CopilotPackage, CopilotPackageDetail, PackageAccessTarget, QuarantinePreview, SessionUser, UnifiedAgentRecord } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { mockNativeDialogs } from "../test/dialog";
import { deferred } from "../test/deferred";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { UnifiedAgentDetailModal } from "./UnifiedAgentDetailModal";
import { createInventoryVerification } from "../test/inventoryVerification";
import * as reportApi from "../api/reportData";
import type { CandidateAgentUsageAssociations, CandidateAgentUsageSummary, CandidateAgentUsageUsers } from "../../../backend/src/types/officialReportApi";
import { reportAgent, reportPage, reports, selectionId } from "../test/reportDataFixture";
import { automaticAgentUsageFixture, automaticUsageContext, automaticUsagePackageId, automaticUsageReportName } from "../test/automaticAgentUsageFixture";

mockNativeDialogs();

const reportContext = { selectionId, reportSetId: reports.setId, usageRevision: "b".repeat(64), inventoryRevision: "c".repeat(64), reports };
function reportUsage(association: CandidateAgentUsageAssociations["value"][number] = {
  reportAgentId: automaticUsagePackageId, agentName: automaticUsageReportName, responses: 181,
  basis: "exact_package_id", target: { source: "graph_packages", packageId: automaticUsagePackageId, snapshotId: "exact-snapshot" },
}) {
  vi.mocked(reportApi.readAgentReportSummary).mockImplementation(async recordId => ({
    recordId, status: "linked", responses: 181, activeUsers: 7, lastActivityDateUtc: "2026-09-12",
    associationCount: 1, context: reportContext,
  } satisfies CandidateAgentUsageSummary));
  vi.mocked(reportApi.readAgentReportAssociations).mockResolvedValue({
    value: [association], context: reportContext, counts: { total: 1, filtered: 1 },
    page: { limit: 50, nextCursor: null, previousCursor: null },
  });
}

const record = {
  id: "unified-1",
  displayName: "Unified builder",
  presence: "both",
  environmentId: "environment-1",
  environment: {
    id: "environment-1", displayName: "Production", region: "europe", environmentType: "Production",
    isManaged: false, groupName: null, groupId: null, provenance: {},
    observation: { id: "environment-snapshot", snapshotId: "environment-snapshot", current: true,
      observedAt: "2026-09-18T00:00:00Z", expiresAt: "2026-10-01T00:00:00Z" },
  },
  packages: [{
    id: "package-1", displayName: "Package one", isBlocked: false,
    sourceSystem: "graph_packages", authoringTool: "Agent Builder", creatorType: "unknown",
    agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
  }],
  powerPlatformResource: {
    tenantId: "tenant-1", nativeId: "agent-1", type: "microsoft.copilotstudio/agents",
    location: null, displayName: "Unified builder", environmentId: "environment-1",
    createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform",
    authoringTool: "Agent Builder", creatorType: "unknown", agentKind: "agent_builder_agent",
    lifecycle: "published", identityConfidence: "exact_native",
    identifiers: [{ kind: "entra_agent_id", value: "agent-identity-1" }],
    provenance: {}, details: {}, unknownFieldCount: 0,
  },
  identity: {
    state: "matched",
    evidence: [{
      kind: "entra_agent_id", basis: "source_declared_metadata", elementIds: ["element-1"],
      packagePath: "elementDetails.AgentMetadatas.definition.AgentIdentityId",
      resourcePath: "identifiers.entra_agent_id",
    }],
    packageEvidence: [{
      packageId: "package-1",
      evidence: [{
        kind: "entra_agent_id", basis: "source_declared_metadata", elementIds: ["element-1"],
        packagePath: "elementDetails.AgentMetadatas.definition.AgentIdentityId",
        resourcePath: "identifiers.entra_agent_id",
      }],
    }],
    reason: null,
  },
  observations: { graphPackages: null, packageSnapshots: {}, powerPlatform: null },
} satisfies UnifiedAgentRecord;

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalledWith(expect.stringMatching(/^\/api\/inventory\/resources\/.*\/related(?:\?|$)/), expect.anything());
  } finally {
    vi.restoreAllMocks();
  }
});

const environmentId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";
const user: SessionUser = {
  homeAccountId: "admin-1", displayName: "Admin", username: "admin@example.invalid", roles: ["AgentControl.Admin"],
};

function observedRecord(): UnifiedAgentRecord {
  return {
    ...record, environmentId,
    environment: { ...record.environment, id: environmentId },
    powerPlatformResource: {
      ...record.powerPlatformResource, environmentId,
      identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: botId }],
      quarantineIdentity: { environmentId, botId },
    },
    observations: {
      ...record.observations,
      powerPlatform: {
        id: "snapshot-1", snapshotId: "snapshot-1", current: true,
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        roleScope: "full", environmentScope: null, coverage: "covered", coveredCount: 1,
        observedCount: 1, totalRecords: 1, pageCount: 1, verification: createInventoryVerification(1),
      },
    },
  };
}

function corroboratedRecord(withBotIdentifier: boolean): UnifiedAgentRecord {
  const observed = observedRecord();
  const evidence: UnifiedAgentRecord["identity"]["evidence"] = [{
    kind: "environment_schema_native_id", basis: "source_declared_metadata", elementIds: ["metadata-1"],
    packagePath: "elementDetails.AgentMetadatas.definition.SourceIds.EnvironmentId + SourceIds.SchemaName + SourceIds.CdsBotId",
    resourcePath: "environmentId + details.schemaName + nativeId",
  }];
  return {
    ...observed,
    powerPlatformResource: {
      ...observed.powerPlatformResource!, nativeId: botId, details: { schemaName: "verified-schema" },
      identifiers: observed.powerPlatformResource!.identifiers.filter(item => withBotIdentifier || item.kind !== "cds_bot_id"),
      quarantineIdentity: withBotIdentifier ? { environmentId, botId } : null,
    },
    identity: {
      state: "matched", evidence, packageEvidence: [{ packageId: "package-1", evidence }],
      reason: "Corroborated environment, schema and native resource identity from source metadata.",
    },
  };
}

function sharedCustomEngineRecord(withBotIdentifier = true): UnifiedAgentRecord {
  const observed = corroboratedRecord(withBotIdentifier);
  const packages = [
    { ...record.packages[0], id: "opaque/legacy%target", displayName: "Legacy custom engine" },
    { ...record.packages[0], id: "opaque:anchor/target", displayName: "Native-backed custom engine", isBlocked: true },
  ];
  const shared: UnifiedAgentRecord["identity"]["evidence"][number] = {
    kind: "shared_custom_engine_bot_id", basis: "source_declared_metadata", elementIds: [""],
    packagePath: "Bots.definition.botId + CustomEngineCopilots.definition.id",
    resourcePath: "related package native identity evidence",
    relatedPackageIds: [packages[1].id],
  };
  return {
    ...observed, id: "agent:33333333-3333-4333-8333-333333333333", packages,
    identity: {
      state: "matched", reason: "The shared bot application identity is uniquely anchored by related package native proof.",
      evidence: [shared, ...observed.identity.evidence],
      packageEvidence: [
        { packageId: packages[0].id, evidence: [shared] },
        { packageId: packages[1].id, evidence: observed.identity.evidence },
      ],
    },
  };
}

function capabilities(): CapabilityView[] {
  return capabilityDefinitions.filter(item => [
    "graph.package.block.manage", "graph.package.access.manage", "powerPlatform.quarantine.manage",
  ].includes(item.id)).map(definition => ({
    definition,
    decision: {
      capabilityId: definition.id, status: "available", authorized: true, fresh: true,
      verification: "on_demand", previewQualification: "not_required", remediation: [],
    },
  }));
}

function capabilitiesWithDirectory(): CapabilityView[] {
  return [...capabilities(), {
    definition: capabilityDefinitions.find(definition => definition.id === "graph.directory.read")!,
    decision: {
      capabilityId: "graph.directory.read", status: "available", authorized: true, fresh: true,
      verification: "provider", previewQualification: "not_required", remediation: [],
      checkedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  }];
}

function renderDetail(
  overrides: Partial<ComponentProps<typeof UnifiedAgentDetailModal>> = {},
  views = capabilities(),
  actions = workbenchActions,
  options: Pick<RenderOptions, "reactStrictMode" | "wrapper"> = {},
) {
  const props = {
    record, roles: user.roles, onTabChange: vi.fn(), onClose: vi.fn(), onInspectPackage: vi.fn(),
    onUpdatePackageAccess: vi.fn().mockResolvedValue(undefined), onSetPackageBlocked: vi.fn(), ...overrides,
  };
  const content = (next: Partial<typeof props> = {}, nextViews = views, principal = user) => <CapabilityContext value={{
    views: nextViews, user: { ...principal, roles: next.roles ?? props.roles }, now: Date.now(),
    loading: false, pending: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}><WorkbenchActionProvider value={actions}><UnifiedAgentDetailModal {...props} {...next} /></WorkbenchActionProvider></CapabilityContext>;
  const result = render(content(), options);
  return { ...result, props, update: (next: Partial<typeof props>, nextViews = views, principal = user) => result.rerender(content(next, nextViews, principal)) };
}

describe("unified authoring and person evidence", () => {
  const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const creatorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const savedPerson = {
    objectId: ownerId, displayName: "Saved owner", userPrincipalName: "saved.owner@example.invalid",
    observedAt: "2026-09-17T12:00:00Z",
  };
  const resolved = (id = ownerId, displayName = "Directory person") => ({
    objectId: id, displayName, userPrincipalName: "person@example.invalid",
    observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "resolved" as const,
  });
  function nativeRecord(): UnifiedAgentRecord {
    return {
      ...record, packages: [], presence: "power_platform",
      powerPlatformResource: {
        ...record.powerPlatformResource, authoringTool: null, displayName: null,
        createdBy: ownerId, details: { createdIn: "Copilot Studio Lite", ownerId: ownerId.toUpperCase() },
      },
    };
  }
  const field = (label: string) => within(screen.getByRole("region", { name: "Agent information" }))
    .getByText(label, { selector: "dt" }).nextElementSibling;

  it("fills Built with from legacy Lite metadata and does not infer deletion from a missing name", () => {
    const value = nativeRecord();
    value.displayName = value.powerPlatformResource!.nativeId;
    renderDetail({ record: value, activeTab: "power-platform", roles: ["AgentControl.Viewer"] });
    expect(field("Built with")).toHaveTextContent("Microsoft 365 Copilot Agent Builder");
    expect(screen.queryByText("Authoring tool")).not.toBeInTheDocument();
    expect(screen.queryByText("Authoring tool (raw)")).not.toBeInTheDocument();
    expect(screen.getByText("Agent name not reported; showing its resource ID.")).toBeVisible();
    expect(screen.queryByText(/This does not establish whether the agent was deleted/)).not.toBeInTheDocument();
  });

  it("uses saved names and sign-in addresses without requiring live directory permission or lookup", () => {
    const lookup = vi.spyOn(api, "resolveAgentPeople");
    const value = { ...nativeRecord(), people: { owner: savedPerson, createdBy: savedPerson } };
    renderDetail({ record: value, roles: ["AgentControl.Viewer"] });
    expect(field("Owner")).toHaveTextContent("Saved owner");
    expect(field("Owner")).toHaveTextContent("saved.owner@example.invalid");
    expect(field("Created by")).toHaveTextContent("Saved owner");
    expect(field("Created by")).not.toHaveTextContent(`ID: ${ownerId}`);
    expect(field("Owner")).not.toHaveTextContent("Saved directory:");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps inventory-only person references unverified and available for explicit lookup", () => {
    const lookup = vi.spyOn(api, "resolveAgentPeople");
    renderDetail({ record: { ...nativeRecord(), people: {} }, onOpenPerson: vi.fn() }, capabilitiesWithDirectory());
    expect(field("Owner")).toHaveTextContent("Unverified directory identity.");
    expect(field("Created by")).toHaveTextContent("Unverified directory identity.");
    expect(screen.queryByRole("button", { name: /View responsibility for/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Look up people" })).toBeEnabled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not discard a validated saved GUID match just because live lookup supports a narrower ID format", () => {
    const lookup = vi.spyOn(api, "resolveAgentPeople");
    const id = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
    const value = nativeRecord();
    value.powerPlatformResource!.createdBy = id;
    value.powerPlatformResource!.details.ownerId = id;
    const person = { ...savedPerson, objectId: id };
    value.people = { owner: person, createdBy: person };
    renderDetail({ record: value }, capabilitiesWithDirectory());
    expect(field("Owner")).toHaveTextContent("Saved owner");
    expect(field("Created by")).toHaveTextContent("saved.owner@example.invalid");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("persists missing people once through the saved record, independent of callback identity and package rerenders", async () => {
    const value = nativeRecord();
    value.powerPlatformResource!.details.lastModifiedBy = creatorId;
    const lookup = vi.spyOn(api, "resolveAgentPeople").mockResolvedValue({
      people: { owner: resolved(), createdBy: resolved(), lastModifiedBy: resolved(creatorId, "Last editor") }, changed: true,
    });
    const changed = vi.fn();
    const rendered = renderDetail({ record: value, roles: ["AgentControl.Viewer"], onPeopleChanged: changed }, capabilitiesWithDirectory());
    expect(lookup).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    await waitFor(() => expect(field("Owner")).toHaveTextContent("Directory person"));
    expect(field("Created by")).toHaveTextContent("person@example.invalid");
    expect(field("Last modified by")).toHaveTextContent("Last editor");
    expect(lookup).toHaveBeenCalledExactlyOnceWith(value.id, { force: true, signal: expect.any(AbortSignal) });
    expect(changed).toHaveBeenCalledOnce();
    rendered.update({ record: structuredClone(value), onPeopleChanged: vi.fn() });
    rendered.update({ activeTab: "audit-security" });
    rendered.update({ activeTab: "identities" });
    expect(field("Owner")).toHaveTextContent("Directory person");
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("keeps saved people visible during a failed missing-person lookup and supports retry", async () => {
    const value = nativeRecord();
    value.powerPlatformResource!.createdBy = creatorId;
    value.people = { owner: savedPerson };
    const lookup = vi.spyOn(api, "resolveAgentPeople")
      .mockRejectedValueOnce(new api.ApiError(503, "unavailable", "Directory temporarily unavailable."))
      .mockResolvedValueOnce({ people: { owner: savedPerson, createdBy: resolved(creatorId, "Original creator") }, changed: true });
    renderDetail({ record: value }, capabilitiesWithDirectory());
    expect(lookup).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Directory temporarily unavailable.");
    expect(field("Owner")).toHaveTextContent("Saved owner");
    expect(field("Created by")).toHaveTextContent(creatorId);
    expect(lookup.mock.calls[0][0]).toBe(value.id);
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    await waitFor(() => expect(field("Created by")).toHaveTextContent("Original creator"));
    expect(lookup).toHaveBeenLastCalledWith(value.id, { force: true, signal: expect.any(AbortSignal) });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["not_found", "lookup_failed"] as const)("shows fresh %s evidence honestly and only retries explicitly", async status => {
    const value = nativeRecord();
    const person = { ...resolved(), displayName: null, userPrincipalName: null, status };
    value.people = { owner: person, createdBy: person };
    const lookup = vi.spyOn(api, "resolveAgentPeople").mockResolvedValue({ people: value.people, changed: false });
    const changed = vi.fn();
    const rendered = renderDetail({ record: value, onPeopleChanged: changed }, capabilitiesWithDirectory());
    expect(field("Owner")).toHaveTextContent(status === "not_found" ? "User not found" : "Directory lookup failed");
    expect(field("Owner")).not.toHaveTextContent("deleted");
    expect(lookup).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    await waitFor(() => expect(screen.queryByText("Resolving agent people...")).not.toBeInTheDocument());
    expect(lookup).toHaveBeenCalledExactlyOnceWith(value.id, { force: true, signal: expect.any(AbortSignal) });
    rendered.update({ record: structuredClone(value), onPeopleChanged: vi.fn() });
    rendered.update({}, capabilities());
    expect(screen.getByText(/Directory lookup is unavailable/)).toBeVisible();
    rendered.update({}, capabilitiesWithDirectory());
    expect(lookup).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });

  it("refreshes expired evidence only explicitly and retains last known names after a failed retry", async () => {
    const value = nativeRecord();
    const expired = { ...savedPerson, expiresAt: new Date(Date.now() - 1_000).toISOString() };
    value.people = { owner: expired, createdBy: expired };
    const failure = { ...resolved(), displayName: "Saved owner", status: "lookup_failed" as const, errorCode: "provider_error" };
    const lookup = vi.spyOn(api, "resolveAgentPeople")
      .mockResolvedValueOnce({ people: { owner: failure, createdBy: failure }, changed: true })
      .mockRejectedValueOnce(new Error("Retry temporarily unavailable."));
    const rendered = renderDetail({ record: value }, capabilitiesWithDirectory());
    expect(field("Owner")).toHaveTextContent("Saved owner");
    expect(field("Owner")).toHaveTextContent("Saved lookup expired");
    expect(lookup).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    await waitFor(() => expect(field("Owner")).toHaveTextContent("Directory lookup failed. Last known identity shown."));
    expect(lookup).toHaveBeenCalledExactlyOnceWith(value.id, { force: true, signal: expect.any(AbortSignal) });
    rendered.update({ record: structuredClone(value) });
    expect(lookup).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Retry temporarily unavailable.");
    expect(field("Owner")).toHaveTextContent("Saved owner");
    expect(field("Owner")).toHaveTextContent("Directory lookup failed");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("keeps legacy resolved snapshots without expiry and does not retry fresh saved names", () => {
    const lookup = vi.spyOn(api, "resolveAgentPeople");
    const value = nativeRecord();
    value.people = { owner: savedPerson, createdBy: savedPerson };
    renderDetail({ record: value }, capabilitiesWithDirectory());
    expect(lookup).not.toHaveBeenCalled();
    expect(field("Owner")).toHaveTextContent("Saved owner");
    expect(screen.queryByRole("button", { name: "Look up people" })).not.toBeInTheDocument();
  });

  it.each(["saved", "returned"] as const)("rechecks %s person expiry before navigation when the expiry timer has not run", async source => {
    vi.useFakeTimers();
    const now = Date.now();
    const value = nativeRecord();
    const person = { ...savedPerson, expiresAt: new Date(now + 1_000).toISOString() };
    const people = { owner: person, createdBy: person };
    if (source === "saved") value.people = people;
    const openPerson = vi.fn();
    const lookup = vi.spyOn(api, "resolveAgentPeople").mockResolvedValue({ people, changed: false });
    renderDetail({ record: value, onOpenPerson: openPerson }, capabilitiesWithDirectory());
    if (source === "returned") await act(async () => fireEvent.click(screen.getByRole("button", { name: "Look up people" })));
    const links = screen.getAllByRole("button", { name: "View responsibility for Saved owner" });
    fireEvent.click(links[0]);
    expect(openPerson).toHaveBeenCalledExactlyOnceWith(ownerId);
    openPerson.mockClear();
    vi.setSystemTime(now + 1_000);
    links.forEach(link => fireEvent.click(link));
    expect(openPerson).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(screen.queryByRole("button", { name: "View responsibility for Saved owner" })).not.toBeInTheDocument();
    expect(field("Owner")).toHaveTextContent("Saved lookup expired");
    expect(field("Owner")).toHaveTextContent("Saved owner");
    expect(lookup).toHaveBeenCalledTimes(source === "returned" ? 1 : 0);
  });

  it("keeps the last known name and explicit failure state without lookup-timestamp clutter", () => {
    const value = nativeRecord();
    const person = {
      ...savedPerson, status: "lookup_failed" as const, checkedAt: "2026-09-19T12:00:00Z",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    value.people = { owner: person, createdBy: person };
    const lookup = vi.spyOn(api, "resolveAgentPeople");
    renderDetail({ record: value });
    expect(field("Owner")).toHaveTextContent("Saved owner");
    expect(field("Owner")).not.toHaveTextContent("Saved directory:");
    expect(field("Owner")).not.toHaveTextContent("Last lookup attempt:");
    expect(field("Owner")).toHaveTextContent("Directory lookup failed. Last known identity shown.");
    expect(field("Owner")).not.toHaveTextContent("deleted");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not refresh newly expired persisted evidence until requested and uses the returned expiry", async () => {
    const now = Date.now();
    const value = nativeRecord();
    const original = { ...savedPerson, expiresAt: new Date(now + 1_000).toISOString() };
    value.people = { owner: original };
    const refreshed = { ...resolved(), expiresAt: new Date(now + 10_000).toISOString() };
    const lookup = vi.spyOn(api, "resolveAgentPeople")
      .mockResolvedValueOnce({ people: { owner: refreshed, createdBy: refreshed }, changed: true })
      .mockResolvedValueOnce({ people: { owner: { ...refreshed, expiresAt: new Date(now + 30_000).toISOString() },
        createdBy: { ...refreshed, expiresAt: new Date(now + 30_000).toISOString() } }, changed: true });
    const rendered = renderDetail({ record: value }, capabilitiesWithDirectory());
    expect(lookup).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    await waitFor(() => expect(field("Created by")).toHaveTextContent("Directory person"));
    vi.spyOn(Date, "now").mockReturnValue(now + 2_000);
    rendered.update({}, capabilitiesWithDirectory());
    expect(lookup).toHaveBeenCalledOnce();
    expect(field("Owner")).not.toHaveTextContent("expired");
    vi.mocked(Date.now).mockReturnValue(now + 11_000);
    rendered.update({}, capabilitiesWithDirectory());
    expect(lookup).toHaveBeenCalledOnce();
    expect(field("Owner")).toHaveTextContent("expired");
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    expect(lookup).toHaveBeenLastCalledWith(value.id, { force: true, signal: expect.any(AbortSignal) });
    await waitFor(() => expect(field("Owner")).not.toHaveTextContent("expired"));
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("uses the latest change callback without restarting an in-flight request on rerender", async () => {
    type Response = Awaited<ReturnType<typeof api.resolveAgentPeople>>;
    let finish!: (value: Response) => void;
    const lookup = vi.spyOn(api, "resolveAgentPeople").mockReturnValue(new Promise(done => { finish = done; }));
    const previous = vi.fn();
    const current = vi.fn();
    const rendered = renderDetail({ record: nativeRecord(), onPeopleChanged: previous }, capabilitiesWithDirectory());
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    rendered.update({ onPeopleChanged: current });
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await act(async () => finish({ people: { owner: resolved(), createdBy: resolved() }, changed: true }));
    expect(current).toHaveBeenCalledOnce();
    expect(previous).not.toHaveBeenCalled();
  });

  it("never guesses a name for an invalid identifier or an exact user not found in the directory", async () => {
    const value = nativeRecord();
    value.powerPlatformResource!.details.ownerId = "source-specific-owner";
    vi.spyOn(api, "resolveAgentPeople").mockResolvedValue({
      people: { createdBy: { ...resolved(), displayName: null, userPrincipalName: null, status: "not_found" } }, changed: true,
    });
    renderDetail({ record: value }, capabilitiesWithDirectory());
    expect(field("Owner")).toHaveTextContent("Invalid Entra user ID.");
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    await waitFor(() => expect(field("Created by")).toHaveTextContent("User not found"));
    expect(field("Created by")).toHaveTextContent(ownerId);
  });

  it("retains persisted results when live permission is lost, but hides them when the app role is lost", async () => {
    const lookup = vi.spyOn(api, "resolveAgentPeople").mockResolvedValue({
      people: { owner: resolved(), createdBy: resolved() }, changed: true,
    });
    const rendered = renderDetail({ record: nativeRecord() });
    expect(lookup).not.toHaveBeenCalled();
    expect(screen.getByText(/unverified people are shown by ID/)).toBeVisible();
    expect(field("Owner")).toHaveTextContent("Unverified directory identity.");
    rendered.update({}, capabilitiesWithDirectory());
    expect(lookup).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    await waitFor(() => expect(field("Owner")).toHaveTextContent("Directory person"));
    rendered.update({}, capabilities());
    expect(field("Owner")).toHaveTextContent("Directory person");
    expect(field("Owner")).toHaveTextContent("person@example.invalid");
    expect(lookup).toHaveBeenCalledTimes(1);
    rendered.update({ roles: [] }, capabilitiesWithDirectory());
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(field("Owner")).not.toHaveTextContent("Directory person");
    expect(field("Owner")).toHaveTextContent(ownerId.toUpperCase());
  });

  it("rejects mismatched saved and live identities rather than attaching another user's name", async () => {
    const value = nativeRecord();
    value.people = { owner: { ...savedPerson, objectId: creatorId, displayName: "Wrong saved person" } };
    vi.spyOn(api, "resolveAgentPeople").mockResolvedValue({
      people: { owner: resolved(creatorId, "Wrong live person") }, changed: true,
    });
    renderDetail({ record: value }, capabilitiesWithDirectory());
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("requested agent's person identities");
    expect(screen.queryByText(/Wrong .* person/)).not.toBeInTheDocument();
    expect(field("Created by")).toHaveTextContent(ownerId);
  });

  it("ignores an aborted A-to-B-to-A response even if its transport completes after the new read", async () => {
    type Response = Awaited<ReturnType<typeof api.resolveAgentPeople>>;
    let finish!: (value: Response) => void;
    const lookup = vi.spyOn(api, "resolveAgentPeople")
      .mockReturnValueOnce(new Promise(done => { finish = done; }))
      .mockResolvedValueOnce({ people: { owner: resolved(creatorId, "Person B"), createdBy: resolved(creatorId, "Person B") }, changed: true })
      .mockResolvedValueOnce({ people: { owner: resolved(ownerId, "Current A"), createdBy: resolved(ownerId, "Current A") }, changed: true });
    const original = nativeRecord();
    const rendered = renderDetail({ record: original }, capabilitiesWithDirectory());
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    const second = nativeRecord();
    second.powerPlatformResource!.createdBy = creatorId;
    second.powerPlatformResource!.details.ownerId = creatorId;
    rendered.update({ record: second });
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    await waitFor(() => expect(field("Owner")).toHaveTextContent("Person B"));
    rendered.update({ record: original });
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    await waitFor(() => expect(field("Owner")).toHaveTextContent("Current A"));
    expect(lookup.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => finish({ people: { owner: resolved(ownerId, "Obsolete A") }, changed: true }));
    expect(field("Owner")).toHaveTextContent("Current A");
    expect(screen.queryByText("Obsolete A")).not.toBeInTheDocument();
  });

  it("aborts a pending lookup on permission loss and never announces its late persisted change", async () => {
    type Response = Awaited<ReturnType<typeof api.resolveAgentPeople>>;
    let finish!: (value: Response) => void;
    const lookup = vi.spyOn(api, "resolveAgentPeople").mockReturnValue(new Promise(done => { finish = done; }));
    const changed = vi.fn();
    const rendered = renderDetail({ record: nativeRecord(), onPeopleChanged: changed }, capabilitiesWithDirectory());
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    rendered.update({}, capabilities());
    expect(lookup.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => finish({ people: { owner: resolved(), createdBy: resolved() }, changed: true }));
    expect(field("Owner")).not.toHaveTextContent("Directory person");
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText(/Directory lookup is unavailable/)).toBeVisible();
  });

  it("discards a previous account's late response even when the record, tenant and app roles match", async () => {
    type Response = Awaited<ReturnType<typeof api.resolveAgentPeople>>;
    let finish!: (value: Response) => void;
    const lookup = vi.spyOn(api, "resolveAgentPeople")
      .mockReturnValueOnce(new Promise(done => { finish = done; }))
      .mockResolvedValueOnce({ people: { owner: resolved(ownerId, "Current account person") }, changed: false });
    const changed = vi.fn();
    const rendered = renderDetail({ record: nativeRecord(), onPeopleChanged: changed }, capabilitiesWithDirectory());
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    rendered.update({}, capabilitiesWithDirectory(), { ...user, homeAccountId: "second-account" });
    await userEvent.click(screen.getByRole("button", { name: "Look up people" }));
    await waitFor(() => expect(field("Owner")).toHaveTextContent("Current account person"));
    expect(lookup.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => finish({ people: { owner: resolved(ownerId, "Previous account person") }, changed: true }));
    expect(field("Owner")).toHaveTextContent("Current account person");
    expect(screen.queryByText("Previous account person")).not.toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
  });
});

async function submitInlineAccess(item: CopilotPackage, target: PackageAccessTarget) {
  const versions = screen.queryByRole("combobox", { name: "Published version details" });
  if (versions) await userEvent.selectOptions(versions, item.id);
  await userEvent.click(screen.getByRole("button", { name: target === "availability" ? /^Available to/ : /^Installed for/ }));
  await userEvent.click(screen.getByRole("radio", { name: /No users/ }));
  await userEvent.click(screen.getByRole("button", { name: "Apply" }));
}

function quarantinePreview(observed = observedRecord()): QuarantinePreview {
  const resource = observed.powerPlatformResource!;
  const snapshot = observed.observations.powerPlatform!;
  return {
    confirmationHash: "c".repeat(64),
    statuses: [{
      target: { resourceNativeId: resource.nativeId, displayName: observed.displayName, environmentId, botId },
      direct: { isBotQuarantined: false, providerUpdatedAt: snapshot.observedAt, observedAt: snapshot.observedAt, correlationId: "status-1", source: "provider" },
      inventory: { isQuarantined: null, quarantinedAt: null, observedAt: snapshot.observedAt, snapshotId: snapshot.id },
      disagreesWithInventory: false,
    }],
    summary: {
      risk: true, operation: "quarantine", provider: "Power Platform Copilot Studio", endpoint: "api-version=1 botQuarantine",
      permission: "Delegated CopilotStudio.AdminActions.Invoke", targetCount: 1, targetSelectionHash: "d".repeat(64),
      actor: { id: user.homeAccountId, displayName: user.displayName, username: user.username }, packageControlIndependent: true,
      makerBehavior: "Makers may still see and test this bot while connected channels cannot use it.", providerAtomicity: false,
      targets: [{
        resourceNativeId: resource.nativeId, displayName: observed.displayName, environmentId, botId,
        currentState: false, requestedState: true, currentProviderUpdatedAt: snapshot.observedAt,
        inventoryState: null, inventoryObservedAt: snapshot.observedAt,
      }],
      additionalTargetCount: 0,
    },
  };
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected detail transport request."));
  vi.spyOn(reportApi, "readAgentReportSummary").mockRejectedValue(new Error("Report data is unavailable. Reload usage to try again."));
  vi.spyOn(reportApi, "readAgentReportAssociations");
  vi.spyOn(reportApi, "readAgentReportHistory").mockImplementation(async (recordId, query) => ({
    recordId, context: { ...reportContext, selectionId: query.selectionId }, value: [],
    latestReportSetId: reportContext.reportSetId, latestReported: null,
    counts: { total: 0, filtered: 0 }, page: { limit: 50, nextCursor: null, previousCursor: null },
  }));
  vi.spyOn(reportApi, "readAgentReportCandidates");
  vi.spyOn(reportApi, "mutateAgentReportAssociation").mockResolvedValue(reportContext);
  vi.spyOn(reportApi, "readReportDetail").mockResolvedValue({
    value: reportAgent(1, { agentId: automaticUsagePackageId, agentName: automaticUsageReportName, activeUsers: 7 }),
    reports, selection: reportPage([]).selection, sources: reportPage([]).sources,
  });
  const usageUsers = { ...reportPage(Array.from({ length: 7 }, (_, index) => ({
    username: `agent-user-${index + 1}@example.invalid`, displayName: `Agent user ${index + 1}`, responses: index === 0 ? 175 : 1,
  })), { counts: { total: 7, filtered: 7 } }), context: reportContext };
  vi.spyOn(reportApi, "readReportPage").mockResolvedValue(usageUsers);
  vi.spyOn(api, "previewQuarantine");
  vi.spyOn(api, "submitQuarantine");
});

describe("UnifiedAgentDetailModal", () => {
  it.each(["identities", "reports", "controls", "audit-security"])("keeps %s isolated from tenant totals and unrelated usage reports, including hidden panels", async activeTab => {
    renderDetail({
      activeTab,
      record: { ...record, id: "synthetic-researcher", displayName: "Researcher" },
    });
    const dialog = await screen.findByRole("dialog", { name: "Researcher" });
    expect(reportApi.readReportDetail).not.toHaveBeenCalled();
    expect(reportApi.readReportPage).not.toHaveBeenCalled();
    expect(reportApi.readAgentReportCandidates).not.toHaveBeenCalled();
    expect(within(dialog).queryByLabelText("Tenant report totals")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Tenant adoption snapshot")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Find a reported agent")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Concealed report user")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Search tenant interactions")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Open tenant security")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("View management audit")).not.toBeInTheDocument();
  });

  it("keeps details open through Strict Mode replay with queued native close events", async () => {
    const { props } = renderDetail({}, capabilities(), workbenchActions, { reactStrictMode: true });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(screen.getByRole("dialog", { name: record.displayName })).toHaveAttribute("open");
    expect(props.onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Close unified agent details" }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ["padding", 120, 100, false],
    ["scrollbar", 699, 200, false],
    ["border", 100, 80, false],
    ["left backdrop", 99, 100, true],
    ["right backdrop", 701, 100, true],
    ["top backdrop", 200, 79, true],
    ["bottom backdrop", 200, 581, true],
  ] as const)("distinguishes a %s click from the dialog content", async (_area, clientX, clientY, shouldClose) => {
    const { props } = renderDetail();
    const dialog = screen.getByRole("dialog", { name: record.displayName });
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 80, 600, 500));
    fireEvent.mouseDown(dialog, { clientX, clientY });
    expect(dialog).toHaveProperty("open", !shouldClose);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(props.onClose).toHaveBeenCalledTimes(shouldClose ? 1 : 0);
  });

  it("defaults to Overview with visible admin facts and identifiers, without technical disclosures", () => {
    const { props } = renderDetail({ roles: ["AgentControl.Viewer"] });

    const dialog = screen.getByRole("dialog", { name: "Unified builder" });
    const tablist = within(dialog).getByRole("tablist", { name: "Agent details" });
    expect(within(tablist).getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Overview", "Usage", "Users", "Manage", "Activity"]);
    expect(within(dialog).getByRole("tabpanel", { name: "Overview" })).toBeVisible();
    expect(within(dialog).getByText("Environment name").nextElementSibling).toHaveTextContent("Production");
    expect(within(dialog).getAllByText("Agent Builder").some(element => element.closest("details") === null)).toBe(true);
    expect(within(dialog).getByText("Quarantine status unknown")).toBeVisible();
    expect(within(dialog).queryByText("Linked by source metadata")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/not presented as a publicly documented Microsoft canonical identifier equivalence/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("tabpanel", { name: "Overview" }).querySelectorAll(".agent-overview details")).toHaveLength(0);
    expect(within(dialog).queryByText("Technical details")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Package ID").nextElementSibling).toHaveTextContent("package-1");
    expect(within(dialog).queryByText("element-1")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("elementDetails.AgentMetadatas.definition.AgentIdentityId")).not.toBeInTheDocument();
    expect(within(dialog).getByText("agent-identity-1")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Manage" }));
    expect(props.onTabChange).toHaveBeenLastCalledWith("controls");
    expect(within(dialog).getByText("Package one")).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Manage" })).toBeVisible();
    expect(within(dialog).queryByText(/Apply checks current settings before exact-target confirmation/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/AgentControl.Admin role is required/)).toBeVisible();
  });

  it.each([
    ["identities", "identities", "Overview"], ["package", "identities", "Overview"], ["power-platform", "identities", "Overview"],
    ["reports", "reports", "Usage"], ["users", "users", "Users"], ["audit-security", "audit-security", "Activity"], ["controls", "controls", "Manage"],
  ])("resolves the legacy %s route to the %s panel under the %s label", (activeTab, panel, name) => {
    renderDetail({ activeTab });
    expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name })).toHaveAttribute("id", `unified-agent-tab-${panel}`);
    expect(screen.getByRole("tabpanel", { name })).toHaveAttribute("id", `unified-agent-panel-${panel}`);
  });

  it("opens useful overview information directly for a legacy package detail route", () => {
    const { props } = renderDetail({ activeTab: "package" });
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(props.onInspectPackage).toHaveBeenCalledExactlyOnceWith(record.packages[0]);
    expect(screen.queryByRole("button", { name: /Package details for|Details & services|Viewing details/ })).not.toBeInTheDocument();
  });

  it("automatically combines rich descriptions, service metadata and native configuration on Overview", async () => {
    const observed = observedRecord();
    observed.powerPlatformResource = {
      ...observed.powerPlatformResource!,
      createdBy: "Tenant maker",
      details: { ownerId: "Team owner", model: "Tenant model", authentication: "Organization sign-in", connectors: [{ connectorId: "Configured connector" }] },
    };
    const packageDetail: CopilotPackageDetail = {
      ...record.packages[0],
      version: "3.2.1",
      publisher: "Example vendor",
      longDescription: "<p>A <strong>full vendor description</strong> with useful details.</p>",
      detailFreshness: { state: "stale", observedAt: "2026-09-01T12:00:00Z", expiresAt: "2026-09-01T13:00:00Z" },
      allowedUsersAndGroups: [{ resourceType: "group", resourceId: "group-1" }],
      elementDetails: [{
        elementType: "AgentMetadatas",
        elements: [{ id: "metadata-1", definition: JSON.stringify({ connectorId: "Finance connector" }) }],
      }],
    };
    const { props, update } = renderDetail({ record: observed });
    expect(props.onInspectPackage).toHaveBeenCalledExactlyOnceWith(record.packages[0]);
    update({ packageDetail });

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Responsibility" })).toBeVisible();
    expect(screen.getByText("full vendor description").tagName).toBe("STRONG");
    expect(screen.getByText("full vendor description")).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Package detail freshness" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Details collected:|Details expire:|Package details refresh hourly/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Configured connectors and operations" })).toBeVisible();
    expect(screen.queryByText("Finance connector")).not.toBeInTheDocument();
    for (const value of ["Example vendor", "Team owner", "Tenant maker", "Tenant model", "Organization sign-in", "Configured connector"]) {
      expect(screen.getByText(value)).toBeVisible();
    }
    expect(screen.getByRole("tabpanel", { name: "Overview" }).querySelectorAll(".agent-overview details")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Details & services|Viewing details|Package details for/ })).not.toBeInTheDocument();
    expect(props.onInspectPackage).toHaveBeenCalledOnce();
  });

  it.each(["identities", "reports", "controls", "audit-security"])("does not duplicate the tab navigation with buttons in %s", activeTab => {
    renderDetail({ activeTab });
    expect(screen.queryByRole("button", {
      name: /^(Review usage & users|Review access & controls|Investigate activity|View this agent's activity|Details & services|Viewing details)$/,
    })).not.toBeInTheDocument();
  });

  it("requests saved details once in Strict Mode and does not refetch on ordinary tab changes", async () => {
    const { props, update } = renderDetail({}, undefined, undefined, { reactStrictMode: true });
    expect(props.onInspectPackage).toHaveBeenCalledExactlyOnceWith(record.packages[0]);
    update({ packageDetail: { ...record.packages[0], longDescription: "Saved detailed description." } });
    await userEvent.click(screen.getByRole("tab", { name: "Manage" }));
    await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(screen.getByText("Saved detailed description.")).toBeVisible();
    expect(props.onInspectPackage).toHaveBeenCalledOnce();
  });

  it.each(["pending", "settled"] as const)("does not restart %s native configuration when the package version changes", async phase => {
    const first = record.packages[0];
    const second = { ...first, id: "second-package", displayName: "Second version" };
    const group = { ...record, packages: [first, second], powerPlatformResource: {
      ...record.powerPlatformResource, savedSource: { scopeId: "source", identity: "native" },
      connectorCounts: { connectors: 0, operations: 0 },
    } };
    const pending = deferred<Awaited<ReturnType<typeof api.getInventoryChildren>>>();
    const read = vi.spyOn(api, "getInventoryChildren").mockImplementation(async (_s, _r, _source, kind) => {
      if (phase === "pending") return pending.promise;
      return { value: kind === "detail:channels" ? [{ ordinal: 0, kind, value: "Teams", payload: {} }] : [],
        total: kind === "detail:channels" ? 1 : 0, nextCursor: null };
    });
    const { props } = renderDetail({ record: group, selectionId: "selection", packageDetail: first });
    if (phase === "settled") await screen.findByText("Teams");
    expect(read).toHaveBeenCalledTimes(2);
    const signals = read.mock.calls.map(call => call[5]?.signal);
    fireEvent.change(screen.getByRole("combobox", { name: "Published version details" }), { target: { value: second.id } });
    expect(props.onInspectPackage).toHaveBeenCalledExactlyOnceWith(second);
    expect(read).toHaveBeenCalledTimes(2);
    expect(signals.every(signal => !signal?.aborted)).toBe(true);
    if (phase === "pending") await act(async () => pending.resolve({ value: [], total: 0, nextCursor: null }));
    expect(await screen.findByText("No configured connectors were reported.")).toBeVisible();
  });

  it("reloads stale parent-owned details without replacing or remounting the same Overview", () => {
    const { props, update } = renderDetail();
    expect(props.onInspectPackage).toHaveBeenCalledExactlyOnceWith(record.packages[0]);
    const observation = { observedAt: "2026-09-20T10:00:00Z", expiresAt: "2099-09-20T10:00:00Z", scopeKind: "exact" as const };
    const previous = { ...record.packages[0], longDescription: "Previous saved description", observation };
    update({ packageDetail: previous });
    const information = screen.getByRole("region", { name: "Agent information" });
    update({ packageDetail: previous, packageDetailStale: true, inventoryRevision: "next-saved-revision" });
    update({ packageDetail: previous, packageDetailStale: true, packageDetailLoading: true, inventoryRevision: "next-saved-revision" });
    expect(screen.getByText("Previous saved description")).toBeVisible();
    expect(screen.queryByText("Loading saved agent details...")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agent information" })).toBe(information);
    expect(props.onInspectPackage).toHaveBeenCalledTimes(2);
    expect(props.onInspectPackage).toHaveBeenLastCalledWith(record.packages[0]);
    update({ inventoryRevision: "next-saved-revision", packageDetailStale: false, packageDetailLoading: false, packageDetail: {
      ...record.packages[0], longDescription: "Updated saved description",
      observation: { ...observation, observedAt: "2026-09-20T10:01:00Z" },
    } });
    expect(screen.getByText("Updated saved description")).toBeVisible();
    expect(screen.queryByText("Previous saved description")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agent information" })).toBe(information);
    expect(props.onInspectPackage).toHaveBeenCalledTimes(2);
  });

  it("shows a failed parent-owned read and does not restore old details on retry", async () => {
    const { props, update } = renderDetail({
      packageDetail: { ...record.packages[0], longDescription: "Previously authorized details" },
    });
    update({ packageDetailStale: true, packageDetailLoading: true });
    expect(screen.getByText("Previously authorized details")).toBeVisible();
    update({ packageDetail: undefined, packageDetailLoading: false, packageDetailError: "Saved package access was denied." });
    expect(screen.getByRole("alert")).toHaveTextContent("Saved package access was denied.");
    expect(screen.queryByText("Previously authorized details")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry saved details" }));
    expect(props.onInspectPackage).toHaveBeenCalledTimes(2);
    update({ packageDetail: undefined, packageDetailError: undefined, packageDetailLoading: true });
    expect(screen.queryByText("Previously authorized details")).not.toBeInTheDocument();
    expect(screen.getByText("Loading saved agent details...")).toBeVisible();
  });

  it.each(["tenant", "principal", "roles", "agent"] as const)(
    "does not retain an invalidated Overview across a changed %s",
    scope => {
      const { update } = renderDetail({
        packageDetail: { ...record.packages[0], longDescription: "Previous scope description" },
      });
      update({
        packageDetail: undefined, packageDetailLoading: true,
        record: scope === "agent" ? { ...record, id: "another-agent" } : record,
        roles: scope === "roles" ? ["AgentControl.Viewer"] : user.roles,
      }, capabilities(), {
        ...user,
        tenantId: scope === "tenant" ? "another-tenant" : user.tenantId,
        homeAccountId: scope === "principal" ? "another-principal" : user.homeAccountId,
      });
      expect(screen.queryByText("Previous scope description")).not.toBeInTheDocument();
    },
  );

  it("requests the package again after returning from a resource-only agent", () => {
    const { props, update } = renderDetail();
    expect(props.onInspectPackage).toHaveBeenCalledOnce();
    update({ record: { ...record, id: "native-only", packages: [], presence: "power_platform" } });
    expect(props.onInspectPackage).toHaveBeenCalledOnce();
    update({ record });
    expect(props.onInspectPackage).toHaveBeenCalledTimes(2);
    expect(props.onInspectPackage).toHaveBeenLastCalledWith(record.packages[0]);
  });

  it("switches exact version details without another dialog and never shows the previous version's metadata", async () => {
    const first = record.packages[0];
    const second = { ...first, id: "second-package", displayName: "Second version", version: "2" };
    const group = { ...record, packages: [first, second] };
    const { props, update } = renderDetail({
      record: group,
      packageDetail: { ...first, longDescription: "First version details" },
    });
    expect(props.onInspectPackage).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Published version details" }), second.id);
    expect(props.onInspectPackage).toHaveBeenCalledExactlyOnceWith(second);
    expect(screen.queryByText("First version details")).not.toBeInTheDocument();
    update({ packageDetail: { ...second, longDescription: "Second version details" } });
    expect(screen.getByText("Second version details")).toBeVisible();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await userEvent.click(screen.getByRole("tab", { name: "Manage" }));
    expect(screen.getByRole("combobox", { name: "Published version details" })).toHaveValue(second.id);
    expect(screen.getByRole("region", { name: "Manage Second version (second-package)" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Availability settings" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Manage access for|Manage installation for/ })).not.toBeInTheDocument();
    expect(props.onInspectPackage).toHaveBeenCalledOnce();
  });

  it("disables version changes while the saved inventory is being replaced", async () => {
    const first = record.packages[0];
    const second = { ...first, id: "second-package", displayName: "Second version" };
    const { props, update } = renderDetail({
      record: { ...record, packages: [first, second] }, packageInventoryPending: true,
    });
    const versions = screen.getByRole("combobox", { name: "Published version details" });
    expect(versions).toBeDisabled();
    expect(screen.getByText("Saved details will be loaded when the saved inventory is ready.")).toBeVisible();
    await userEvent.selectOptions(versions, second.id);
    expect(versions).toHaveValue(first.id);
    expect(props.onInspectPackage).not.toHaveBeenCalled();
    update({ packageInventoryPending: false });
    expect(versions).toBeEnabled();
    expect(props.onInspectPackage).toHaveBeenCalledExactlyOnceWith(first);
    await userEvent.selectOptions(versions, second.id);
    expect(props.onInspectPackage).toHaveBeenLastCalledWith(second);
  });

  it.each([undefined, "Previous package read failed."])(
    "waits for explicit inventory recovery before reading saved versions (detail error=%s)",
    async packageDetailError => {
      const first = record.packages[0];
      const second = { ...first, id: "second-package", displayName: "Second version" };
      const onRetryInventory = vi.fn();
      const { props, update } = renderDetail({
        record: { ...record, packages: [first, second] }, selectionId: "previous-selection",
        packageInventoryPending: true, packageDetailError, onRetryInventory,
      });
      update({ packageInventoryPending: false, inventoryError: "Replacement inventory unavailable." });
      expect(props.onInspectPackage).not.toHaveBeenCalled();
      const versions = screen.getByRole("combobox", { name: "Published version details" });
      expect(versions).toBeDisabled();
      await userEvent.selectOptions(versions, second.id);
      expect(versions).toHaveValue(first.id);
      expect(screen.queryByText("Loading saved agent details...")).not.toBeInTheDocument();
      if (packageDetailError) {
        const retryDetails = screen.getByRole("button", { name: "Retry saved details" });
        expect(retryDetails).toBeDisabled();
        await userEvent.click(retryDetails);
      } else expect(screen.getByText("Reload saved inventory before loading saved package details.")).toBeVisible();
      expect(props.onInspectPackage).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Retry saved inventory" }));
      expect(onRetryInventory).toHaveBeenCalledOnce();
      update({ packageInventoryPending: true, inventoryError: "Replacement inventory unavailable." });
      expect(props.onInspectPackage).not.toHaveBeenCalled();
      update({ packageInventoryPending: false, inventoryError: undefined, selectionId: "replacement-selection" });
      expect(props.onInspectPackage).toHaveBeenCalledExactlyOnceWith(first);
      expect(versions).toBeEnabled();
      update({ packageInventoryPending: false, inventoryError: undefined, selectionId: "replacement-selection", packageDetail: first });
      expect(props.onInspectPackage).toHaveBeenCalledOnce();
    },
  );

  it("respects a restored exact version and clears metadata when the agent changes", async () => {
    const first = record.packages[0];
    const second = { ...first, id: "second-package", displayName: "Second version" };
    const { props, update } = renderDetail({
      record: { ...record, packages: [first, second] },
      selectedPackageId: second.id,
      packageDetail: { ...second, longDescription: "Previous agent description" },
    });
    expect(screen.getByRole("combobox", { name: "Published version details" })).toHaveValue(second.id);
    expect(props.onInspectPackage).not.toHaveBeenCalled();
    const nextPackage = { ...first, id: "next-package", shortDescription: "Current agent description" };
    update({ record: { ...record, id: "different-agent", packages: [nextPackage] } });
    expect(screen.queryByText("Previous agent description")).not.toBeInTheDocument();
    expect(screen.getByText("Current agent description")).toBeVisible();
    expect(props.onInspectPackage).toHaveBeenCalledExactlyOnceWith(nextPackage);
  });

  it("shows the single published version's package ID inline without a disclosure", () => {
    const agent = record.packages[0];
    renderDetail({ record: { ...record, displayName: agent.displayName }, activeTab: "controls" });
    const management = screen.getByRole("region", { name: `Manage ${agent.displayName} (${agent.id})` });
    const packageId = within(management).getByText(agent.id, { selector: "code" });
    expect(packageId).toBeVisible();
    expect(packageId.parentElement).toHaveTextContent(`Package ID: ${agent.id}`);
    expect(packageId.closest("details")).toBeNull();
    expect(within(management).queryByText("Version details")).not.toBeInTheDocument();
  });

  it("blocks package mutations without pausing saved detail reads when job status is unrecognized", async () => {
    const item = record.packages[0];
    const reason = "The server returned an unrecognized job status. Refresh status before starting another change.";
    const { props, update } = renderDetail({ activeTab: "controls", packageActionsBlockedReason: reason });
    expect(props.onInspectPackage).toHaveBeenCalledExactlyOnceWith(item);
    expect(screen.queryByText("Saved details will be loaded when the current management action finishes.")).not.toBeInTheDocument();
    update({ packageDetail: { ...item, availableTo: "none" } });
    const panel = within(screen.getByRole("tabpanel"));
    const block = panel.getByRole("button", { name: `Block ${item.displayName} (${item.id})` });
    expect(panel.getByRole("alert")).toHaveTextContent(reason);
    expect(block).toBeDisabled();
    const apply = panel.getByRole("button", { name: "Apply" });
    expect(apply).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(block);
    await userEvent.click(apply);
    expect(props.onSetPackageBlocked).not.toHaveBeenCalled();
    expect(props.onUpdatePackageAccess).not.toHaveBeenCalled();
    expect(panel.queryByRole("button", { name: "Please wait" })).not.toBeInTheDocument();
    update({ packageActionsBlockedReason: undefined, packageDetail: { ...item, availableTo: "none" } });
    expect(panel.queryByRole("alert")).not.toBeInTheDocument();
    expect(block).toBeEnabled();
    expect(apply).toBeEnabled();
    expect(apply).toHaveAttribute("aria-disabled", "false");
    expect(props.onInspectPackage).toHaveBeenCalledTimes(1);
  });

  it("keeps same-name versions distinct and shows the selected package ID inline", async () => {
    const first = { ...record.packages[0], displayName: "Same agent", version: "1" };
    const second = { ...first, id: "second-package" };
    const { props } = renderDetail({
      record: { ...record, powerPlatformResource: null, presence: "graph_packages", packages: [first, second] },
      activeTab: "controls",
    });
    const versions = screen.getByRole("combobox", { name: "Published version details" });
    expect(within(versions).getAllByRole("option").map(option => option.textContent?.trim())).toEqual([
      "Same agent - Version 1 (1)", "Same agent - Version 1 (2)",
    ]);
    const firstManagement = screen.getByRole("region", { name: `Manage Same agent (${first.id})` });
    expect(within(firstManagement).getByText(first.id, { selector: "code" })).toBeVisible();
    await userEvent.selectOptions(versions, second.id);
    const management = screen.getByRole("region", { name: "Manage Same agent (second-package)" });
    const packageId = within(management).getByText(second.id, { selector: "code" });
    expect(packageId).toBeVisible();
    expect(packageId.parentElement).toHaveTextContent(`Package ID: ${second.id}`);
    expect(packageId.closest("details")).toBeNull();
    expect(within(management).queryByText(first.id, { selector: "code" })).not.toBeInTheDocument();
    await userEvent.click(within(management).getByRole("button", { name: "Block Same agent (second-package)" }));
    expect(props.onSetPackageBlocked).toHaveBeenCalledExactlyOnceWith(second, true);
  });

  it("does not silently replace a withdrawn selected version with another management target", async () => {
    const first = record.packages[0];
    const second = { ...first, id: "second-package", displayName: "Second version", version: "2" };
    const { props, update } = renderDetail({
      record: { ...record, packages: [first, second] }, activeTab: "controls",
      selectedPackageId: second.id, packageDetail: { ...second, longDescription: "Withdrawn version description" },
    });
    update({ record: { ...record, packages: [first] } });
    expect(screen.getByRole("alert")).toHaveTextContent("The selected published version second-package is no longer");
    expect(screen.getByRole("combobox", { name: "Published version details" })).toHaveValue("");
    expect(screen.queryByRole("region", { name: /^Manage / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^(Apply|Block |Unblock )/ })).not.toBeInTheDocument();
    expect(props.onInspectPackage).not.toHaveBeenCalled();
    expect(props.onUpdatePackageAccess).not.toHaveBeenCalled();
    expect(props.onSetPackageBlocked).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Published version details" }), first.id);
    expect(props.onInspectPackage).toHaveBeenCalledExactlyOnceWith(first);
    expect(screen.getByRole("region", { name: "Manage Package one (package-1)" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps an access draft and focused action stable during a background detail replacement", async () => {
    const detail = { ...record.packages[0], availableTo: "some" as const, allowedUsersAndGroups: [] };
    const { props, update } = renderDetail({ activeTab: "controls", packageDetail: detail });
    await userEvent.click(screen.getByRole("radio", { name: /No users/ }));
    const apply = screen.getByRole("button", { name: "Apply" });
    apply.focus();
    update({ activeTab: "controls", packageDetail: detail, packageInventoryPending: true });
    expect(apply).toHaveFocus();
    expect(apply).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeDisabled();
    expect(props.onInspectPackage).not.toHaveBeenCalled();
    update({ activeTab: "controls", packageDetail: detail, packageDetailStale: true, packageDetailLoading: true, inventoryRevision: "new-inventory" });
    expect(screen.getByRole("radio", { name: /No users/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Apply" })).toBe(apply);
    expect(apply).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeDisabled();
    fireEvent.click(apply);
    expect(props.onUpdatePackageAccess).not.toHaveBeenCalled();
    expect(apply).toHaveFocus();
    expect(props.onUpdatePackageAccess).not.toHaveBeenCalled();
    update({ activeTab: "controls", packageDetail: { ...detail, isBlocked: true }, inventoryRevision: "new-inventory" });
    expect(screen.getByRole("radio", { name: /No users/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Apply" })).toBe(apply);
    expect(apply).toBeEnabled();
    expect(apply).toHaveFocus();
    expect(screen.getByRole("button", { name: "Discard changes" })).toBeEnabled();
    expect(props.onUpdatePackageAccess).not.toHaveBeenCalled();
  });

  it("keeps the latest read-only access values rather than reverting to the first loaded detail", () => {
    const first = { ...record.packages[0], availableTo: "some" as const, allowedUsersAndGroups: [] };
    const latest = { ...first, availableTo: "none" as const };
    const { update } = renderDetail({ activeTab: "controls", roles: ["AgentControl.Viewer"], packageDetail: first });
    update({ activeTab: "controls", roles: ["AgentControl.Viewer"], packageDetail: latest });
    const none = screen.getByRole("radio", { name: /No users/ });
    expect(none).toBeChecked();
    update({ activeTab: "controls", roles: ["AgentControl.Viewer"], packageDetail: latest, packageDetailStale: true, packageDetailLoading: true });
    expect(screen.getByRole("radio", { name: /No users/ })).toBe(none);
    expect(none).toBeChecked();
  });

  it("pauses a draft during a detail retry without labelling unsaved assignments as saved", async () => {
    const principals: api.DirectoryPrincipal[] = ["saved-a", "saved-b"].map(resourceId => ({
      resourceId, resourceType: "group", displayName: resourceId, principalKind: "securityGroup",
    }));
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: principals });
    const detail = { ...record.packages[0], availableTo: "some", allowedUsersAndGroups: principals };
    const { props, update } = renderDetail({ activeTab: "controls", packageDetail: detail }, capabilitiesWithDirectory());
    fireEvent.click(await screen.findByRole("button", { name: "Remove saved-a" }));
    const apply = screen.getByRole("button", { name: "Apply" });
    apply.focus();

    update({ packageDetail: undefined, packageDetailLoading: true });
    expect(screen.queryByRole("group", { name: "Saved users and groups" })).not.toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply" })).toBe(apply);
    expect(apply).toHaveFocus();
    expect(apply).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(apply);
    expect(props.onUpdatePackageAccess).not.toHaveBeenCalled();

    update({ packageDetail: { ...detail } });
    expect(screen.getByText("1 selected")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Remove saved-a" })).not.toBeInTheDocument();
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("retains the displayed saved block state throughout a background detail refresh", () => {
    const detail = { ...record.packages[0], isBlocked: true };
    const { props, update } = renderDetail({ activeTab: "controls", packageDetail: detail });
    const unblock = screen.getByRole("button", { name: "Unblock Package one (package-1)" });
    update({ packageDetail: detail, packageDetailLoading: true, packageDetailStale: true });
    expect(screen.getByRole("button", { name: "Unblock Package one (package-1)" })).toBe(unblock);
    expect(unblock).toBeDisabled();
    expect(screen.getByRole("group", { name: "Blocking for package-1" })).toHaveTextContent("Blocked");
    expect(props.onSetPackageBlocked).not.toHaveBeenCalled();
    update({ packageDetail: { ...detail, isBlocked: false } });
    expect(screen.getByRole("button", { name: "Block Package one (package-1)" })).toBeEnabled();
  });

  it.each(["AgentControl.Viewer", "AgentControl.Admin"] as const)(
    "withdraws invalidated assignments after a failed saved-detail read for %s",
    async role => {
      const previous: api.DirectoryPrincipal = {
        resourceType: "user", resourceId: "previous-assignment", displayName: "previous-assignment", principalKind: "user",
      };
      const current = { ...previous, resourceId: "current-assignment", displayName: "current-assignment" };
      const resolve = vi.spyOn(api, "resolveDirectoryPrincipals")
        .mockResolvedValueOnce({ value: [previous] }).mockResolvedValue({ value: [current] });
      const item = { ...record.packages[0], availableTo: "some" };
      const { props, update } = renderDetail({
        roles: [role], activeTab: "controls", record: { ...record, packages: [item] },
        packageDetail: { ...item, allowedUsersAndGroups: [previous] },
      }, capabilitiesWithDirectory());
      expect(await screen.findByText("previous-assignment", { selector: "strong" })).toBeVisible();
      update({ packageDetailLoading: true });
      update({ packageDetail: undefined, packageDetailError: "Saved assignment details were denied." });
      expect(screen.queryAllByText("previous-assignment", { exact: true })).toHaveLength(0);
      expect(props.onInspectPackage).not.toHaveBeenCalled();
      expect(props.onUpdatePackageAccess).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Retry saved details" }));
      update({ packageDetail: undefined, packageDetailLoading: true });
      expect(screen.queryAllByText("previous-assignment", { exact: true })).toHaveLength(0);
      update({ packageDetail: { ...item, allowedUsersAndGroups: [current] } });
      expect(await screen.findByText("current-assignment", { selector: "strong" })).toBeVisible();
      expect(props.onInspectPackage).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledTimes(role === "AgentControl.Admin" ? 2 : 0);
    },
  );

  it("invalidates the draft when saved access assignments become unreadable", async () => {
    const principal: api.DirectoryPrincipal = {
      resourceType: "user", resourceId: "previous-user", displayName: "Previous assignment", principalKind: "user",
    };
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: [principal] });
    const detail = {
      ...record.packages[0], availableTo: "some", deployedTo: "none",
      allowedUsersAndGroups: [principal], acquireUsersAndGroups: [],
    };
    const { update } = renderDetail({ activeTab: "controls", packageDetail: detail }, capabilitiesWithDirectory());
    expect(await screen.findByText("Previous assignment")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove Previous assignment" }));
    expect(screen.getByText("0 selected")).toBeVisible();

    update({ packageDetail: {
      ...detail, allowedUsersAndGroups: undefined,
      accessReadError: "The saved access assignment exceeds the supported control limit.",
    } });
    expect(screen.getByRole("group", { name: "Saved users and groups" })).toHaveTextContent("Assignments not reported");
    expect(screen.queryByText("No explicit user or group assignments")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("loads the complete saved baseline after an access-read error recovers", async () => {
    const principal: api.DirectoryPrincipal = {
      resourceType: "user", resourceId: "current-user", displayName: "Current assignment", principalKind: "user",
    };
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: [principal] });
    const detail = { ...record.packages[0], availableTo: "some", deployedTo: "none", acquireUsersAndGroups: [] };
    const { props, update } = renderDetail({
      activeTab: "controls", packageDetail: {
        ...detail, accessReadError: "The saved access assignment exceeds the supported control limit.",
      },
    }, capabilitiesWithDirectory());
    expect(screen.getByRole("group", { name: "Saved users and groups" })).toHaveTextContent("Assignments not reported");
    expect(resolve).not.toHaveBeenCalled();

    update({ packageDetail: { ...detail, allowedUsersAndGroups: [principal] } });
    expect(await screen.findByText("Current assignment")).toBeVisible();
    expect(resolve).toHaveBeenCalledExactlyOnceWith([principal], { signal: expect.any(AbortSignal) });
    expect(screen.getByText("1 selected")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(props.onUpdatePackageAccess).toHaveBeenCalledExactlyOnceWith(record.packages[0], {
      target: "availability", mode: "replace", scope: "specific",
      principals: [{ resourceType: principal.resourceType, resourceId: principal.resourceId }],
    }));
  });

  it("cancels obsolete assignment resolution and retains the unreadable baseline during a reread", async () => {
    const previous: api.DirectoryPrincipal = {
      resourceType: "user", resourceId: "previous-user", displayName: "Previous assignment", principalKind: "user",
    };
    const current = { ...previous, resourceId: "current-user", displayName: "Current assignment" };
    let complete!: (response: { value: api.DirectoryPrincipal[] }) => void;
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals")
      .mockReturnValueOnce(new Promise(done => { complete = done; }))
      .mockResolvedValue({ value: [current] });
    const detail = { ...record.packages[0], availableTo: "some", allowedUsersAndGroups: [previous] };
    const { update } = renderDetail({ activeTab: "controls", packageDetail: detail }, capabilitiesWithDirectory());
    await waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    const unreadable = {
      ...detail, allowedUsersAndGroups: undefined,
      accessReadError: "The saved access assignment exceeds the supported control limit.",
    };
    update({ packageDetail: unreadable });
    expect(resolve.mock.calls[0][1]?.signal?.aborted).toBe(true);
    update({ packageDetail: unreadable, packageDetailLoading: true, packageDetailStale: true });
    expect(screen.getByText(/Access assignment editing is unavailable/)).toBeVisible();
    expect(screen.getByRole("group", { name: "Saved users and groups" })).toHaveTextContent("Assignments not reported");
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();

    await act(async () => complete({ value: [previous] }));
    expect(screen.queryByText("Previous assignment")).not.toBeInTheDocument();
    update({ packageDetail: { ...detail, allowedUsersAndGroups: [current] } });
    expect(await screen.findByText("Current assignment")).toBeVisible();
    expect(screen.queryByText("Previous assignment")).not.toBeInTheDocument();
    expect(screen.queryByText("Resolving current assignments...")).not.toBeInTheDocument();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenLastCalledWith([current], { signal: expect.any(AbortSignal) });
  });

  it("discards only the active draft to the latest saved access values after a background read", async () => {
    const detail = {
      ...record.packages[0], availableTo: "all", deployedTo: "none",
      allowedUsersAndGroups: [], acquireUsersAndGroups: [],
    };
    const { update } = renderDetail({ activeTab: "controls", packageDetail: detail });
    fireEvent.click(screen.getByRole("radio", { name: /Specific users or groups/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Specific users or groups/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Available to/ }));
    update({ packageDetail: { ...detail, availableTo: "none", deployedTo: "all" } });
    expect(screen.getByRole("radio", { name: /Specific users or groups/ })).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("radio", { name: /No users/ })).toBeChecked();
    expect(within(screen.getByRole("region", { name: "Availability settings" })).getByText("Saved: No users")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    expect(screen.getByRole("radio", { name: /Specific users or groups/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("radio", { name: /All users/ })).toBeChecked();
  });

  it("resolves the latest saved principals on discard and ignores the superseded lookup", async () => {
    const previous: api.DirectoryPrincipal = {
      resourceType: "user", resourceId: "previous-user", displayName: "Previous assignment", principalKind: "user",
    };
    const latest = { ...previous, resourceId: "latest-user", displayName: "Latest assignment" };
    let complete!: (response: { value: api.DirectoryPrincipal[] }) => void;
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals")
      .mockReturnValueOnce(new Promise(done => { complete = done; }))
      .mockResolvedValue({ value: [latest] });
    const detail = { ...record.packages[0], availableTo: "some", allowedUsersAndGroups: [previous] };
    const { update } = renderDetail({ activeTab: "controls", packageDetail: detail }, capabilitiesWithDirectory());
    await waitFor(() => expect(resolve).toHaveBeenCalledOnce());

    update({ packageDetail: { ...detail, allowedUsersAndGroups: [latest] } });
    expect(resolve).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByText("Latest assignment")).toBeVisible();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenLastCalledWith([latest], { signal: expect.any(AbortSignal) });
    expect(resolve.mock.calls[0][1]?.signal?.aborted).toBe(true);

    await act(async () => complete({ value: [previous] }));
    expect(screen.queryByText("Previous assignment")).not.toBeInTheDocument();
    expect(screen.getByText("Latest assignment")).toBeVisible();
    expect(screen.queryByText("Resolving current assignments...")).not.toBeInTheDocument();
  });

  it("rejects an unavailable restored version rather than reading or managing the first package", () => {
    const { props } = renderDetail({ selectedPackageId: "unavailable-package", activeTab: "controls" });
    expect(screen.getByRole("alert")).toHaveTextContent("unavailable-package");
    expect(screen.queryByRole("region", { name: /^Manage / })).not.toBeInTheDocument();
    expect(props.onInspectPackage).not.toHaveBeenCalled();
  });

  it("keeps a new unavailable restored version closed when the logical agent also changes", () => {
    const first = record.packages[0];
    const { props, update } = renderDetail({
      selectedPackageId: first.id, packageDetail: first, activeTab: "controls",
    });
    const nextPackage = { ...first, id: "next-package" };
    update({
      record: { ...record, id: "different-agent", packages: [nextPackage] },
      selectedPackageId: "unavailable-restored-package", packageDetail: undefined,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("unavailable-restored-package");
    expect(screen.queryByRole("region", { name: /^Manage / })).not.toBeInTheDocument();
    expect(props.onInspectPackage).not.toHaveBeenCalled();
    expect(props.onUpdatePackageAccess).not.toHaveBeenCalled();
    expect(props.onSetPackageBlocked).not.toHaveBeenCalled();
  });

  it("selects a newly observed package for a previously resource-only agent", () => {
    const { props, update } = renderDetail({ record: { ...record, packages: [] } });
    expect(props.onInspectPackage).not.toHaveBeenCalled();
    update({ record });
    expect(props.onInspectPackage).toHaveBeenCalledExactlyOnceWith(record.packages[0]);
  });

  it("defers automatic reads during management and resumes after saved details are invalidated", () => {
    const { props, update } = renderDetail({ packageActionsBusy: true });
    expect(props.onInspectPackage).not.toHaveBeenCalled();
    update({ packageActionsBusy: false });
    expect(props.onInspectPackage).toHaveBeenCalledOnce();
    update({ packageActionsBusy: true, packageDetail: { ...record.packages[0] } });
    expect(props.onInspectPackage).toHaveBeenCalledOnce();
    update({ packageActionsBusy: false, packageDetail: undefined });
    expect(props.onInspectPackage).toHaveBeenCalledTimes(2);
  });

  it("surfaces detail errors without automatic retry loops and supports an explicit saved-only retry", async () => {
    const { props, update } = renderDetail();
    update({ packageDetailError: "Saved detail unavailable" });
    expect(screen.getByRole("alert")).toHaveTextContent("Saved detail unavailable");
    update({ record: { ...record }, packageDetailError: "Saved detail unavailable" });
    expect(props.onInspectPackage).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Retry saved details" }));
    expect(props.onInspectPackage).toHaveBeenCalledTimes(2);
    update({ packageDetailError: undefined, packageDetail: { ...record.packages[0], longDescription: "Recovered saved detail" } });
    expect(screen.getByText("Recovered saved detail")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(props.onInspectPackage).toHaveBeenCalledTimes(2);
  });

  it("does not retry failed saved details when an unrelated package action finishes", async () => {
    const { props, update } = renderDetail({ activeTab: "controls" });
    expect(props.onInspectPackage).toHaveBeenCalledOnce();
    const packageDetailError = "Saved detail unavailable";
    update({ packageDetailError, packageActionsBusy: true });
    update({ packageDetailError, packageActionsBusy: false });
    expect(screen.getByRole("alert")).toHaveTextContent(packageDetailError);
    expect(props.onInspectPackage).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Retry saved details" }));
    expect(props.onInspectPackage).toHaveBeenCalledTimes(2);
  });

  it.each(["missing action", "duplicate action", "missing role"] as const)("does not automatically inspect packages with %s", scenario => {
    const inspectAction = workbenchActions.find(action => action.id === "packages.inspect")!;
    const { props } = renderDetail({ roles: scenario === "missing role" ? [] : user.roles }, undefined,
      scenario === "missing action" ? [] : scenario === "duplicate action" ? [...workbenchActions, inspectAction] : undefined);
    expect(props.onInspectPackage).not.toHaveBeenCalled();
    expect(screen.getByText("Additional details require package read access.")).toBeVisible();
  });

  it("pages saved configured connectors without reducing reported totals", async () => {
    renderDetail({ record: {
      ...record, powerPlatformResource: {
        ...record.powerPlatformResource, details: {
          connectors: Array.from({ length: 35 }, (_, index) => ({ connectorId: `Service ${index}`, operations: [] })),
          connectorDetailsStatus: "partial", distinctPowerPlatformConnectors: 40,
        },
      },
    } });
    expect(screen.getByText("Connectors", { selector: "dt" }).nextElementSibling).toHaveTextContent("40");
    const list = screen.getByRole("list", { name: "Configured connector details" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    for (let index = 0; index < 3; index++) await userEvent.click(screen.getByRole("button", { name: "Next connectors" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(within(list).getByText("Service 34")).toBeVisible();
    expect(screen.getByText("31-35 of 35 saved connectors")).toBeVisible();
    expect(screen.getByText("Connectors", { selector: "dt" }).nextElementSibling).toHaveTextContent("40");
  });

  it("preserves useful native metadata for a sparse agent without inventing a vendor description or connections", () => {
    renderDetail({ record: {
      ...record, packages: [], presence: "power_platform",
      powerPlatformResource: { ...record.powerPlatformResource, details: { ownerId: "Tenant owner", isWebSearchEnabledForKnowledge: false } },
    } });
    expect(screen.queryByText("No description provided.")).not.toBeInTheDocument();
    const information = screen.getByRole("region", { name: "Agent information" });
    expect(within(information).getByText("Tenant owner")).toBeVisible();
    expect(within(information).getByText("Web search for knowledge").nextElementSibling).toHaveTextContent("No");
    expect(screen.queryByText("0 references")).not.toBeInTheDocument();
    expect(screen.queryByText("Publisher", { exact: true })).not.toBeInTheDocument();
  });

  it.each([
    { availableTo: "all", isBlocked: false, expected: "All users" },
    { availableTo: "some", isBlocked: false, expected: "Specific users or groups" },
    { availableTo: "all", isBlocked: true, expected: "Not available" },
    { availableTo: "none", isBlocked: false, expected: "Not available" },
    { availableTo: "unknown", isBlocked: false, expected: "Unknown" },
  ])("keeps detail end-user access consistent with the repository list ($availableTo, blocked=$isBlocked)", ({ availableTo, isBlocked, expected }) => {
    const item = { ...record.packages[0], availableTo, isBlocked };
    renderDetail({ record: { ...record, packages: [item] }, packageDetail: item });
    expect(screen.getByText("End-user access", { selector: ".agent-overview-facts span" }).parentElement).toHaveTextContent(expected);
  });

  it.each([
    { deployedTo: undefined, expected: "Partially known" },
    { deployedTo: "unknownFutureValue", expected: "Partially known" },
    { deployedTo: "none", expected: "No users" },
    { deployedTo: "all", expected: "Varies by package" },
  ])("keeps the installation overview consistent with aggregate scope evidence ($deployedTo)", ({ deployedTo, expected }) => {
    const first = { ...record.packages[0], deployedTo: "none" };
    const second = { ...first, id: "second-package", deployedTo };
    renderDetail({ record: { ...record, packages: [first, second] } });
    expect(screen.getByText("Installed for", { selector: ".agent-overview-facts span" }).parentElement).toHaveTextContent(expected);
  });

  it("keeps reported connector totals separate from retained details and discards arbitrary references", () => {
    renderDetail({
      record: {
        ...record, powerPlatformResource: {
          ...record.powerPlatformResource, details: {
            distinctPowerPlatformConnectors: 5, distinctPowerPlatformConnectorsOperations: 9,
            connectors: [{ connectorId: "retained-connector" }], connectorDetailsStatus: "partial", capabilityDetailsTruncated: true,
            channels: ["Teams", "CustomChannel"], quarantinedAt: "2026-09-18T12:00:00Z",
          },
        },
      },
      packageDetail: {
        ...record.packages[0], elementDetails: [{
          elementType: "AgentMetadatas",
          elements: [{ id: "metadata", definition: '{"connectorId":"Reference one","serviceName":"Reference two"}' }],
        }],
      },
    });
    expect(screen.getByText("Connectors", { selector: "dt" }).nextElementSibling).toHaveTextContent("5");
    expect(screen.queryByText("Reference one")).not.toBeInTheDocument();
    expect(screen.queryByText("Reference two")).not.toBeInTheDocument();
    expect(screen.getByText("retained-connector")).toBeVisible();
    const information = screen.getByRole("region", { name: "Agent information" });
    expect(screen.getByText("Operations", { selector: "dt" }).nextElementSibling).toHaveTextContent("9");
    expect(within(information).getByText("Channels").nextElementSibling).toHaveTextContent("Teams, Custom Channel");
    expect(within(information).getByText("Last quarantined").nextElementSibling?.querySelector("time")).toHaveAttribute("dateTime", "2026-09-18T12:00:00Z");
    expect(screen.getByText("Some connector or operation details are unavailable.")).not.toHaveTextContent("reached its projection limit");
  });

  it.each([0, 5])("retains a reported connector count of %s when connector details are missing", count => {
    renderDetail({ record: {
      ...record, packages: [], powerPlatformResource: {
        ...record.powerPlatformResource, details: {
          distinctPowerPlatformConnectors: count, distinctPowerPlatformConnectorsOperations: 0,
          connectorDetailsStatus: "not_supplied", channels: [],
        },
      },
    } });
    expect(screen.getByText("Connectors", { selector: "dt" }).nextElementSibling).toHaveTextContent(String(count));
    expect(screen.getByText("Operations", { selector: "dt" }).nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Channels").nextElementSibling).toHaveTextContent("None reported");
    expect(screen.queryByText("No connected-service metadata was reported for this agent.")).not.toBeInTheDocument();
    expect(screen.getByText(count ? "Configured connector details are unavailable. Refresh inventory in Sync." : "No configured connectors were reported.")).toBeVisible();
  });

  it("does not present a partial retained connector list as the complete configured count", () => {
    renderDetail({ record: {
      ...record, packages: [], powerPlatformResource: {
        ...record.powerPlatformResource, details: { connectors: [{ connectorId: "retained" }], connectorDetailsStatus: "partial" },
      },
    } });
    expect(screen.getByText("retained")).toBeVisible();
    expect(screen.getByText("Some connector or operation details are unavailable.")).toBeVisible();
    expect(screen.queryByText("Connectors", { selector: "dt" })).not.toBeInTheDocument();
    expect(screen.queryByText("1 configured")).not.toBeInTheDocument();
  });

  it("does not present snapshot collection times as agent lifecycle dates", () => {
    const observedAt = "2026-09-19T12:00:00Z";
    renderDetail({ record: {
      ...record, observations: {
        ...record.observations, packageSnapshots: {
          "package-1": {
            id: "exact-snapshot", snapshotId: "exact-snapshot", current: true, scopeKind: "exact",
            observedAt, expiresAt: "2026-09-26T12:00:00Z", identityDetails: null,
          },
        },
      },
    } });
    expect(screen.queryByText("Inventory observed")).not.toBeInTheDocument();
    expect(screen.queryByText("Created", { selector: "dt" })).not.toBeInTheDocument();
    expect(screen.queryByText("Last modified", { selector: "dt" })).not.toBeInTheDocument();
  });

  it("keeps assignment identities readable in Manage for viewers and pages long lists", async () => {
    renderDetail({
      activeTab: "controls", roles: ["AgentControl.Viewer"],
      packageDetail: {
        ...record.packages[0], allowedUsersAndGroups: Array.from({ length: 10 }, (_, index) => ({ resourceType: "group", resourceId: `group-${index}` })),
        acquireUsersAndGroups: [{ resourceType: "user", resourceId: "installed-user" }],
      },
    });
    const availability = screen.getByRole("group", { name: "Saved users and groups" });
    expect(within(availability).getByText("group-0")).toBeVisible();
    expect(within(availability).getAllByRole("listitem")).toHaveLength(8);
    await userEvent.click(within(availability).getByRole("button", { name: "Next assignments" }));
    expect(within(availability).getAllByRole("listitem")).toHaveLength(2);
    expect(within(availability).getByText("group-9")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    expect(screen.getByText("installed-user", { exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Manage access|Manage installation/ })).not.toBeInTheDocument();
  });

  it("distinguishes unloaded, unreported and explicitly empty saved assignments", async () => {
    const item = { ...record.packages[0], availableTo: "some", deployedTo: "some" };
    const { update } = renderDetail({
      activeTab: "controls", roles: ["AgentControl.Viewer"], record: { ...record, packages: [item] },
    });
    expect(screen.getByText("Loading saved agent details...")).toBeVisible();
    update({ packageDetail: { ...item, acquireUsersAndGroups: [] } });
    expect(screen.getByRole("group", { name: "Saved users and groups" })).toHaveTextContent("Assignments not reported");
    await userEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    expect(screen.getByRole("group", { name: "Saved users and groups" })).toHaveTextContent("No explicit user or group assignments");
    update({ packageDetail: { ...item, allowedUsersAndGroups: [], acquireUsersAndGroups: [] } });
    await userEvent.click(screen.getByRole("button", { name: /^Available to/ }));
    expect(screen.getByRole("group", { name: "Saved users and groups" })).toHaveTextContent("No explicit user or group assignments");
  });

  it("uses the selected saved detail's block status consistently when choosing the exact control", async () => {
    const { props } = renderDetail({
      activeTab: "controls", packageDetail: { ...record.packages[0], isBlocked: true },
    });
    const blocking = screen.getByRole("group", { name: "Blocking for package-1" });
    expect(within(blocking).getByText("Blocked", { exact: true })).toBeVisible();
    await userEvent.click(within(blocking).getByRole("button", { name: "Unblock Package one (package-1)" }));
    expect(props.onSetPackageBlocked).toHaveBeenCalledExactlyOnceWith(record.packages[0], false);
  });

  it("edits availability and installation directly, preserving their separate drafts across the main tabs", async () => {
    const { props } = renderDetail({ packageDetail: { ...record.packages[0], availableTo: "all", deployedTo: "none" } });
    await userEvent.click(screen.getByRole("tab", { name: "Manage" }));
    const dialog = screen.getByRole("dialog", { name: record.displayName });
    expect(within(dialog).queryByRole("button", { name: /Manage access|Manage installation/ })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /All users/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /All users/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: /No users/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    await userEvent.click(screen.getByRole("radio", { name: /Specific users or groups/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Available to/ }));
    expect(screen.getByRole("radio", { name: /No users/ })).toBeChecked();
    await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
    await userEvent.click(screen.getByRole("tab", { name: "Manage" }));
    expect(screen.getByRole("radio", { name: /No users/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(props.onUpdatePackageAccess).toHaveBeenCalledExactlyOnceWith(record.packages[0], {
      target: "availability", mode: "replace", scope: "none", principals: [],
    });
    expect(screen.getAllByRole("dialog")).toEqual([dialog]);
    await userEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    expect(screen.getByRole("radio", { name: /Specific users or groups/ })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByRole("radio", { name: /No users/ })).toBeChecked();
  });

  it("loads successful access changes without returning installation to the availability setting", async () => {
    const detail = { ...record.packages[0], availableTo: "all", deployedTo: "none" };
    const { update } = renderDetail({ activeTab: "controls", packageDetail: detail });
    await userEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    update({ packageDetail: { ...detail, deployedTo: "some", acquireUsersAndGroups: [{ resourceType: "group", resourceId: "new-group" }] }, packageAccessRevisions: new Map([["package-1", 1]]) });
    expect(screen.getByRole("region", { name: "Installation settings" })).toBeVisible();
    expect(screen.getByRole("radio", { name: /Specific users or groups/ })).toBeChecked();
    expect(screen.getByText("new-group", { exact: true })).toBeVisible();
  });

  it("resolves installation assignments only after the setting navigation becomes enabled", async () => {
    const installed = { resourceType: "user", resourceId: "installed-user", displayName: "Installed user", principalKind: "user" as const };
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: [installed] });
    const detail = {
      ...record.packages[0], availableTo: "none", allowedUsersAndGroups: [],
      deployedTo: "some", acquireUsersAndGroups: [{ resourceType: installed.resourceType, resourceId: installed.resourceId }],
    };
    const { update } = renderDetail({
      activeTab: "controls", packageDetail: detail, packageActionsBusy: true,
    }, capabilitiesWithDirectory());
    expect(screen.queryByText("Loading saved agent details...")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Installed for/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    expect(screen.getByRole("region", { name: "Availability settings" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Installation settings" })).not.toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
    update({ packageActionsBusy: false });
    expect(screen.getByRole("button", { name: /^Installed for/ })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    expect(screen.getByRole("region", { name: "Installation settings" })).toBeVisible();
    expect(await screen.findByText("Installed user", { exact: true })).toBeVisible();
    expect(resolve).toHaveBeenCalledExactlyOnceWith(detail.acquireUsersAndGroups, { signal: expect.any(AbortSignal) });
  });

  it("shows paused assignment resolution while inventory prevents editing, then resumes once", async () => {
    const assigned: api.DirectoryPrincipal = {
      resourceType: "user", resourceId: "assigned-user", displayName: "Assigned user", principalKind: "user",
    };
    let complete!: (response: { value: api.DirectoryPrincipal[] }) => void;
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals")
      .mockReturnValueOnce(new Promise(done => { complete = done; }))
      .mockResolvedValue({ value: [assigned] });
    const detail = { ...record.packages[0], availableTo: "some", allowedUsersAndGroups: [assigned] };
    const { update } = renderDetail({ activeTab: "controls", packageDetail: detail }, capabilitiesWithDirectory());
    await waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    expect(screen.getByText("Resolving current assignments...")).toBeVisible();

    update({ packageInventoryPending: true });
    expect(resolve.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(screen.queryByText("Resolving current assignments...")).not.toBeInTheDocument();
    expect(screen.getByText("Assignment lookup is paused until editing resumes.")).toBeVisible();
    await act(async () => complete({ value: [{ ...assigned, displayName: "Obsolete assignment" }] }));
    expect(screen.queryByText("Obsolete assignment")).not.toBeInTheDocument();
    expect(resolve).toHaveBeenCalledOnce();

    update({ packageInventoryPending: false });
    expect(await screen.findByText("Assigned user")).toBeVisible();
    expect(screen.queryByText("Assignment lookup is paused until editing resumes.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("restarts pending assignment resolution after a saved-detail reload and ignores the cancelled response", async () => {
    type Resolution = Awaited<ReturnType<typeof api.resolveDirectoryPrincipals>>;
    let completeStale!: (response: Resolution) => void;
    const stale = new Promise<Resolution>(resolve => { completeStale = resolve; });
    const installed = { resourceType: "user", resourceId: "installed-user", displayName: "Installed user", principalKind: "user" as const };
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals")
      .mockReturnValueOnce(stale)
      .mockResolvedValue({ value: [installed] });
    const detail = {
      ...record.packages[0], availableTo: "none", allowedUsersAndGroups: [],
      deployedTo: "some", acquireUsersAndGroups: [{ resourceType: installed.resourceType, resourceId: installed.resourceId }],
    };
    const { update } = renderDetail({
      activeTab: "controls", packageDetail: detail, packageAccessRevisions: new Map([[detail.id, 1]]),
    }, capabilitiesWithDirectory());
    await userEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    expect(resolve).toHaveBeenCalledExactlyOnceWith(detail.acquireUsersAndGroups, { signal: expect.any(AbortSignal) });
    expect(screen.getByText("Resolving current assignments...")).toBeVisible();
    update({ packageDetail: undefined, packageDetailLoading: true });
    expect(screen.getByRole("region", { name: "Installation settings" })).toBeVisible();
    update({
      packageDetail: { ...detail, acquireUsersAndGroups: detail.acquireUsersAndGroups.map(principal => ({ ...principal })) },
      packageDetailLoading: false,
    });
    expect(screen.getByRole("region", { name: "Installation settings" })).toBeVisible();
    expect(await screen.findByText("Installed user", { exact: true })).toBeVisible();
    expect(resolve).toHaveBeenCalledTimes(2);
    await act(async () => completeStale({ value: [{ ...installed, displayName: "Stale installed user" }] }));
    expect(screen.getByText("Installed user", { exact: true })).toBeVisible();
    expect(screen.queryByText("Stale installed user")).not.toBeInTheDocument();
  });

  it("retains completed assignment resolution when a saved reload interrupts its promise completion", async () => {
    type Resolution = Awaited<ReturnType<typeof api.resolveDirectoryPrincipals>>;
    let complete!: (response: Resolution) => void;
    const request = new Promise<Resolution>(resolve => { complete = resolve; });
    const installed = { resourceType: "user", resourceId: "installed-user", displayName: "Installed user", principalKind: "user" as const };
    const resolve = vi.spyOn(api, "resolveDirectoryPrincipals").mockReturnValue(request);
    const detail = {
      ...record.packages[0], availableTo: "none", allowedUsersAndGroups: [],
      deployedTo: "some", acquireUsersAndGroups: [{ resourceType: installed.resourceType, resourceId: installed.resourceId }],
    };
    const { update } = renderDetail({
      activeTab: "controls", packageDetail: detail, packageAccessRevisions: new Map([[detail.id, 1]]),
    }, capabilitiesWithDirectory());
    await userEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    expect(resolve).toHaveBeenCalledExactlyOnceWith(detail.acquireUsersAndGroups, { signal: expect.any(AbortSignal) });
    const interrupt = request.then(() => {
      flushSync(() => update({ packageDetail: undefined, packageDetailLoading: true }));
    });
    await act(async () => {
      complete({ value: [installed] });
      await interrupt;
    });
    update({ packageDetail: { ...detail }, packageDetailLoading: false });
    expect(screen.getByRole("region", { name: "Installation settings" })).toBeVisible();
    expect(screen.getByText("Installed user", { exact: true })).toBeVisible();
    expect(screen.queryByText("Resolving current assignments...")).not.toBeInTheDocument();
    expect(resolve).toHaveBeenCalledExactlyOnceWith(detail.acquireUsersAndGroups, { signal: expect.any(AbortSignal) });
  });

  it("does not relabel an unsaved assignment draft as saved when directory permission becomes unavailable", async () => {
    const principals = ["saved-a", "saved-b"].map(resourceId => ({
      resourceId, resourceType: "group", displayName: resourceId, principalKind: "unknown" as const,
    }));
    vi.spyOn(api, "resolveDirectoryPrincipals").mockResolvedValue({ value: principals });
    const views = capabilitiesWithDirectory();
    const { props, update } = renderDetail({
      activeTab: "controls", packageDetail: {
        ...record.packages[0], availableTo: "some",
        allowedUsersAndGroups: principals.map(({ resourceId, resourceType }) => ({ resourceId, resourceType })),
      },
    }, views);
    await userEvent.click(await screen.findByRole("button", { name: "Remove saved-a" }));
    update({}, capabilities());
    const selected = screen.getByRole("group", { name: "Selected users and groups" });
    expect(selected).toHaveTextContent("1 selected user or group assignment");
    expect(within(selected).getByText("saved-b")).toBeVisible();
    expect(within(selected).queryByText("saved-a")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Saved users and groups" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(props.onUpdatePackageAccess).not.toHaveBeenCalled();
  });

  it.each(["main tab", "access target"])("cancels hidden directory searches after changing the %s", async transition => {
    let complete!: (value: { value: api.DirectoryPrincipal[] }) => void;
    const search = vi.spyOn(api, "searchDirectoryPrincipals")
      .mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const { update } = renderDetail({
      activeTab: "controls", packageDetail: { ...record.packages[0], availableTo: "none", deployedTo: "none" },
    }, capabilitiesWithDirectory());
    fireEvent.click(screen.getByRole("radio", { name: /Specific users or groups/ }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Directory" } });
    await waitFor(() => expect(search).toHaveBeenCalledOnce());

    if (transition === "main tab") update({ activeTab: "identities" });
    else fireEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    expect(search.mock.calls[0][2]?.signal?.aborted).toBe(true);
    await act(async () => complete({ value: [{
      resourceId: "obsolete-user", resourceType: "user", principalKind: "user", displayName: "Hidden directory result",
    }] }));
    expect(screen.queryByText("Hidden directory result")).not.toBeInTheDocument();
  });

  it("keeps preview errors and retry in the inline editor without creating another dialog", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("Current access could not be verified")).mockResolvedValue(undefined);
    renderDetail({ activeTab: "controls", onUpdatePackageAccess: submit });
    await userEvent.click(screen.getByRole("radio", { name: /No users/ }));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Current access could not be verified");
    expect(screen.getByRole("radio", { name: /No users/ })).toBeChecked();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Available to/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Current access could not be verified");
    expect(submit).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["graph_packages", "power_platform", "both"] as const)("shows honest agent-specific usage availability for %s without importing unrelated reports", async presence => {
    const observed = observedRecord();
    const current: UnifiedAgentRecord = {
      ...observed, presence, displayName: "Researcher",
      packages: presence === "power_platform" ? [] : observed.packages,
      powerPlatformResource: presence === "graph_packages" ? null : observed.powerPlatformResource,
    };
    const { props, update } = renderDetail({ record: current, activeTab: "reports" });
    const usage = await screen.findByRole("region", { name: "Usage for Researcher" });
    expect(await within(usage).findByRole("alert")).toHaveTextContent("Report data is unavailable. Reload usage to try again.");
    expect(within(usage).queryByText(/Missing usage data does not mean zero usage/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Agent users" })).not.toBeInTheDocument();
    expect(reportApi.readAgentReportSummary).toHaveBeenCalledExactlyOnceWith(current.id,
      { selectionId: undefined, setId: undefined }, expect.any(AbortSignal));
    expect(reportApi.readAgentReportAssociations).not.toHaveBeenCalled();
    expect(reportApi.readReportDetail).not.toHaveBeenCalled();
    expect(reportApi.readReportPage).not.toHaveBeenCalled();
    expect(within(usage).getByRole("button", { name: "Reload usage" })).toBeEnabled();
    await userEvent.click(screen.getByRole("tab", { name: "Manage" }));
    expect(props.onTabChange).toHaveBeenLastCalledWith("controls");
    update({ activeTab: "controls" });
    expect(screen.getByRole("heading", { name: "Manage" })).toBeVisible();
    expect(props.onUpdatePackageAccess).not.toHaveBeenCalled();
    expect(props.onSetPackageBlocked).not.toHaveBeenCalled();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
  it("falls back to Overview for an unknown route and supports keyboard tab navigation", () => {
    const { props, update } = renderDetail({ activeTab: "legacy-unknown-tab" });
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    update({ activeTab: undefined });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveFocus();
    expect(props.onTabChange).toHaveBeenLastCalledWith("audit-security");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Activity" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
    expect(props.onTabChange).toHaveBeenLastCalledWith("identities");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Activity" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
  });

  it("keeps unavailable usage scoped to the current agent across record and name changes", async () => {
    const first: UnifiedAgentRecord = { ...record, displayName: "Researcher", presence: "graph_packages", powerPlatformResource: null };
    const { update } = renderDetail({ record: first, activeTab: "reports" });
    expect(await screen.findByRole("region", { name: "Usage for Researcher" })).toBeVisible();
    update({ record: { ...first, id: "different-agent" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Report data is unavailable.");
    update({ record: { ...first, id: "different-agent", displayName: "Different agent" } });
    expect(screen.getByRole("region", { name: "Usage for Different agent" })).toBeVisible();
    expect(screen.queryByText("Researcher")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Tenant report totals")).not.toBeInTheDocument();
    expect(reportApi.readAgentReportSummary).toHaveBeenLastCalledWith("different-agent",
      { selectionId: undefined, setId: undefined }, expect.any(AbortSignal));
    expect(reportApi.readReportDetail).not.toHaveBeenCalled();
    expect(reportApi.readReportPage).not.toHaveBeenCalled();
  });

  it("refreshes the mounted agent users on a data revision without resetting the tab or search", async () => {
    reportUsage();
    const { update } = renderDetail({
      activeTab: "users", usageContext: automaticUsageContext, inventoryRevision: "a".repeat(64),
      record: { ...record, usage: automaticAgentUsageFixture() },
    });
    await screen.findByText("agent-user-1@example.invalid");
    const search = screen.getByRole("searchbox", { name: "Search agent users" });
    fireEvent.change(search, { target: { value: "Agent user" } });
    await waitFor(() => expect(reportApi.readReportPage).toHaveBeenCalledTimes(2));
    search.focus();
    update({ dataRevision: 1 });
    await waitFor(() => expect(reportApi.readReportPage).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("tab", { name: "Users" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("searchbox", { name: "Search agent users" })).toBe(search);
    expect(search).toHaveValue("Agent user");
    expect(search).toHaveFocus();
  });

  it("keeps usage mounted when the inventory selection UUID changes only in case", async () => {
    const selected = "abcdefab-abcd-4abc-8abc-abcdefabcdef";
    const context = { ...reportContext, selectionId: selected };
    vi.mocked(reportApi.readAgentReportSummary).mockResolvedValue({
      recordId: record.id, status: "linked", responses: 181, activeUsers: 7, lastActivityDateUtc: null, associationCount: 0, context,
    });
    vi.mocked(reportApi.readAgentReportAssociations).mockResolvedValue({
      value: [], context, counts: { total: 0, filtered: 0 }, page: { limit: 50, nextCursor: null, previousCursor: null },
    });
    const page = reportPage([{ username: "person@example.invalid", displayName: "Person", responses: 181 }]);
    const usageUsers: CandidateAgentUsageUsers = { ...page, context, selection: { ...page.selection, id: selected } };
    vi.mocked(reportApi.readReportPage).mockResolvedValue(usageUsers);
    const { update } = renderDetail({
      activeTab: "users", selectionId: selected.toUpperCase(), usageContext: automaticUsageContext, inventoryRevision: "a".repeat(64),
    });
    await screen.findByText("person@example.invalid");
    const search = screen.getByRole("searchbox");
    search.focus();
    update({ selectionId: selected });
    expect(screen.getByRole("searchbox")).toBe(search);
    expect(search).toHaveFocus();
    expect(reportApi.readAgentReportHistory).toHaveBeenCalledOnce();
    expect(reportApi.readAgentReportSummary).toHaveBeenCalledOnce();
    expect(reportApi.readAgentReportAssociations).toHaveBeenCalledOnce();
    expect(reportApi.readReportPage).toHaveBeenCalledOnce();
  });

  it("blocks reviewed-link removal while parent inventory verification is pending or failed", async () => {
    const retry = vi.fn();
    const remove = vi.mocked(reportApi.mutateAgentReportAssociation);
    reportUsage({ reportAgentId: automaticUsagePackageId, agentName: "Reviewed report identity", responses: 181, basis: "reviewed",
      target: { source: "power_platform", nativeId: "native-1", environmentId: "environment-1", snapshotId: "exact-snapshot" } });
    const { update } = renderDetail({
      activeTab: "users", roles: ["AgentControl.Admin"], usageContext: automaticUsageContext,
      inventoryRevision: "a".repeat(64), onUsageChanged: vi.fn(), onRetryInventory: retry,
      record: { ...record, usage: automaticAgentUsageFixture({ recordId: record.id }) },
    });
    await userEvent.click(await screen.findByText("Reviewed report links"));
    const trigger = screen.getByRole("button", { name: `Remove association for Reviewed report identity (${automaticUsagePackageId})` });
    expect(trigger).toBeEnabled();
    await userEvent.click(trigger);
    expect(screen.getByRole("checkbox")).toBeVisible();
    update({ packageInventoryPending: true });
    expect(trigger).toBeDisabled();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    update({ inventoryError: "Saved inventory verification failed." });
    expect(trigger).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Saved inventory verification failed.");
    await userEvent.click(screen.getByRole("button", { name: "Retry saved inventory" }));
    expect(retry).toHaveBeenCalledOnce();
    update({});
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });

  it("loads automatically matched agent users only on the Users tab without setup, candidates or writes", async () => {
    reportUsage();
    const candidates = vi.mocked(reportApi.readAgentReportCandidates);
    const mutation = vi.mocked(reportApi.mutateAgentReportAssociation);
    const { update } = renderDetail({
      usageContext: automaticUsageContext, inventoryRevision: "a".repeat(64), onUsageChanged: vi.fn(),
      record: {
        ...record, displayName: "Excel", packages: [{ ...record.packages[0], id: automaticUsagePackageId, displayName: "Excel" }],
        usage: automaticAgentUsageFixture(),
      },
    });
    expect(reportApi.readReportPage).not.toHaveBeenCalled();
    expect(reportApi.readAgentReportSummary).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("tab", { name: "Usage" }));
    expect(await screen.findByRole("region", { name: "Reported usage trend" })).toBeVisible();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(reportApi.readReportPage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("tab", { name: "Users" }));
    expect(screen.queryByRole("region", { name: "Reported usage trend" })).not.toBeInTheDocument();
    const usage = screen.getByRole("region", { name: "Users for Excel" });
    expect(await within(usage).findByLabelText("Selected agent report metrics")).toHaveTextContent("181");
    expect(await within(usage).findByText("agent-user-1@example.invalid")).toBeVisible();
    expect(within(usage).getByRole("navigation", { name: "users pages" })).toHaveTextContent("7 matching users");
    expect(within(usage).getByText("agent-user-1@example.invalid")).toBeVisible();
    expect(within(usage).queryByRole("button", { name: automaticUsageReportName })).not.toBeInTheDocument();
    expect(within(usage).queryByText(/Automatically matched: exact report Agent ID/)).not.toBeInTheDocument();
    expect(within(usage).queryByRole("button", { name: /association|candidate|setup/i })).not.toBeInTheDocument();
    expect(reportApi.readReportPage).toHaveBeenCalledExactlyOnceWith(`agent-inventory/${encodeURIComponent(record.id)}/usage-users`,
      expect.objectContaining({ selectionId, limit: 25, search: undefined }), expect.any(AbortSignal));
    expect(candidates).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
    expect(reportApi.readReportDetail).not.toHaveBeenCalled();
    update({ usageContext: { ...automaticUsageContext, reports: { ...reports, setId: "other-snapshot" } } });
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(screen.queryByText("agent-user-1@example.invalid")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(/does not match|changed/);
    expect(reportApi.readReportPage).toHaveBeenCalledOnce();
  });

  it("resets panel scroll when switching tasks", () => {
    renderDetail();
    const overview = screen.getByRole("tabpanel", { name: "Overview" });
    overview.scrollTop = 500;
    fireEvent.click(screen.getByRole("tab", { name: "Manage" }));
    expect(screen.getByRole("tabpanel", { name: "Manage" }).scrollTop).toBe(0);
  });
  it("accepts the singular shorthand but always emits the existing identities tab ID", () => {
    const { props } = renderDetail({ activeTab: "identity" });
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toHaveAttribute("id", "unified-agent-panel-identities");
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(props.onTabChange).toHaveBeenCalledExactlyOnceWith("identities");
  });

  it("keeps exact useful IDs visible without duplicating corroborated source proof", async () => {
    const corroborated = corroboratedRecord(true);
    renderDetail({ record: corroborated, activeTab: "identities" });
    expect(screen.getByRole("region", { name: "Identifiers" })).toBeVisible();
    expect(screen.getByText("Agent ID").nextElementSibling).toHaveTextContent(corroborated.powerPlatformResource!.nativeId);
    expect(screen.getAllByText("Environment ID")).toHaveLength(1);
    expect(screen.queryByText("Environment schema native id")).not.toBeInTheDocument();
    expect(screen.queryByText(/Control access is checked separately/)).not.toBeInTheDocument();
    expect(screen.queryByText(corroborated.identity.evidence[0].packagePath)).not.toBeInTheDocument();
    expect(screen.queryByText(corroborated.identity.evidence[0].resourcePath)).not.toBeInTheDocument();
    expect(screen.getByRole("tabpanel", { name: "Overview" }).querySelector(".agent-overview details")).toBeNull();
  });

  it("omits informational source-identity disagreements without changing native control eligibility", async () => {
    const observed = observedRecord();
    const message = "Graph and Power Platform supplied different source-specific agent identity IDs; the exact native environment and bot agree.";
    const { update } = renderDetail({
      record: { ...observed, identity: { ...observed.identity, warnings: [{ code: "source_specific_agent_identity", message }] } },
    });
    expect(screen.queryByRole("heading", { name: "Source identity warnings" })).not.toBeInTheDocument();
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Conflicting link evidence" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Manage" }));
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    update({ record: observed });
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    expect(api.previewQuarantine).not.toHaveBeenCalled();
  });

  it.each(["matched", "unmatched"] as const)("shows actionable invalid metadata without disabling exact package controls for a %s record", async state => {
    const observed = observedRecord();
    const { update } = renderDetail({
      record: { ...observed, identity: { ...observed.identity, state, invalidMetadata: true } },
      activeTab: "controls",
    });
    const diagnostic = screen.getByText("Invalid saved matching metadata.");
    expect(diagnostic).toBeVisible();
    expect(diagnostic.parentElement).toHaveTextContent("Select this agent on Agents");
    expect(diagnostic.parentElement).toHaveTextContent("Sync > View diagnostics");
    expect(diagnostic.parentElement).toHaveTextContent("Refresh matching details");
    expect(screen.getByRole("button", { name: /^Available to/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^Installed for/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /No users/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Block Package one (package-1)" })).toBeEnabled();
    expect(api.previewQuarantine).not.toHaveBeenCalled();
    update({ record: observed });
    expect(screen.queryByText("Invalid saved matching metadata.")).not.toBeInTheDocument();
  });

  it("does not contradict a completed identity collection with instructions to repeat it", async () => {
    const reason = "Package details were collected, but no source-declared agent identity metadata was supplied.";
    renderDetail({ record: {
      ...record, presence: "graph_packages", powerPlatformResource: null,
      identity: { state: "unmatched", evidence: [], packageEvidence: [], reason },
    } });
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
    expect(screen.queryByText("Refresh matching details")).not.toBeInTheDocument();
  });

  it.each([false, true])("requires an explicit backend-supplied CDS bot identifier despite corroborated evidence (supplied=%s)", async supplied => {
    renderDetail({ record: corroboratedRecord(supplied), activeTab: "controls" });
    if (supplied) expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    else {
      expect(screen.queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
      expect(screen.getByText(/one valid native CDS bot identity/)).toBeInTheDocument();
    }
    expect(api.previewQuarantine).not.toHaveBeenCalled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it("shows only the selected package ID for shared custom-engine versions, not duplicate linking evidence", async () => {
    const grouped = sharedCustomEngineRecord();
    const { update } = renderDetail({ record: grouped });
    expect(screen.queryByRole("list", { name: "Related exact packages" })).not.toBeInTheDocument();
    expect(screen.getByText("Package ID").nextElementSibling).toHaveTextContent(grouped.packages[0].id);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Published version details" }), grouped.packages[1].id);
    expect(screen.getByText("Package ID").nextElementSibling).toHaveTextContent(grouped.packages[1].id);
    expect(screen.queryByText("Shared custom engine bot id")).not.toBeInTheDocument();
    expect(screen.queryByText(/Control access is checked separately/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not presented as a publicly documented Microsoft canonical identifier equivalence/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not a Microsoft-guaranteed native foreign key/)).not.toBeInTheDocument();
    expect(screen.queryByText(/does not grant or renew native controls/)).not.toBeInTheDocument();
    update({ record: observedRecord() });
    expect(screen.queryByRole("list", { name: "Related exact packages" })).not.toBeInTheDocument();
  });

  it("keeps native management eligibility when linking proof labels are empty and absent from Overview", async () => {
    const grouped = sharedCustomEngineRecord();
    for (const evidence of grouped.identity.evidence) evidence.elementIds = ["", ""];
    renderDetail({ record: grouped });
    expect(screen.queryByRole("heading", { name: "Linked by source metadata" })).not.toBeInTheDocument();
    expect(screen.queryByText(/element labels Not supplied/)).not.toBeInTheDocument();
    expect(screen.queryByText("Bots.definition.botId + CustomEngineCopilots.definition.id")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Related exact packages" })).not.toBeInTheDocument();
    expect(screen.queryByText("Invalid saved matching metadata.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Manage" }));
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    expect(api.previewQuarantine).not.toHaveBeenCalled();
  });

  it.each([false, true])("retains separate custom-engine package controls and requires explicit CDS proof (%s)", async supplied => {
    const grouped = sharedCustomEngineRecord(supplied);
    const botApplicationId = "55555555-5555-4555-8555-555555555555";
    if (!supplied) grouped.powerPlatformResource!.nativeId = botApplicationId;
    const { props } = renderDetail({ record: grouped, activeTab: "controls" });
    for (const item of grouped.packages) {
      await submitInlineAccess(item, "availability");
      expect(props.onUpdatePackageAccess).toHaveBeenLastCalledWith(item, { target: "availability", mode: "replace", scope: "none", principals: [] });
      await submitInlineAccess(item, "installation");
      expect(props.onUpdatePackageAccess).toHaveBeenLastCalledWith(item, { target: "installation", mode: "replace", scope: "none", principals: [] });
      await userEvent.click(screen.getByRole("button", { name: `${item.isBlocked ? "Unblock" : "Block"} ${item.displayName} (${item.id})` }));
      expect(props.onSetPackageBlocked).toHaveBeenLastCalledWith(item, !item.isBlocked);
    }
    if (supplied) {
      vi.mocked(api.previewQuarantine).mockRejectedValue(new Error("Synthetic preview stopped before any submission."));
      await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
      await waitFor(() => expect(api.previewQuarantine).toHaveBeenCalledExactlyOnceWith({
        action: "quarantine", snapshotId: grouped.observations.powerPlatform!.snapshotId,
        resourceNativeIds: [grouped.powerPlatformResource!.nativeId],
      }, { signal: expect.any(AbortSignal) }));
      expect(grouped.powerPlatformResource!.nativeId).not.toBe(botApplicationId);
    } else {
      expect(screen.queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
      expect(screen.getByText(/one valid native CDS bot identity/)).toBeInTheDocument();
      expect(api.previewQuarantine).not.toHaveBeenCalled();
    }
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it.each([
    ["manifest_schema_native_id", "Manifest schema native id", "manifestId", "nativeId + details.schemaName"],
    ["environment_entra_app_id", "Environment entra app id", "SourceIds.EnvironmentId + BotDefinitions.msAppId", "environmentId + identifiers.entra_app_id"],
  ] as const)("omits %s linking diagnostics without deriving a CDS quarantine target", async (kind, heading, packagePath, resourcePath) => {
    const observed = observedRecord();
    const evidence: UnifiedAgentRecord["identity"]["evidence"] = [{
      kind, basis: "source_declared_metadata", elementIds: ["metadata-1"], packagePath, resourcePath,
    }];
    renderDetail({
      record: {
        ...observed,
        packages: observed.packages.map(item => ({ ...item, manifestId: botId })),
        powerPlatformResource: {
          ...observed.powerPlatformResource!, nativeId: botId, details: { schemaName: botId },
          quarantineIdentity: null,
          identifiers: [{ kind: "environment_id", value: environmentId }],
        },
        identity: { state: "matched", evidence, packageEvidence: [{ packageId: "package-1", evidence }], reason: null },
      },
    });
    expect(screen.queryByText(heading)).not.toBeInTheDocument();
    expect(screen.queryByText(/Source declared metadata/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Control access is checked separately/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Manage" }));
    expect(screen.queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
    expect(screen.getByText(/one valid native CDS bot identity/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /No users/ })).toBeEnabled();
    expect(api.previewQuarantine).not.toHaveBeenCalled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it("retains Power Platform ownership, configuration and connector details in Agents", () => {
    const resource = {
      ...record.powerPlatformResource,
      authoringTool: null,
      details: {
        createdIn: "FutureProvider.vNext_build-X",
        ownerId: "native-owner",
        schemaName: "native-schema",
        model: "configured-model",
        authentication: "configured-authentication",
        orchestration: "configured-orchestration",
        connectors: [{ connectorId: "native-connector", operations: [{ operationId: "operation-1", usedAs: "action" }] }],
        capabilityDetailsTruncated: true,
      },
    };
    render(<WorkbenchActionProvider value={[]}>
      <UnifiedAgentDetailModal
        record={{ ...record, powerPlatformResource: resource }}
        activeTab="identities" roles={["AgentControl.Viewer"]}
        onTabChange={vi.fn()} onClose={vi.fn()} onInspectPackage={vi.fn()}
        onUpdatePackageAccess={vi.fn().mockResolvedValue(undefined)} onSetPackageBlocked={vi.fn()}
      />
    </WorkbenchActionProvider>);
    for (const value of ["native-owner", "native-schema", "configured-model", "configured-authentication", "configured-orchestration", "native-connector", "operation-1"]) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
    expect(screen.getByText("Authoring source").nextElementSibling).toHaveTextContent("FutureProvider.vNext_build-X");
    expect(screen.queryByText("Authoring tool", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("Some connector or operation details are unavailable.")).toBeInTheDocument();
  });

  it.each(["identities", "reports", "controls", "audit-security"])("does not fetch or duplicate legacy source associations from %s", async activeTab => {
    const context = vi.spyOn(api, "getAgentInvestigationContext").mockResolvedValue({
      recordId: record.id, displayName: record.displayName,
      defender: { status: "unavailable", entraAgentIds: [], reasonCode: "unsupported_identity_crosswalk" },
      purview: { status: "unavailable", mode: "search", presets: [], reasonCode: "unsupported_identity_crosswalk" },
    });
    renderDetail({ record: observedRecord(), activeTab });
    if (activeTab === "audit-security") {
      expect(await screen.findByRole("heading", { name: "Purview linking not supported for this agent" })).toBeVisible();
      expect(context).toHaveBeenCalledOnce();
      expect(screen.getByRole("region", { name: /Investigations for/ }).querySelector("details")).toBeNull();
    } else expect(context).not.toHaveBeenCalled();
    expect(screen.queryByText(/Saved observations for|No saved activity is linked/)).not.toBeInTheDocument();
  });

  it("keeps Purview and ready content during same-agent refreshes, then replaces the saved context", async () => {
    const context = {
      recordId: record.id, displayName: record.displayName,
      defender: { status: "unavailable" as const, entraAgentIds: [], reasonCode: "unsupported_identity_crosswalk" as const },
      purview: { status: "unavailable" as const, mode: "search" as const, presets: [], reason: "No exact bot mapping." },
    };
    const lookup = vi.spyOn(api, "getAgentInvestigationContext").mockResolvedValueOnce(context).mockResolvedValueOnce({
      ...context, purview: { ...context.purview, reason: "Updated saved mapping is unavailable." },
    });
    const { update } = renderDetail({ activeTab: "audit-security", inventoryRevision: "first" });
    await screen.findByRole("heading", { name: "Purview identity not mapped" });
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "purview" } });
    expect(screen.getByText("No exact bot mapping.")).toBeVisible();
    update({ dataRevision: 1, inventoryRevision: "second" });
    expect(screen.getByRole("combobox", { name: "Source" })).toHaveValue("purview");
    expect(screen.getByText("No exact bot mapping.")).toBeVisible();
    await screen.findByText("Updated saved mapping is unavailable.");
    expect(screen.queryByText("No exact bot mapping.")).not.toBeInTheDocument();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("combobox", { name: "Source" })).toHaveValue("purview");
  });

  it("offers common Manage controls for every package and quarantine with exact target callbacks", async () => {
    const observed = observedRecord();
    observed.packages = [
      { ...record.packages[0], availableTo: "all", deployedTo: "some" },
      { ...record.packages[0], id: "package-2", displayName: "Package two", isBlocked: true },
    ];
    const { props } = renderDetail({ record: observed, activeTab: "controls" });
    expect(screen.getByRole("heading", { name: "Manage" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Quarantine and restore" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Availability settings" })).toHaveTextContent("Saved: All users");
    await userEvent.click(screen.getByRole("button", { name: /^Installed for/ }));
    expect(screen.getByRole("region", { name: "Installation settings" })).toHaveTextContent("Saved: Specific users or groups");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Published version details" }), "package-2");
    expect(screen.getByRole("region", { name: "Availability settings" })).toHaveTextContent("Saved: Unknown");
    for (const item of observed.packages) {
      await submitInlineAccess(item, "availability");
      expect(props.onUpdatePackageAccess).toHaveBeenLastCalledWith(item, { target: "availability", mode: "replace", scope: "none", principals: [] });
      await submitInlineAccess(item, "installation");
      expect(props.onUpdatePackageAccess).toHaveBeenLastCalledWith(item, { target: "installation", mode: "replace", scope: "none", principals: [] });
      await userEvent.click(screen.getByRole("button", { name: `${item.isBlocked ? "Unblock" : "Block"} ${item.displayName} (${item.id})` }));
      expect(props.onSetPackageBlocked).toHaveBeenLastCalledWith(item, !item.isBlocked);
    }
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restore from quarantine" })).toBeEnabled();
    expect(screen.getByText("Quarantine blocks connected channels; makers can still test in Copilot Studio. Package blocking is separate.")).toBeVisible();
    expect(api.previewQuarantine).not.toHaveBeenCalled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it("keeps package-only controls available without advertising an inapplicable quarantine section", () => {
    renderDetail({ record: { ...record, powerPlatformResource: null }, activeTab: "controls" });
    expect(screen.getByRole("radio", { name: /No users/ })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "Quarantine and restore" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
    expect(api.previewQuarantine).not.toHaveBeenCalled();
  });

  it.each([null, environmentId])("retains every control in a graph-only package group with environment %s", async knownEnvironment => {
    const group: UnifiedAgentRecord = {
      ...record, id: "agent:33333333-3333-4333-8333-333333333333",
      presence: "graph_packages", environmentId: knownEnvironment, powerPlatformResource: null,
      packages: [record.packages[0], { ...record.packages[0], id: "package-2", displayName: "Package two", isBlocked: true }],
      identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: "No verified Power Platform counterpart." },
    };
    const { props } = renderDetail({ record: group, activeTab: "controls" });
    for (const item of group.packages) {
      await submitInlineAccess(item, "availability");
      expect(props.onUpdatePackageAccess).toHaveBeenLastCalledWith(item, { target: "availability", mode: "replace", scope: "none", principals: [] });
      await submitInlineAccess(item, "installation");
      expect(props.onUpdatePackageAccess).toHaveBeenLastCalledWith(item, { target: "installation", mode: "replace", scope: "none", principals: [] });
      await userEvent.click(screen.getByRole("button", { name: `${item.isBlocked ? "Unblock" : "Block"} ${item.displayName} (${item.id})` }));
      expect(props.onSetPackageBlocked).toHaveBeenLastCalledWith(item, !item.isBlocked);
    }
    expect(screen.queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
    expect(api.previewQuarantine).not.toHaveBeenCalled();
  });

  it("keeps each merged Builder package control without treating its manifest as a CDS bot", async () => {
    const observed = observedRecord();
    const manifestId = "44444444-4444-4444-8444-444444444444";
    observed.packages = [
      { ...record.packages[0], manifestId },
      { ...record.packages[0], id: "package-2", displayName: "Package two", manifestId, isBlocked: true },
    ];
    observed.powerPlatformResource = {
      ...observed.powerPlatformResource!,
      quarantineIdentity: null,
      nativeId: manifestId,
      details: { schemaName: manifestId },
      identifiers: [{ kind: "environment_id", value: environmentId }],
    };
    const { props } = renderDetail({ record: observed, activeTab: "controls" });
    expect(screen.getByText(/one valid native CDS bot identity/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
    for (const item of observed.packages) {
      await submitInlineAccess(item, "installation");
      expect(props.onUpdatePackageAccess).toHaveBeenLastCalledWith(item, { target: "installation", mode: "replace", scope: "none", principals: [] });
      await userEvent.click(screen.getByRole("button", { name: `${item.isBlocked ? "Unblock" : "Block"} ${item.displayName} (${item.id})` }));
      expect(props.onSetPackageBlocked).toHaveBeenLastCalledWith(item, !item.isBlocked);
    }
    expect(api.previewQuarantine).not.toHaveBeenCalled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it("offers quarantine for a resource-only agent without inventing package availability", async () => {
    renderDetail({ record: { ...observedRecord(), packages: [] }, activeTab: "controls" });
    expect(screen.getByText("No published version is available for availability or installation settings.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Manage access|Manage installation|^Block / })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    expect(screen.getByText("Saved inventory status").parentElement).toHaveTextContent("Unknown");
  });

  it("keeps viewers read-only even on a directly opened Manage route", async () => {
    renderDetail({ record: observedRecord(), activeTab: "controls", roles: ["AgentControl.Viewer"] });
    expect(screen.getByText(/AgentControl.Admin role is required/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Manage access|Manage installation|^Block |^Quarantine$|Restore from quarantine/ })).not.toBeInTheDocument();
    expect(api.previewQuarantine).not.toHaveBeenCalled();
  });

  it.each(["missing", "stale", "denied", "missing-metadata"] as const)("retains %s capability gates across the common Manage surface", async scenario => {
    const views = scenario === "missing" ? [] : capabilities();
    for (const view of views) {
      if (scenario === "stale") view.decision.fresh = false;
      if (scenario === "denied") view.decision.status = "missing_permission";
    }
    const { props } = renderDetail({ record: observedRecord(), activeTab: "controls" }, views, scenario === "missing-metadata" ? [] : workbenchActions);
    for (const name of [
      "Block Package one (package-1)", "Quarantine", "Restore from quarantine",
    ]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-describedby");
      await userEvent.click(button);
    }
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(props.onUpdatePackageAccess).not.toHaveBeenCalled();
    expect(props.onSetPackageBlocked).not.toHaveBeenCalled();
    expect(api.previewQuarantine).not.toHaveBeenCalled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it.each(["missing-snapshot", "stale-snapshot", "missing-bot", "invalid-environment", "duplicate-bot"] as const)(
    "explains an ineligible quarantine target (%s) without guessing a bot identity", async scenario => {
      const observed = observedRecord();
      const resource = observed.powerPlatformResource!;
      if (scenario === "missing-snapshot") observed.observations.powerPlatform = null;
      if (scenario === "stale-snapshot") observed.observations.powerPlatform!.expiresAt = "2020-01-01T00:00:00Z";
      if (scenario === "missing-bot") {
        resource.nativeId = botId;
        resource.identifiers = resource.identifiers.filter(item => item.kind !== "cds_bot_id");
      }
      if (scenario === "invalid-environment") resource.environmentId = "not-an-environment-id";
      if (scenario === "duplicate-bot") resource.identifiers.push({ kind: "cds_bot_id", value: "33333333-3333-4333-8333-333333333333" });
      if (scenario === "missing-bot" || scenario === "duplicate-bot") resource.quarantineIdentity = null;
      renderDetail({ record: observed, activeTab: "controls" });
      await userEvent.click(screen.getByText("Additional control availability"));
      expect(screen.getByText(/Quarantine is unavailable/)).toBeVisible();
      if (scenario === "missing-bot") expect(screen.getByText(/one valid native CDS bot identity/)).toBeVisible();
      expect(screen.queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Block Package one (package-1)" })).toBeEnabled();
      expect(api.previewQuarantine).not.toHaveBeenCalled();
    },
  );

  it("retains explicit frozen-target confirmation and capability rechecks for quarantine", async () => {
    const observed = observedRecord();
    const snapshot = observed.observations.powerPlatform!;
    const preview = quarantinePreview(observed);
    vi.mocked(api.previewQuarantine).mockResolvedValue(preview);
    vi.mocked(api.submitQuarantine).mockResolvedValue({
      id: "job-1", action: "quarantine", status: "succeeded", confirmationHash: preview.confirmationHash, confirmation: preview.summary,
      isCanary: false, total: 1, completed: 1, succeeded: 1, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
      canResume: false, canReconcile: false, createdAt: snapshot.observedAt, updatedAt: snapshot.observedAt, results: [],
    });
    const onQuarantineJobChange = vi.fn();
    const { props, update } = renderDetail({ record: observed, activeTab: "controls", onQuarantineJobChange });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    expect(api.previewQuarantine).toHaveBeenCalledExactlyOnceWith({
      action: "quarantine", snapshotId: snapshot.id, resourceNativeIds: [record.powerPlatformResource.nativeId],
    }, { signal: expect.any(AbortSignal) });
    const confirmation = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    expect(within(confirmation).getByText(`${environmentId} / ${botId}`)).toBeVisible();
    expect(within(confirmation).getByText("Not provider-atomic; each target is verified independently")).toBeVisible();
    expect(within(confirmation).getByRole("button", { name: "Confirm quarantine" })).toBeDisabled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
    await userEvent.click(within(confirmation).getByRole("checkbox"));
    const stale = capabilities().map(view => ({ ...view, decision: { ...view.decision, fresh: false } }));
    update({}, stale);
    expect(within(confirmation).getByRole("button", { name: "Confirm quarantine" })).toBeDisabled();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm quarantine" }));
    expect(api.submitQuarantine).not.toHaveBeenCalled();
    update({}, capabilities());
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm quarantine" }));
    expect(api.submitQuarantine).toHaveBeenCalledExactlyOnceWith({
      action: "quarantine", snapshotId: snapshot.id, resourceNativeIds: [record.powerPlatformResource.nativeId], confirmationHash: preview.confirmationHash,
    }, expect.stringMatching(/^[0-9a-f-]{36}$/), { signal: expect.any(AbortSignal) });
    expect(onQuarantineJobChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "job-1", status: "succeeded" }));
    expect(props.onSetPackageBlocked).not.toHaveBeenCalled();
    expect(props.onUpdatePackageAccess).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it.each(["native target", "bot identity", "agent", "principal", "tenant", "roles"] as const)(
    "does not carry a quarantine job and its recovery controls to a different %s", async boundary => {
    const observed = observedRecord();
    const preview = quarantinePreview(observed);
    const timestamp = observed.observations.powerPlatform!.observedAt;
    vi.mocked(api.previewQuarantine).mockResolvedValue(preview);
    vi.mocked(api.submitQuarantine).mockResolvedValue({
      id: "previous-target-job", action: "quarantine", status: "succeeded", confirmationHash: preview.confirmationHash, confirmation: preview.summary,
      isCanary: false, total: 1, completed: 1, succeeded: 1, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
      canResume: false, canReconcile: false, createdAt: timestamp, updatedAt: timestamp, results: [],
    });
    const { update } = renderDetail({ record: observed, activeTab: "controls" });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const confirmation = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(confirmation).getByRole("checkbox"));
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm quarantine" }));
    expect(await screen.findByText("Quarantine job: Succeeded")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh job status" })).toBeVisible();
    update({
      record: { ...observed,
        id: boundary === "agent" ? "different-logical-agent" : observed.id,
        powerPlatformResource: { ...observed.powerPlatformResource!,
          ...(boundary === "native target" ? { nativeId: "different-native-agent" } : {}),
          ...(boundary === "bot identity" ? { quarantineIdentity: {
            environmentId, botId: "33333333-3333-4333-8333-333333333333",
          } } : {}),
        },
      },
      roles: boundary === "roles" ? ["AgentControl.Viewer"] : user.roles,
    }, capabilities(), { ...user,
      ...(boundary === "principal" ? { homeAccountId: "other-account" } : {}),
      ...(boundary === "tenant" ? { tenantId: "other-tenant" } : {}),
    });
    expect(screen.queryByText("Quarantine job: Succeeded")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh job status" })).not.toBeInTheDocument();
    if (boundary !== "roles") expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    expect(api.submitQuarantine).toHaveBeenCalledOnce();
  });

  it("keeps an admitted quarantine job through tab changes and cancels its read on close", async () => {
    const observed = observedRecord();
    const preview = quarantinePreview(observed);
    const timestamp = observed.observations.powerPlatform!.observedAt;
    const job: api.QuarantineJob = {
      id: "retained-job", action: "quarantine", status: "waiting_authorization", confirmationHash: preview.confirmationHash,
      confirmation: preview.summary, isCanary: false, total: 1, completed: 0, succeeded: 0, failed: 0,
      skipped: 0, inconclusive: 0, cancelled: 0, canResume: true, canReconcile: false,
      createdAt: timestamp, updatedAt: timestamp, results: [],
    };
    const submitted = deferred<api.QuarantineJob>();
    const refreshed = deferred<api.QuarantineJob>();
    vi.mocked(api.previewQuarantine).mockResolvedValue(preview);
    vi.mocked(api.submitQuarantine).mockReturnValue(submitted.promise);
    const readJob = vi.spyOn(api, "getQuarantineJob").mockReturnValue(refreshed.promise);
    const onQuarantineJobChange = vi.fn();
    const { update, unmount } = renderDetail({ record: observed, activeTab: "controls", onQuarantineJobChange });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const confirmation = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(confirmation).getByRole("checkbox"));
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm quarantine" }));
    const submitSignal = vi.mocked(api.submitQuarantine).mock.calls[0][2]?.signal;
    update({ activeTab: "identities" });
    expect(submitSignal?.aborted).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Quarantine 1 agent" })).not.toBeInTheDocument();
    await act(async () => submitted.resolve(job));
    expect(onQuarantineJobChange).toHaveBeenCalledExactlyOnceWith(job);
    update({ activeTab: "controls" });
    expect(screen.getByText("Quarantine job: Waiting Authorization")).toBeVisible();
    expect(api.submitQuarantine).toHaveBeenCalledOnce();
    expect(readJob).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh job status" }));
    const signal = readJob.mock.calls[0][1]?.signal;
    update({ activeTab: "identities" });
    expect(signal?.aborted).toBe(false);
    update({ activeTab: "controls" });
    expect(readJob).toHaveBeenCalledOnce();
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => refreshed.resolve({ ...job, status: "succeeded", completed: 1, succeeded: 1 }));
    expect(onQuarantineJobChange).toHaveBeenCalledOnce();
  });

  it("does not retire a detail quarantine receipt for equivalent native GUID casing", async () => {
    const observed = observedRecord();
    const nativeId = "abcdefab-2222-4222-8222-222222222222";
    observed.powerPlatformResource = { ...observed.powerPlatformResource!, nativeId };
    const preview = quarantinePreview(observed);
    const timestamp = observed.observations.powerPlatform!.observedAt;
    const job: api.QuarantineJob = {
      id: "retained-job", action: "quarantine", status: "succeeded", confirmationHash: preview.confirmationHash,
      confirmation: preview.summary, isCanary: false, total: 1, completed: 1, succeeded: 1, failed: 0,
      skipped: 0, inconclusive: 0, cancelled: 0, canResume: false, canReconcile: false,
      createdAt: timestamp, updatedAt: timestamp, results: [],
    };
    const submitted = deferred<api.QuarantineJob>();
    vi.mocked(api.previewQuarantine).mockResolvedValue(preview);
    vi.mocked(api.submitQuarantine).mockReturnValue(submitted.promise);
    const { update } = renderDetail({ record: observed, activeTab: "controls" });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const confirmation = screen.getByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(confirmation).getByRole("checkbox"));
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm quarantine" }));
    const signal = vi.mocked(api.submitQuarantine).mock.calls[0][2]?.signal;
    update({ record: { ...observed, powerPlatformResource: { ...observed.powerPlatformResource!, nativeId: nativeId.toUpperCase() } } });
    expect(signal?.aborted).toBe(false);
    expect(screen.getByRole("dialog", { name: "Quarantine 1 agent" })).toBe(confirmation);
    await act(async () => submitted.resolve(job));
    expect(screen.getByText("Quarantine job: Succeeded")).toBeVisible();
    expect(api.submitQuarantine).toHaveBeenCalledOnce();
  });

  it("cancels unsent quarantine preparation when Manage is left without showing its late confirmation", async () => {
    const observed = observedRecord();
    const preview = deferred<api.QuarantinePreview>();
    vi.mocked(api.previewQuarantine).mockReturnValue(preview.promise);
    const { update } = renderDetail({ record: observed, activeTab: "controls" });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const signal = vi.mocked(api.previewQuarantine).mock.calls[0][1]?.signal;
    update({ activeTab: "identities" });
    expect(signal?.aborted).toBe(true);
    await act(async () => preview.resolve(quarantinePreview(observed)));
    expect(screen.queryByRole("dialog", { name: "Quarantine 1 agent" })).not.toBeInTheDocument();
    update({ activeTab: "controls" });
    expect(screen.queryByRole("dialog", { name: "Quarantine 1 agent" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    expect(api.previewQuarantine).toHaveBeenCalledOnce();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it.each(["replacement", "expired"] as const)("retains submitted native work across %s inventory evidence", async boundary => {
    const observed = observedRecord();
    const preview = quarantinePreview(observed);
    const timestamp = observed.observations.powerPlatform!.observedAt;
    const job: api.QuarantineJob = {
      id: "retained-job", action: "quarantine", status: "waiting_authorization", confirmationHash: preview.confirmationHash,
      confirmation: preview.summary, isCanary: false, total: 1, completed: 0, succeeded: 0, failed: 0,
      skipped: 0, inconclusive: 0, cancelled: 0, canResume: true, canReconcile: false,
      createdAt: timestamp, updatedAt: timestamp, results: [],
    };
    const submitted = deferred<api.QuarantineJob>();
    vi.mocked(api.previewQuarantine).mockResolvedValue(preview);
    vi.mocked(api.submitQuarantine).mockReturnValue(submitted.promise);
    const onQuarantineJobChange = vi.fn();
    const { update } = renderDetail({ record: observed, activeTab: "controls", onQuarantineJobChange });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const confirmation = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(confirmation).getByRole("checkbox"));
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm quarantine" }));
    const signal = vi.mocked(api.submitQuarantine).mock.calls[0][2]?.signal;
    update({ record: { ...observed, observations: { ...observed.observations, powerPlatform: {
      ...observed.observations.powerPlatform!, id: "replacement-snapshot", snapshotId: "replacement-snapshot",
      ...(boundary === "expired" ? { expiresAt: "2020-01-01T00:00:00Z" } : {}),
    } } } });
    expect(signal?.aborted).toBe(false);
    expect(screen.getByRole("dialog", { name: "Quarantine 1 agent" })).toBe(confirmation);
    await act(async () => submitted.resolve(job));
    expect(onQuarantineJobChange).toHaveBeenCalledExactlyOnceWith(job);
    expect(screen.getByText("Quarantine job: Waiting Authorization")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh job status" })).toBeEnabled();
    if (boundary === "expired") expect(screen.getByRole("button", { name: "Quarantine" })).toBeDisabled();
    expect(api.submitQuarantine).toHaveBeenCalledOnce();
  });

  it("recovers a lost submitted receipt after leaving Manage and replacing its expired snapshot", async () => {
    const observed = observedRecord();
    const preview = quarantinePreview(observed);
    const timestamp = observed.observations.powerPlatform!.observedAt;
    const job: api.QuarantineJob = {
      id: "recovered-job", action: "quarantine", status: "succeeded", confirmationHash: preview.confirmationHash,
      confirmation: preview.summary, isCanary: false, total: 1, completed: 1, succeeded: 1, failed: 0,
      skipped: 0, inconclusive: 0, cancelled: 0, canResume: false, canReconcile: false,
      createdAt: timestamp, updatedAt: timestamp, results: [],
    };
    const submitted = deferred<api.QuarantineJob>();
    vi.mocked(api.previewQuarantine).mockResolvedValue(preview);
    vi.mocked(api.submitQuarantine).mockReturnValueOnce(submitted.promise).mockResolvedValueOnce(job);
    const { update } = renderDetail({ record: observed, activeTab: "controls" });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const confirmation = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(confirmation).getByRole("checkbox"));
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm quarantine" }));
    const replacement = { ...observed, observations: { ...observed.observations, powerPlatform: {
      ...observed.observations.powerPlatform!, id: "expired-replacement", snapshotId: "expired-replacement",
      expiresAt: "2020-01-01T00:00:00Z",
    } } };
    update({ activeTab: "identities", record: replacement });
    await act(async () => submitted.reject(new Error("Submitted result unavailable.")));
    expect(screen.queryByRole("dialog", { name: "Quarantine 1 agent" })).not.toBeInTheDocument();
    update({ activeTab: "controls", record: replacement });
    const retry = screen.getByRole("dialog", { name: "Quarantine 1 agent" });
    expect(within(retry).getByRole("alert")).toHaveTextContent("Submitted result unavailable.");
    expect(within(retry).getByRole("checkbox")).not.toBeChecked();
    await userEvent.click(within(retry).getByRole("checkbox"));
    await userEvent.click(within(retry).getByRole("button", { name: "Confirm quarantine" }));
    expect(api.submitQuarantine).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(api.submitQuarantine).mock.calls;
    expect(second.slice(0, 2)).toEqual(first.slice(0, 2));
    expect(api.previewQuarantine).toHaveBeenCalledOnce();
    expect(screen.getByText("Quarantine job: Succeeded")).toBeVisible();
  });

  it.each(["close button", "cancel button", "Escape"] as const)("dismisses only the quarantine confirmation using its %s", async action => {
    const observed = observedRecord();
    const ancestorClose = vi.fn();
    const ancestorCancel = vi.fn();
    const ancestorKeyDown = vi.fn();
    vi.mocked(api.previewQuarantine).mockResolvedValue(quarantinePreview(observed));
    const { props } = renderDetail({ record: observed, activeTab: "controls" }, capabilities(), workbenchActions, {
      wrapper: ({ children }) => <dialog open aria-label="Ancestor dialog" onClose={ancestorClose} onCancel={ancestorCancel} onKeyDown={ancestorKeyDown}>{children}</dialog>,
    });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const confirmation = await screen.findByRole<HTMLDialogElement>("dialog", { name: "Quarantine 1 agent" });
    if (action === "Escape") {
      fireEvent.keyDown(confirmation, { key: "Escape" });
      expect(ancestorKeyDown).not.toHaveBeenCalled();
      const cancel = new Event("cancel", { cancelable: true });
      fireEvent(confirmation, cancel);
      expect(cancel.defaultPrevented).toBe(false);
      expect(ancestorCancel).not.toHaveBeenCalled();
      act(() => confirmation.close());
    } else {
      await userEvent.click(within(confirmation).getByRole("button", {
        name: action === "close button" ? "Close quarantine confirmation" : "Cancel",
      }));
    }
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: record.displayName })).toHaveAttribute("open");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(ancestorClose).not.toHaveBeenCalled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it("keeps quarantine keyboard focus inside confirmation without invoking ancestor focus traps", async () => {
    const observed = observedRecord();
    const ancestorKeyDown = vi.fn();
    vi.mocked(api.previewQuarantine).mockResolvedValue(quarantinePreview(observed));
    renderDetail({ record: observed, activeTab: "controls" }, capabilities(), workbenchActions, {
      wrapper: ({ children }) => <div onKeyDown={ancestorKeyDown}>{children}</div>,
    });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const confirmation = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(confirmation).getByRole("checkbox"));
    const first = within(confirmation).getByRole("button", { name: "Close quarantine confirmation" });
    const last = within(confirmation).getByRole("button", { name: "Confirm quarantine" });
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    expect(ancestorKeyDown).not.toHaveBeenCalled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it("keeps quarantine confirmation open through Strict Mode replay with queued native close events", async () => {
    const observed = observedRecord();
    vi.mocked(api.previewQuarantine).mockResolvedValue(quarantinePreview(observed));
    const { props } = renderDetail({ record: observed, activeTab: "controls" }, capabilities(), workbenchActions, { reactStrictMode: true });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(screen.getByRole("dialog", { name: "Quarantine 1 agent" })).toHaveAttribute("open");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it("cancels an inline package confirmation before closing the agent on Escape", async () => {
    const cancelConfirmation = vi.fn();
    const { props, update } = renderDetail({ packageConfirmation: <p>Exact package confirmation</p>, onCancelPackageConfirmation: cancelConfirmation });
    const dialog = screen.getByRole("dialog", { name: record.displayName });
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(cancelConfirmation).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
    update({ packageConfirmation: undefined });
    const nextCancel = new Event("cancel", { cancelable: true });
    fireEvent(dialog, nextCancel);
    expect(nextCancel.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close unified agent details" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
  });
});
