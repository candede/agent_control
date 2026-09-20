import { act, fireEvent, render, screen, waitFor, within, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import * as api from "../api/client";
import type { CapabilityView, CopilotPackage, CopilotPackageDetail, InventorySourceAwareDetail, PackageAccessTarget, QuarantinePreview, SessionUser, UnifiedAgentRecord } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { mockNativeDialogs } from "../test/dialog";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { UnifiedAgentDetailModal } from "./UnifiedAgentDetailModal";
import { createInventoryVerification } from "../test/inventoryVerification";
import { usageAggregateFixture, usageAgentDetailFixture } from "../test/usageInsightsFixture";
import { automaticAgentUsageFixture, automaticUsageContext, automaticUsagePackageId, automaticUsageReportName } from "../test/automaticAgentUsageFixture";

mockNativeDialogs();

const record = {
  id: "unified-1",
  displayName: "Unified builder",
  presence: "both",
  environmentId: "environment-1",
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

afterEach(() => vi.restoreAllMocks());

const environmentId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";
const user: SessionUser = {
  homeAccountId: "admin-1", displayName: "Admin", username: "admin@example.invalid", roles: ["AgentControl.Admin"],
};

function observedRecord(): UnifiedAgentRecord {
  return {
    ...record, environmentId,
    powerPlatformResource: {
      ...record.powerPlatformResource, environmentId,
      identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: botId }],
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
    expect(screen.getByText("Authoring tool").nextElementSibling).toHaveTextContent("Microsoft 365 Copilot Agent Builder");
    expect(screen.getByText("Authoring tool (raw)").nextElementSibling).toHaveTextContent("Copilot Studio Lite");
    expect(screen.getByText(/This does not establish whether the agent was deleted/)).toBeVisible();
  });

  it("uses saved names and sign-in addresses without requiring live directory permission or lookup", () => {
    const lookup = vi.spyOn(api, "resolveAgentPeople");
    const value = { ...nativeRecord(), people: { owner: savedPerson, createdBy: savedPerson } };
    renderDetail({ record: value, roles: ["AgentControl.Viewer"] });
    expect(field("Owner")).toHaveTextContent("Saved owner");
    expect(field("Owner")).toHaveTextContent("saved.owner@example.invalid");
    expect(field("Created by")).toHaveTextContent("Saved owner");
    expect(field("Created by")).toHaveTextContent(`ID: ${ownerId}`);
    expect(field("Owner")).toHaveTextContent("Saved directory:");
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
    await waitFor(() => expect(field("Owner")).toHaveTextContent("Directory person"));
    expect(field("Created by")).toHaveTextContent("person@example.invalid");
    expect(field("Last modified by")).toHaveTextContent("Last editor");
    expect(lookup).toHaveBeenCalledExactlyOnceWith(value.id, { signal: expect.any(AbortSignal) });
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
    expect(await screen.findByRole("alert")).toHaveTextContent("Directory temporarily unavailable.");
    expect(field("Owner")).toHaveTextContent("Saved owner");
    expect(field("Created by")).toHaveTextContent(creatorId);
    expect(lookup.mock.calls[0][0]).toBe(value.id);
    await userEvent.click(screen.getByRole("button", { name: "Retry person lookup" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Retry person lookup" }));
    await waitFor(() => expect(screen.queryByText("Resolving agent people...")).not.toBeInTheDocument());
    expect(lookup).toHaveBeenCalledExactlyOnceWith(value.id, { force: true, signal: expect.any(AbortSignal) });
    rendered.update({ record: structuredClone(value), onPeopleChanged: vi.fn() });
    rendered.update({}, capabilities());
    expect(screen.getByText(/Directory lookup is unavailable/)).toBeVisible();
    rendered.update({}, capabilitiesWithDirectory());
    expect(lookup).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });

  it("refreshes expired evidence once, retains last known names after a saved failure and a failed retry", async () => {
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
    await waitFor(() => expect(field("Owner")).toHaveTextContent("Directory lookup failed. Last known identity shown."));
    expect(lookup).toHaveBeenCalledExactlyOnceWith(value.id, { signal: expect.any(AbortSignal) });
    rendered.update({ record: structuredClone(value) });
    expect(lookup).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Retry person lookup" }));
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
    expect(screen.queryByRole("button", { name: "Retry person lookup" })).not.toBeInTheDocument();
  });

  it("keeps the original name observation separate from a later failed lookup attempt", () => {
    const value = nativeRecord();
    const person = {
      ...savedPerson, status: "lookup_failed" as const, checkedAt: "2026-09-19T12:00:00Z",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    value.people = { owner: person, createdBy: person };
    const lookup = vi.spyOn(api, "resolveAgentPeople");
    renderDetail({ record: value });
    expect(field("Owner")).toHaveTextContent("Saved owner");
    expect(field("Owner")).toHaveTextContent("Saved directory: Sep 17, 2026");
    expect(field("Owner")).toHaveTextContent("Last lookup attempt: Sep 19, 2026");
    expect(field("Owner")).toHaveTextContent("Directory lookup failed. Last known identity shown.");
    expect(field("Owner")).not.toHaveTextContent("deleted");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refreshes newly expired persisted evidence without forcing and does not reuse the old record's expiry", async () => {
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
    await waitFor(() => expect(field("Created by")).toHaveTextContent("Directory person"));
    vi.spyOn(Date, "now").mockReturnValue(now + 2_000);
    rendered.update({}, capabilitiesWithDirectory());
    expect(lookup).toHaveBeenCalledOnce();
    expect(field("Owner")).not.toHaveTextContent("expired");
    vi.mocked(Date.now).mockReturnValue(now + 11_000);
    rendered.update({}, capabilitiesWithDirectory());
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    expect(lookup).toHaveBeenLastCalledWith(value.id, { signal: expect.any(AbortSignal) });
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
    expect(field("Owner")).toHaveTextContent("not a resolvable Entra user ID");
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
    await waitFor(() => expect(field("Owner")).toHaveTextContent("Directory person"));
    rendered.update({}, capabilities());
    expect(field("Owner")).toHaveTextContent("Directory person");
    expect(field("Owner")).toHaveTextContent(ownerId.toUpperCase());
    expect(lookup).toHaveBeenCalledTimes(1);
    rendered.update({ roles: [] }, capabilitiesWithDirectory());
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(field("Owner")).not.toHaveTextContent("Directory person");
  });

  it("rejects mismatched saved and live identities rather than attaching another user's name", async () => {
    const value = nativeRecord();
    value.people = { owner: { ...savedPerson, objectId: creatorId, displayName: "Wrong saved person" } };
    vi.spyOn(api, "resolveAgentPeople").mockResolvedValue({
      people: { owner: resolved(creatorId, "Wrong live person") }, changed: true,
    });
    renderDetail({ record: value }, capabilitiesWithDirectory());
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
    const second = nativeRecord();
    second.powerPlatformResource!.createdBy = creatorId;
    second.powerPlatformResource!.details.ownerId = creatorId;
    rendered.update({ record: second });
    await waitFor(() => expect(field("Owner")).toHaveTextContent("Person B"));
    rendered.update({ record: original });
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
    rendered.update({}, capabilitiesWithDirectory(), { ...user, homeAccountId: "second-account" });
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

function sourceAwareDetail(observed = observedRecord()): InventorySourceAwareDetail {
  const resource = observed.powerPlatformResource!;
  const snapshot = observed.observations.powerPlatform!;
  return {
    source: "power_platform", nativeId: resource.nativeId,
    resourceType: resource.type, environmentId: resource.environmentId, snapshotId: snapshot.id,
    observedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt, identifiers: [],
    package: { status: "unmatched", reason: "No package association queried." },
    reports: { status: "unavailable", reason: "Usage reports are unavailable." },
    audit: { status: "available", count: 0, value: [] },
    security: { status: "available", count: 0, value: [] },
    controls: { quarantineTarget: { environmentId, botId }, packageTarget: null },
  };
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

function queueNativeCloseEvents() {
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  });
}

beforeEach(() => {
  vi.spyOn(api, "getInventorySourceAwareDetail").mockResolvedValue(sourceAwareDetail());
  vi.spyOn(api, "getOfficialUsageAggregate").mockResolvedValue(usageAggregateFixture());
  vi.spyOn(api, "getOfficialUsageAgentDetail").mockResolvedValue(usageAgentDetailFixture());
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
    expect(api.getOfficialUsageAggregate).not.toHaveBeenCalled();
    expect(api.getOfficialUsageAgentDetail).not.toHaveBeenCalled();
    expect(within(dialog).queryByLabelText("Tenant report totals")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Tenant adoption snapshot")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Find a reported agent")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Concealed report user")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Search tenant interactions")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Open tenant security")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("View management audit")).not.toBeInTheDocument();
  });

  it.each(["synchronous", "queued"] as const)("keeps details open through Strict Mode replay with %s close events", async timing => {
    if (timing === "queued") queueNativeCloseEvents();
    const { props } = renderDetail({}, capabilities(), workbenchActions, { reactStrictMode: true });
    await act(async () => { await Promise.resolve(); });
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
  ] as const)("distinguishes a %s click from the dialog content", (_area, clientX, clientY, shouldClose) => {
    const { props } = renderDetail();
    const dialog = screen.getByRole("dialog", { name: record.displayName });
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 80, 600, 500));
    fireEvent.mouseDown(dialog, { clientX, clientY });
    expect(props.onClose).toHaveBeenCalledTimes(shouldClose ? 1 : 0);
  });

  it("defaults to Overview with admin facts and collapsed technical evidence", async () => {
    const { props } = renderDetail({ roles: ["AgentControl.Viewer"], environmentNames: { "environment-1": "Production" } });

    const dialog = screen.getByRole("dialog", { name: "Unified builder" });
    const tablist = within(dialog).getByRole("tablist", { name: "Agent details" });
    expect(within(tablist).getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Overview", "Usage & users", "Manage", "Activity"]);
    expect(within(dialog).getByRole("tabpanel", { name: "Overview" })).toBeVisible();
    expect(within(dialog).getByText("Production")).toBeVisible();
    expect(within(dialog).getAllByText("Agent Builder").some(element => element.closest("details") === null)).toBe(true);
    expect(within(dialog).getByText("Quarantine status unknown")).toBeVisible();
    expect(within(dialog).getByText("Linked by source metadata")).not.toBeVisible();
    expect(within(dialog).getByText(/not presented as a publicly documented Microsoft canonical identifier equivalence/)).not.toBeVisible();
    const technical = within(dialog).getByText("Technical details").closest("details");
    expect(technical).not.toHaveAttribute("open");
    await userEvent.click(within(dialog).getByText("Technical details"));
    expect(technical).toHaveAttribute("open");
    expect(within(dialog).getByText("Linked by source metadata")).toBeVisible();
    expect(technical).toHaveTextContent("package-1");
    expect(technical).toHaveTextContent("element-1");
    expect(technical).toHaveTextContent("elementDetails.AgentMetadatas.definition.AgentIdentityId");
    expect(within(dialog).getByText("agent-identity-1")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Manage" }));
    expect(props.onTabChange).toHaveBeenLastCalledWith("controls");
    expect(within(dialog).getByText("Package one")).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Manage" })).toBeVisible();
    expect(within(dialog).getByText(/Apply checks current settings before exact-target confirmation/)).toBeVisible();
    expect(within(dialog).getByText(/AgentControl.Admin role is required/)).toBeVisible();
  });

  it.each([
    ["identities", "identities", "Overview"], ["package", "identities", "Overview"], ["power-platform", "identities", "Overview"],
    ["reports", "reports", "Usage & users"], ["audit-security", "audit-security", "Activity"], ["controls", "controls", "Manage"],
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
    expect(screen.getByRole("heading", { name: "Agent information" })).toBeVisible();
    expect(screen.getByText("full vendor description").tagName).toBe("STRONG");
    expect(screen.getByText("full vendor description")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Connected services" })).toBeVisible();
    expect(screen.getByText("Finance connector")).toBeVisible();
    for (const value of ["Example vendor", "Team owner", "Tenant maker", "Tenant model", "Organization sign-in", "Configured connector"]) {
      expect(screen.getByText(value)).toBeVisible();
    }
    expect(screen.getByText("Technical details").closest("details")).not.toHaveAttribute("open");
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

  it.each(["missing action", "missing role"] as const)("does not automatically inspect packages with %s", scenario => {
    const { props } = renderDetail({ roles: scenario === "missing role" ? [] : user.roles }, undefined,
      scenario === "missing action" ? [] : undefined);
    expect(props.onInspectPackage).not.toHaveBeenCalled();
    expect(screen.getByText(/Additional saved details require the package read action/)).toBeVisible();
  });

  it("shows the full service-reference count and pages only the list", async () => {
    renderDetail({ packageDetail: {
      ...record.packages[0],
      elementDetails: [{
        elementType: "AgentMetadatas",
        elements: [{ id: "metadata", definition: JSON.stringify({ connections: Array.from({ length: 35 }, (_, index) => ({ connectorId: `Service ${index}` })) }) }],
      }],
    } });
    expect(screen.getByText("35 references", { exact: true })).toBeVisible();
    const list = screen.getByRole("list", { name: "Detected service references" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    await userEvent.click(screen.getByRole("button", { name: "Next references" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(15);
    expect(within(list).getByText("Service 34")).toBeVisible();
    expect(screen.getByText("35 references", { exact: true })).toBeVisible();
  });

  it("preserves useful native metadata for a sparse agent without inventing a vendor description or connections", () => {
    renderDetail({ record: {
      ...record, packages: [], presence: "power_platform",
      powerPlatformResource: { ...record.powerPlatformResource, details: { ownerId: "Tenant owner", isWebSearchEnabledForKnowledge: false } },
    } });
    expect(screen.getByText("No description provided.")).toBeVisible();
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

  it("keeps reported connector totals separate from retained details and detected references", () => {
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
    expect(screen.getByText("5 configured / 2 references")).toBeVisible();
    expect(screen.getByText("retained-connector")).toBeVisible();
    const information = screen.getByRole("region", { name: "Agent information" });
    expect(within(information).getByText("Configured connector operations").nextElementSibling).toHaveTextContent("9");
    expect(within(information).getByText("Channels").nextElementSibling).toHaveTextContent("Teams, Custom Channel");
    expect(within(information).getByText("Last quarantined").nextElementSibling?.querySelector("time")).toHaveAttribute("dateTime", "2026-09-18T12:00:00Z");
    expect(screen.getByText(/Capability details are partial/)).not.toHaveTextContent("reached its projection limit");
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
    expect(screen.getByText(`${count} configured`)).toBeVisible();
    expect(screen.getByText("Configured connector operations").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Channels").nextElementSibling).toHaveTextContent("None reported");
    expect(screen.queryByText("No connected-service metadata was reported for this agent.")).not.toBeInTheDocument();
    expect(screen.getByText(count ? /Configured connector details are not available/ : "No configured connectors were reported.")).toBeVisible();
  });

  it("does not present a partial retained connector list as the complete configured count", () => {
    renderDetail({ record: {
      ...record, packages: [], powerPlatformResource: {
        ...record.powerPlatformResource, details: { connectors: [{ connectorId: "retained" }], connectorDetailsStatus: "partial" },
      },
    } });
    expect(screen.getByText("1 listed (partial)")).toBeVisible();
    expect(screen.queryByText("1 configured")).not.toBeInTheDocument();
  });

  it("includes exact package observations when showing the latest saved inventory time", () => {
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
    expect(screen.getByText("Inventory observed").nextElementSibling?.querySelector("time")).toHaveAttribute("dateTime", observedAt);
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
    expect(resolve).toHaveBeenCalledExactlyOnceWith(detail.acquireUsersAndGroups);
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
    expect(resolve).toHaveBeenCalledExactlyOnceWith(detail.acquireUsersAndGroups);
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
    expect(resolve).toHaveBeenCalledExactlyOnceWith(detail.acquireUsersAndGroups);
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
    expect(resolve).toHaveBeenCalledExactlyOnceWith(detail.acquireUsersAndGroups);
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

  it("keeps preview errors and retry in the inline editor without creating another dialog", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("Current access could not be verified")).mockResolvedValue(undefined);
    renderDetail({ activeTab: "controls", onUpdatePackageAccess: submit });
    await userEvent.click(screen.getByRole("radio", { name: /No users/ }));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Current access could not be verified");
    expect(screen.getByRole("radio", { name: /No users/ })).toBeChecked();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
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
    const usage = await screen.findByRole("region", { name: "Usage and users for Researcher" });
    expect(within(usage).getByRole("heading", { name: "No matched usage data for this agent" })).toBeVisible();
    expect(within(usage).getByText(/Its response totals, active users, and last-used date are unavailable/)).toHaveTextContent("Researcher");
    expect(within(usage).getByText(/Missing usage data does not mean zero usage/)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Users of the reported agent" })).not.toBeInTheDocument();
    expect(api.getOfficialUsageAggregate).not.toHaveBeenCalled();
    expect(api.getOfficialUsageAgentDetail).not.toHaveBeenCalled();
    if (presence === "graph_packages") expect(api.getInventorySourceAwareDetail).not.toHaveBeenCalled();
    expect(within(usage).queryByRole("button")).not.toBeInTheDocument();
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
    expect(await screen.findByRole("region", { name: "Usage and users for Researcher" })).toBeVisible();
    update({ record: { ...first, id: "different-agent" } });
    expect(screen.getByRole("heading", { name: "No matched usage data for this agent" })).toBeVisible();
    update({ record: { ...first, id: "different-agent", displayName: "Different agent" } });
    expect(screen.getByRole("region", { name: "Usage and users for Different agent" })).toBeVisible();
    expect(screen.queryByText("Researcher")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Tenant report totals")).not.toBeInTheDocument();
    expect(api.getOfficialUsageAggregate).not.toHaveBeenCalled();
    expect(api.getOfficialUsageAgentDetail).not.toHaveBeenCalled();
  });

  it("shows automatically matched report identities in the modal without setup, candidates or writes", () => {
    const candidates = vi.spyOn(api, "getAgentUsageCandidates");
    const associate = vi.spyOn(api, "associateAgentUsage");
    const remove = vi.spyOn(api, "removeAgentUsageAssociation");
    const { update } = renderDetail({
      activeTab: "reports", usageContext: automaticUsageContext, inventoryRevision: "a".repeat(64), onUsageChanged: vi.fn(),
      record: {
        ...record, displayName: "Excel", packages: [{ ...record.packages[0], id: automaticUsagePackageId, displayName: "Excel" }],
        usage: automaticAgentUsageFixture(),
      },
    });
    const usage = screen.getByRole("region", { name: "Usage and users for Excel" });
    expect(within(usage).getByLabelText("Selected agent report metrics")).toHaveTextContent("181");
    expect(within(usage).getByText(automaticUsageReportName)).toBeVisible();
    expect(within(usage).getByText(/Automatically matched: exact report Agent ID/)).toBeVisible();
    expect(within(usage).queryByRole("button")).not.toBeInTheDocument();
    expect(candidates).not.toHaveBeenCalled();
    expect(associate).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(api.getOfficialUsageAgentDetail).not.toHaveBeenCalled();
    update({ usageContext: { ...automaticUsageContext, reportSet: { ...automaticUsageContext.reportSet!, id: "other-snapshot" } } });
    expect(screen.queryByLabelText("Selected agent report metrics")).not.toBeInTheDocument();
    expect(screen.getByText(/saved usage belongs to a different report snapshot/)).toBeVisible();
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

  it("renders corroborated schema/native evidence in collapsed diagnostics without claiming a Microsoft canonical identity", async () => {
    const corroborated = corroboratedRecord(true);
    renderDetail({ record: corroborated, activeTab: "identities" });
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
    const technical = screen.getByText("Technical details").closest("details");
    expect(technical).not.toHaveAttribute("open");
    expect(screen.getAllByText("Environment schema native id")).toHaveLength(2);
    for (const evidence of screen.getAllByText("Environment schema native id")) expect(evidence).not.toBeVisible();
    const qualification = screen.getByText(/not presented as a publicly documented Microsoft canonical identifier equivalence/);
    expect(qualification).not.toBeVisible();
    expect(qualification).toHaveTextContent(corroborated.identity.reason!);
    await userEvent.click(screen.getByText("Technical details"));
    expect(qualification).toBeVisible();
    expect(technical).toHaveTextContent("metadata-1");
    expect(technical).toHaveTextContent(corroborated.identity.evidence[0].packagePath);
    expect(technical).toHaveTextContent(corroborated.identity.evidence[0].resourcePath);
  });

  it("retains source-specific identity warnings without turning a valid native link into a conflict", async () => {
    const observed = observedRecord();
    const message = "Graph and Power Platform supplied different source-specific agent identity IDs; the exact native environment and bot agree.";
    const { update } = renderDetail({
      record: { ...observed, identity: { ...observed.identity, warnings: [{ code: "source_specific_agent_identity", message }] } },
    });
    await userEvent.click(screen.getByText("Technical details"));
    expect(screen.getByRole("heading", { name: "Source identity warnings" })).toBeVisible();
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Linked by source metadata" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Conflicting link evidence" })).not.toBeInTheDocument();
    update({ record: observed });
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it.each(["matched", "unmatched"] as const)("shows actionable invalid metadata without disabling exact package controls for a %s record", async state => {
    const observed = observedRecord();
    const { update } = renderDetail({
      record: { ...observed, identity: { ...observed.identity, state, invalidMetadata: true } },
      activeTab: "controls",
    });
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
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
    await userEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText(reason)).toBeVisible();
    expect(screen.queryByText("Refresh matching details")).not.toBeInTheDocument();
  });

  it.each([false, true])("requires an explicit backend-supplied CDS bot identifier despite corroborated evidence (supplied=%s)", async supplied => {
    renderDetail({ record: corroboratedRecord(supplied), activeTab: "controls" });
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
    if (supplied) expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    else {
      expect(screen.queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
      expect(screen.getByText(/one valid native CDS bot identity/)).toBeInTheDocument();
    }
    expect(api.previewQuarantine).not.toHaveBeenCalled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it("shows related opaque package proof in both shared custom-engine evidence sections", async () => {
    const grouped = sharedCustomEngineRecord();
    const { update } = renderDetail({ record: grouped });
    await userEvent.click(screen.getByText("Technical details"));
    const proofs = screen.getAllByRole("list", { name: "Related exact packages" });
    expect(proofs).toHaveLength(2);
    for (const proof of proofs) {
      expect(within(proof).getAllByRole("listitem").map(item => item.textContent)).toEqual([grouped.packages[1].id]);
    }
    expect(screen.getAllByText("Shared custom engine bot id")).toHaveLength(2);
    expect(screen.getByText(/not presented as a publicly documented Microsoft canonical identifier equivalence/)).toBeVisible();
    expect(screen.getByText(/not a Microsoft-guaranteed native foreign key/)).toBeVisible();
    expect(screen.getByText(/does not grant or renew native controls/)).toBeVisible();
    update({ record: observedRecord() });
    expect(screen.queryByRole("list", { name: "Related exact packages" })).not.toBeInTheDocument();
  });

  it("keeps definition-backed identity evidence when every outer element label is empty", async () => {
    const grouped = sharedCustomEngineRecord();
    for (const evidence of grouped.identity.evidence) evidence.elementIds = ["", ""];
    renderDetail({ record: grouped });
    await userEvent.click(screen.getByText("Technical details"));
    expect(screen.getByRole("heading", { name: "Linked by source metadata" })).toBeVisible();
    expect(screen.getAllByText(/element labels Not supplied/)).toHaveLength(4);
    expect(screen.getAllByText("Bots.definition.botId + CustomEngineCopilots.definition.id")).toHaveLength(2);
    expect(screen.getAllByRole("list", { name: "Related exact packages" })).toHaveLength(2);
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
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
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
      }));
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
  ] as const)("renders %s as source-declared evidence without deriving a CDS quarantine target", async (kind, heading, packagePath, resourcePath) => {
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
          identifiers: [{ kind: "environment_id", value: environmentId }],
        },
        identity: { state: "matched", evidence, packageEvidence: [{ packageId: "package-1", evidence }], reason: null },
      },
    });
    await userEvent.click(screen.getByText("Technical details"));
    for (const label of screen.getAllByText(heading)) expect(label).toBeVisible();
    expect(screen.getAllByText(/Source declared metadata/)).toHaveLength(2);
    expect(screen.getByText(/not presented as a publicly documented Microsoft canonical identifier equivalence/)).toBeVisible();
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
        connectors: [{ connectorId: "native-connector", operations: [{ operationId: "operation-1", displayName: "Read records", method: "GET" }] }],
        capabilityDetailsTruncated: true,
      },
    };
    render(<WorkbenchActionProvider value={[]}>
      <UnifiedAgentDetailModal
        record={{ ...record, powerPlatformResource: resource }}
        activeTab="power-platform" roles={["AgentControl.Viewer"]}
        onTabChange={vi.fn()} onClose={vi.fn()} onInspectPackage={vi.fn()}
        onUpdatePackageAccess={vi.fn().mockResolvedValue(undefined)} onSetPackageBlocked={vi.fn()}
      />
    </WorkbenchActionProvider>);
    for (const value of ["native-owner", "native-schema", "configured-model", "configured-authentication", "configured-orchestration", "native-connector", "Read records"]) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
    expect(screen.getByText("Authoring tool (raw)").nextElementSibling).toHaveTextContent("FutureProvider.vNext_build-X");
    expect(screen.getByText("Authoring tool").nextElementSibling).toHaveTextContent("Not supplied");
    expect(screen.getByText(/Capability details are partial/)).toBeInTheDocument();
  });

  it("does not retain a prior source lookup error or show endless loading for a package-only record", async () => {
    const lookup = vi.spyOn(api, "getInventorySourceAwareDetail").mockRejectedValue(new Error("Previous source lookup failed"));
    const observed: UnifiedAgentRecord = {
      ...record,
      observations: {
        ...record.observations,
        powerPlatform: {
          id: "snapshot-1", snapshotId: "snapshot-1", current: true,
          observedAt: "2026-09-15T00:00:00Z", expiresAt: "2026-10-15T00:00:00Z",
          roleScope: "full", environmentScope: null, coverage: "covered", coveredCount: 1,
          observedCount: 1, totalRecords: 1, pageCount: 1, verification: createInventoryVerification(1),
        },
      },
    };
    const modal = (value: UnifiedAgentRecord) => <WorkbenchActionProvider value={[]}>
      <UnifiedAgentDetailModal record={value} activeTab="audit-security" roles={["AgentControl.Viewer"]}
        onTabChange={vi.fn()} onClose={vi.fn()} onInspectPackage={vi.fn()}
        onUpdatePackageAccess={vi.fn().mockResolvedValue(undefined)} onSetPackageBlocked={vi.fn()} />
    </WorkbenchActionProvider>;
    const { rerender } = render(modal(observed));
    expect(await screen.findByText("Previous source lookup failed")).toBeInTheDocument();
    rerender(modal({ ...record, id: "package-only", powerPlatformResource: null }));
    expect(screen.queryByText("Previous source lookup failed")).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading authorized exact source associations/)).not.toBeInTheDocument();
    expect(screen.getByText("No saved activity is linked to this agent's inventory record.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Search tenant interactions" })).not.toBeInTheDocument();
    expect(lookup).toHaveBeenCalledOnce();
  });

  it.each(["success", "error"] as const)("ignores a late source lookup %s after changing exact targets", async outcome => {
    const first = observedRecord();
    const next: UnifiedAgentRecord = {
      ...first, id: "unified-2",
      powerPlatformResource: { ...first.powerPlatformResource!, nativeId: "agent-2" },
    };
    let finish!: () => void;
    const pending = new Promise<InventorySourceAwareDetail>((resolve, reject) => {
      finish = () => {
        if (outcome === "error") reject(new Error("Previous target lookup failed"));
        else resolve({
          ...sourceAwareDetail(first),
          audit: { status: "unavailable", reason: "Previous target audit" },
        });
      };
    });
    const lookup = vi.mocked(api.getInventorySourceAwareDetail)
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce({
        ...sourceAwareDetail(next),
        audit: { status: "unavailable", reason: "Current target audit" },
      });
    const { update, unmount } = renderDetail({ record: first, activeTab: "audit-security" });
    expect(lookup).toHaveBeenNthCalledWith(1, {
      snapshotId: first.observations.powerPlatform!.snapshotId,
      nativeId: first.powerPlatformResource!.nativeId,
      type: first.powerPlatformResource!.type,
      environmentId: first.powerPlatformResource!.environmentId,
    }, { signal: expect.any(AbortSignal) });
    update({ record: next });
    expect(lookup.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(await screen.findByText("Unavailable: Current target audit")).toBeVisible();
    await act(async () => { finish(); });
    expect(screen.getByText("Unavailable: Current target audit")).toBeVisible();
    expect(screen.queryByText(/Previous target/)).not.toBeInTheDocument();
    unmount();
    expect(lookup.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });

  it.each([0, 1, 20, 21])("distinguishes %s total activity associations from the bounded displayed rows", async count => {
    const observed = observedRecord();
    const shown = Math.min(count, 20);
    const related = sourceAwareDetail(observed);
    related.audit = {
      status: "available", count,
      value: Array.from({ length: shown }, (_, index) => ({
        jobId: "audit-job", wrapperId: `wrapper-${index}`, nativeEventId: null,
        observedAt: related.observedAt, operation: `Audit operation ${index}`,
        resultStatus: null, correlationId: null, matchedKind: "cds_bot_id",
      })),
    };
    related.security = {
      status: "available", count,
      value: Array.from({ length: shown }, (_, index) => ({
        jobId: "security-job", snapshotId: "security-snapshot", nativeRecordId: `Security record ${index}`,
        observedAt: related.observedAt, platform: null, lifecycleStatus: null, publishedStatus: null,
        matchedKind: "entra_agent_id",
      })),
    };
    vi.mocked(api.getInventorySourceAwareDetail).mockResolvedValue(related);
    renderDetail({ record: observed, activeTab: "audit-security" });
    const summary = count === 0 ? "Authorized and queried; no exact associated records."
      : `${count} exact associated record${count === 1 ? "" : "s"}; showing ${shown}.`;
    expect(await screen.findAllByText(summary)).toHaveLength(2);
    expect(screen.queryAllByText(/^Audit operation \d+$/)).toHaveLength(shown);
    expect(screen.queryAllByText(/^Security record \d+$/)).toHaveLength(shown);
  });

  it("offers common Manage controls for every package and quarantine with exact target callbacks", async () => {
    const observed = observedRecord();
    observed.packages = [
      { ...record.packages[0], availableTo: "all", deployedTo: "some" },
      { ...record.packages[0], id: "package-2", displayName: "Package two", isBlocked: true },
    ];
    const { props } = renderDetail({ record: observed, activeTab: "controls" });
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
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
    expect(screen.getByText(/Makers may still see and test a quarantined bot/)).toBeVisible();
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
    expect(api.getInventorySourceAwareDetail).not.toHaveBeenCalled();
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
      nativeId: manifestId,
      details: { schemaName: manifestId },
      identifiers: [{ kind: "environment_id", value: environmentId }],
    };
    const { props } = renderDetail({ record: observed, activeTab: "controls" });
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
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
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
    expect(screen.getByText(/Availability and installation have not been observed/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Manage access|Manage installation|^Block / })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    expect(screen.getByText("Saved inventory status").parentElement).toHaveTextContent("Unknown");
  });

  it("keeps viewers read-only even on a directly opened Manage route", async () => {
    renderDetail({ record: observedRecord(), activeTab: "controls", roles: ["AgentControl.Viewer"] });
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
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
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
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
      renderDetail({ record: observed, activeTab: "controls" });
      if (observed.observations.powerPlatform) await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
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
    const { props, update } = renderDetail({ record: observed, activeTab: "controls" });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    expect(api.previewQuarantine).toHaveBeenCalledExactlyOnceWith({
      action: "quarantine", snapshotId: snapshot.id, resourceNativeIds: [record.powerPlatformResource.nativeId],
    });
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
    }, expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(props.onSetPackageBlocked).not.toHaveBeenCalled();
    expect(props.onUpdatePackageAccess).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("does not carry a quarantine job and its recovery controls to a different native target", async () => {
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
    update({ record: {
      ...observed, id: "different-logical-agent",
      powerPlatformResource: { ...observed.powerPlatformResource!, nativeId: "different-native-agent" },
    } });
    expect(screen.queryByText("Quarantine job: Succeeded")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh job status" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    expect(api.submitQuarantine).toHaveBeenCalledOnce();
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
    expect(confirmation).not.toBeInTheDocument();
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

  it.each(["synchronous", "queued"] as const)("keeps quarantine confirmation open through Strict Mode replay with %s close events", async timing => {
    if (timing === "queued") queueNativeCloseEvents();
    const observed = observedRecord();
    vi.mocked(api.previewQuarantine).mockResolvedValue(quarantinePreview(observed));
    const { props } = renderDetail({ record: observed, activeTab: "controls" }, capabilities(), workbenchActions, { reactStrictMode: true });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    expect(screen.getByRole("dialog", { name: "Quarantine 1 agent" })).toHaveAttribute("open");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it("cancels an inline package confirmation before closing the agent on Escape", () => {
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
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
