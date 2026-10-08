import { act, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import {
  ApiError,
  approvePurviewAuditQualification,
  cancelPurviewAuditSearch,
  deletePurviewAuditSearch,
  downloadPurviewAuditCsv,
  getPurviewAuditCatalog,
  getPurviewAuditJob,
  getPurviewAuditJobs,
  getPurviewAuditRecords,
  resumePurviewAuditSearch,
  startPurviewAuditQualification,
  submitPurviewAuditSearch,
  type CapabilityView,
  type PurviewAuditFilters,
  type PurviewAuditJob,
  type PurviewAuditQualification,
  type PurviewAuditRecordPage,
  type SessionUser,
} from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { createSavedQueryClient, readSavedQuery } from "../savedQueries";
import { PurviewAuditView as UserPurviewAuditView } from "./PurviewAuditView";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  approvePurviewAuditQualification: vi.fn(),
  cancelPurviewAuditSearch: vi.fn(),
  deletePurviewAuditSearch: vi.fn(),
  downloadPurviewAuditCsv: vi.fn(),
  getPurviewAuditCatalog: vi.fn(),
  getPurviewAuditJob: vi.fn(),
  getPurviewAuditJobs: vi.fn(),
  getPurviewAuditRecords: vi.fn(),
  resumePurviewAuditSearch: vi.fn(),
  startPurviewAuditQualification: vi.fn(),
  submitPurviewAuditSearch: vi.fn(),
}));

const viewer: SessionUser = {
  displayName: "Synthetic viewer",
  username: "reader@example.invalid",
  homeAccountId: "reader-a",
  tenantId: "tenant-a",
  roles: ["AgentControl.Viewer"],
};

function PurviewAuditView({ userPrincipalName = viewer.username, active = true }: { userPrincipalName?: string; active?: boolean } = {}) {
  return <UserPurviewAuditView userPrincipalName={userPrincipalName} active={active} />;
}

function render(ui: ReactNode, reactStrictMode = false) {
  const wrap = (children: ReactNode) => <WorkbenchActionProvider value={workbenchActions}>{children}</WorkbenchActionProvider>;
  const result = rtlRender(wrap(ui), { reactStrictMode });
  return { ...result, rerender: (next: ReactNode) => result.rerender(wrap(next)) };
}

const administrator: SessionUser = {
  ...viewer,
  roles: ["AgentControl.Admin"],
};

const catalog = {
  presets: [
    {
      id: "copilot_interactions" as const,
      label: "Copilot interactions",
      service: "Copilot",
      recordTypes: ["copilotInteraction"],
      operations: ["CopilotInteraction"],
    },
    {
      id: "copilot_studio_admin" as const,
      label: "Copilot Studio administration",
      service: "PowerPlatform",
      recordTypes: ["powerPlatformAdministratorActivity"],
      operations: ["BotCreate"],
    },
  ],
  limits: {
    maximumWindowHours: 168,
    qualificationWindowHours: 1,
    maximumPages: 20,
    maximumRows: 5_000,
    maximumBytes: 8_000_000,
    pollsPerActivation: 6,
    providerRequests: 64,
    activations: 12,
  },
  evidenceNotice:
    "Microsoft Purview Audit Search is compliance and security evidence. It is not official Microsoft 365 Copilot Agents usage.",
  contentNotice:
    "Content not present in Purview audit. Copilot audit records expose message identifiers and metadata, not prompt or response text.",
  retentionNotice:
    "Local minimized results expire after 30 days. Microsoft Purview source retention and remote query lifetime are separate provider policies.",
};

const filters: PurviewAuditFilters = {
  presetId: "copilot_interactions",
  operations: ["CopilotInteraction"],
  startDateTime: "2026-09-08T12:00:00.000Z",
  endDateTime: "2026-09-08T13:00:00.000Z",
  userPrincipalNames: [viewer.username],
  ipAddresses: [],
  objectIds: [],
  administrativeUnitIds: [],
};

const partialJob: PurviewAuditJob = {
  id: "11111111-1111-4111-8111-111111111111",
  authorizationPrincipalId: "reader-a",
  resultScope: { kind: "principal", scopeId: "reader-a", configurationRevision: null },
  tokenMode: "delegated",
  status: "partial",
  filters,
  displayName: "agent-control:reader-a:fixture",
  providerQueryId: "provider-query-a",
  providerStatus: "succeeded",
  localRequestId: "provider-correlation-a",
  providerRequestId: "provider-request-a",
  projectionVersion: 1,
  providerRequestCount: 12,
  activationCount: 2,
  pageCount: 20,
  providerRowCount: 5_250,
  storedRowCount: 5_000,
  byteCount: 7_500_000,
  unknownFieldCount: 3,
  pageComplete: false,
  observedRange: {
    startDateTime: "2026-09-08T12:00:00.000Z",
    endDateTime: "2026-09-08T12:45:00.000Z",
  },
  unobservedRange: {
    startDateTime: "2026-09-08T12:45:00.000Z",
    endDateTime: "2026-09-08T13:00:00.000Z",
  },
  qualificationId: null,
  cancelRequested: false,
  createdAt: "2026-09-08T13:01:00.000Z",
  attemptedAt: "2026-09-08T13:01:01.000Z",
  updatedAt: "2026-09-08T13:02:00.000Z",
  finishedAt: "2026-09-08T13:02:00.000Z",
  expiresAt: "2026-10-08T13:02:00.000Z",
  canResume: false,
  remoteWorkMayContinue: false,
};

function capabilityView(
  authorized: boolean,
  capabilityId: CapabilityView["definition"]["id"] = "purview.audit.search.delegated",
): CapabilityView {
  const definition = capabilityDefinitions.find(
    (candidate) => candidate.id === capabilityId,
  )!;

  return {
    definition,
    enabled: true,
    configuration: { enabled: true, sharedDataScope: true, revision: 1 },
    decision: {
      capabilityId: definition.id,
      status: authorized ? "available" : "unknown",
      authorized,
      fresh: authorized,
      verification: "provider",
      checkedAt: authorized ? "2026-09-08T13:00:00.000Z" : undefined,
      expiresAt: authorized ? "2026-09-08T14:00:00.000Z" : undefined,
      previewQualification: authorized ? "qualified" : "unqualified",
      remediation: [
        "Approve and run one bounded live qualification; routine probes never create queries.",
      ],
    },
  };
}

function context(
  user: SessionUser,
  authorized = false,
  now = Date.parse("2026-09-08T13:05:00.000Z"),
) {
  return {
    views: [capabilityView(authorized), capabilityView(false, "purview.audit.search.application")],
    user,
    loading: false,
    pending: false,
    error: undefined,
    now,
    reload: vi.fn(async () => undefined),
    openPermissions: vi.fn(),
  };
}

function approvedQualification(
  overrides: Partial<PurviewAuditQualification> = {},
): PurviewAuditQualification {
  return {
    id: "qualification-a",
    capabilityId: "purview.audit.search.delegated",
    tokenMode: "delegated",
    authorizationPrincipalId: "reader-a",
    resultScope: { kind: "principal", scopeId: "reader-a", configurationRevision: null },
    filters,
    status: "approved",
    contractRevision: "fixture-contract",
    permissionRevision: "fixture-permission",
    configurationRevision: 1,
    approvedBy: "reader-a",
    approvedAt: "2026-09-08T13:00:00.000Z",
    expiresAt: "2026-09-08T13:20:00.000Z",
    jobId: null,
    ...overrides,
  };
}

function recordPage(job = partialJob, actor = "Selected record actor"): PurviewAuditRecordPage {
  return {
    count: 1, limit: 100, offset: 0, job,
    value: [{
      projectionVersion: 1, wrapperId: "record-a", nativeEventId: null, eventDateTime: filters.startDateTime,
      auditLogRecordType: "copilotInteraction", operation: "CopilotInteraction", service: "Copilot", resultStatus: null,
      actorUserId: null, actorUserPrincipalName: actor, actorUserType: null, objectId: null, clientIp: null,
      administrativeUnits: [], correlationId: null, agentId: null, appIdentity: null, appHost: null, botId: null,
      environmentId: null, botComponentId: null, aiPluginOperationId: null, messages: [], contentAvailable: false,
      unknownFieldCount: 0,
    }],
  };
}

describe("PurviewAuditView", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T13:05:00.000Z"));
    window.history.replaceState({}, "", "/users");
    vi.mocked(getPurviewAuditCatalog).mockResolvedValue(catalog);
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockResolvedValue({
      value: [], count: 0, limit: 100, offset: 0, job: partialJob,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([undefined, viewer.username])("scopes agent collection and history to the selected agent and user %s", async userPrincipalName => {
    const agentRecordId = "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    vi.mocked(submitPurviewAuditSearch).mockRejectedValue(new ApiError(403, "provider_denied", "Purview access denied by the provider."));
    render(<CapabilityContext value={context(viewer, true)}><UserPurviewAuditView
      agentRecordId={agentRecordId} userPrincipalName={userPrincipalName} presets={["copilot_studio_admin"]} /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    expect(getPurviewAuditJobs).toHaveBeenCalledWith(20, 0, expect.objectContaining({ agentRecordId, userPrincipalName }));
    expect(within(screen.getByLabelText("Log type")).getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Run Audit Search" }));
    await waitFor(() => expect(submitPurviewAuditSearch).toHaveBeenCalledWith("delegated", expect.objectContaining({
      presetId: "copilot_studio_admin", userPrincipalNames: userPrincipalName ? [userPrincipalName] : [],
    }), expect.objectContaining({ agentRecordId })));
    expect(vi.mocked(submitPurviewAuditSearch).mock.calls[0][1].agent).toBeUndefined();
    expect(await screen.findByText("Purview access denied by the provider.")).toBeVisible();
  });

  it("rejects a history response from another agent before presenting its records", async () => {
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [{ ...partialJob, filters: {
      ...filters, agent: { recordId: "agent:other", botId: "bot-other", environmentId: "environment-other" },
    } }], count: 1, limit: 20, offset: 0 });
    render(<CapabilityContext value={context(viewer, true)}><UserPurviewAuditView
      agentRecordId="agent:selected" userPrincipalName={viewer.username} /></CapabilityContext>);
    expect(await screen.findByRole("alert")).toHaveTextContent(/agent/i);
    expect(getPurviewAuditRecords).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });

  it("keeps the scoped form compact and refreshes missing permissions without creating a query", async () => {
    const value = context(viewer);
    value.views = value.views.filter(view => view.definition.mode === "delegated");
    const view = render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    expect(view.container.querySelector("details, summary")).toBeNull();
    expect(screen.getByText(/Conversation text is not included/)).toBeVisible();
    expect(screen.queryByText("Microsoft Graph v1.0")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Purview access and setup" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Structured identity filters" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("IP addresses")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Authorization")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check permissions" }));
    expect(value.reload).toHaveBeenCalledOnce();
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
    expect(approvePurviewAuditQualification).not.toHaveBeenCalled();
    expect(startPurviewAuditQualification).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Open Permissions" }));
    expect(value.openPermissions).toHaveBeenCalledOnce();
  });

  it("keeps incomplete readiness concise while preserving actual setup failures", async () => {
    const value = context(viewer);
    value.views[0].decision.checkedAt = "2026-09-08T13:00:00.000Z";
    const view = render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    expect(screen.getByText("Check incomplete. Retry permissions.")).toBeVisible();
    expect(screen.queryByText(/did not establish/)).not.toBeInTheDocument();
    const denied = { ...value, views: [{ ...value.views[0], decision: { ...value.views[0].decision, status: "missing_role" as const } }] };
    view.rerender(<CapabilityContext value={denied}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    expect(screen.getByRole("region", { name: "Audit Search authorization pending" })).toHaveTextContent("Requires Audit Logs or View-Only Audit Logs.");
  });

  it.each(["unchecked", "expired"] as const)("uses application-specific recovery for %s evidence", async state => {
    const value = context(administrator);
    const application = capabilityView(state === "expired", "purview.audit.search.application");
    if (state === "expired") application.decision.expiresAt = new Date(value.now).toISOString();
    value.views.splice(1, 1, application);
    render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    const access = screen.getByRole("region", { name: "Audit Search qualification required" });
    expect(access).toHaveTextContent(/Application qualification required/);
    expect(access).not.toHaveTextContent(/Check incomplete|Permissions have not been checked/);
    expect(within(access).queryByText("Available")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeDisabled();
    expect(getPurviewAuditJobs).toHaveBeenCalledOnce();
  });

  it("expires the last operation warning without changing admission or reloading saved results", async () => {
    const value = context(viewer, true);
    value.views[0].operationFailure = {
      status: "missing_permission", checkedAt: new Date(value.now - 1_000).toISOString(),
      expiresAt: new Date(value.now + 1_000).toISOString(), remediation: ["Operation-specific denial"],
    };
    const view = render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    expect(screen.getByText("Last search issue: Operation-specific denial")).toBeVisible();
    view.rerender(<CapabilityContext value={{ ...value, now: value.now + 1_000 }}><PurviewAuditView /></CapabilityContext>);
    expect(screen.queryByText(/Last search issue/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeEnabled();
    expect(getPurviewAuditJobs).toHaveBeenCalledOnce();
    expect(value.reload).not.toHaveBeenCalled();
  });

  it("rejects an application search at submission when the diagnostics timer has not observed expiry", async () => {
    const value = context(administrator);
    const application = capabilityView(true, "purview.audit.search.application");
    application.decision.expiresAt = new Date(value.now + 1_000).toISOString();
    value.views.splice(1, 1, application);
    render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    const submit = screen.getByRole("button", { name: "Run Audit Search" });
    expect(submit).toBeEnabled();
    vi.setSystemTime(value.now + 1_000);
    fireEvent.submit(submit.closest("form")!);
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("preserves filters and selected records when only capability diagnostics renew", async () => {
    const value = context(viewer, true);
    value.views[0].decision.verification = "token";
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockResolvedValue(recordPage());
    const view = render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await screen.findByRole("button", { name: /View results/ });
    await userEvent.selectOptions(screen.getByLabelText("Log type"), "copilot_studio_admin");
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-08T10:00" } });
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-09-08T11:00" } });
    await userEvent.click(screen.getByRole("button", { name: /View results/ }));
    await screen.findByText("Selected record actor");
    const renewed = context(viewer, true, Date.parse("2026-09-08T13:10:00.000Z"));
    renewed.views[0].decision.checkedAt = "2026-09-08T13:10:00.000Z";
    renewed.views[0].decision.expiresAt = "2026-09-08T14:10:00.000Z";
    renewed.views[0].decision.lastSuccessAt = renewed.views[0].decision.checkedAt;
    renewed.views[0].decision.fresh = false;
    view.rerender(<CapabilityContext value={renewed}><PurviewAuditView /></CapabilityContext>);
    expect(screen.getByLabelText("Log type")).toHaveValue("copilot_studio_admin");
    expect(screen.getByLabelText("Start")).toHaveValue("2026-09-08T10:00");
    expect(screen.getByLabelText("End")).toHaveValue("2026-09-08T11:00");
    expect(screen.queryByRole("checkbox", { name: "BotCreate" })).not.toBeInTheDocument();
    expect(screen.getByText("Selected record actor")).toBeVisible();
    expect(getPurviewAuditJobs).toHaveBeenCalledOnce();
    expect(getPurviewAuditRecords).toHaveBeenCalledOnce();
  });

  it("does not read or create provider work while initially inactive", async () => {
    const value = context(viewer, true);
    const view = render(<CapabilityContext value={value}><PurviewAuditView active={false} /></CapabilityContext>);
    await act(async () => {});
    expect(view.container).toBeEmptyDOMElement();
    expect(getPurviewAuditCatalog).not.toHaveBeenCalled();
    expect(getPurviewAuditJobs).not.toHaveBeenCalled();
    view.rerender(<CapabilityContext value={value}><PurviewAuditView active /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    expect(getPurviewAuditJobs).toHaveBeenCalledOnce();
    expect(value.reload).not.toHaveBeenCalled();
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it.each(["approve", "start"] as const)("waits for returning saved-state revalidation before qualification %s", async action => {
    const value = context(administrator);
    let finish!: (history: Awaited<ReturnType<typeof getPurviewAuditJobs>>) => void;
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(approvePurviewAuditQualification).mockResolvedValue(approvedQualification({
      tokenMode: "application", capabilityId: "purview.audit.search.application",
    }));
    const view = render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    await userEvent.selectOptions(screen.getByLabelText("Authorization"), "application");
    await userEvent.click(screen.getByRole("checkbox", { name: /Approve one narrow/ }));
    if (action === "start") await userEvent.click(screen.getByRole("button", { name: "Approve qualification" }));
    view.rerender(<CapabilityContext value={value}><PurviewAuditView active={false} /></CapabilityContext>);
    view.rerender(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    const button = screen.getByRole("button", { name: action === "start" ? "Run approved qualification" : "Approve qualification" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(startPurviewAuditQualification).not.toHaveBeenCalled();
    expect(approvePurviewAuditQualification).toHaveBeenCalledTimes(action === "start" ? 1 : 0);
    await act(async () => finish({ value: [], count: 0, limit: 20, offset: 0 }));
    expect(button).toBeEnabled();
  });

  it("revalidates the exact saved selection and record page before showing them on return", async () => {
    const value = context(viewer, true);
    let finish!: (job: PurviewAuditJob) => void;
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockResolvedValueOnce(recordPage()).mockResolvedValue(recordPage(partialJob, "Revalidated actor"));
    vi.mocked(getPurviewAuditJob).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await screen.findByRole("button", { name: /View results/ });
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-08T10:30" } });
    await userEvent.click(screen.getByRole("button", { name: /View results/ }));
    await screen.findByText("Selected record actor");
    view.rerender(<CapabilityContext value={value}><PurviewAuditView active={false} /></CapabilityContext>);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<CapabilityContext value={value}><PurviewAuditView active /></CapabilityContext>);
    expect(screen.queryByText("Selected record actor")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Start")).toHaveValue("2026-09-08T10:30");
    expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeDisabled();
    await waitFor(() => expect(getPurviewAuditJob).toHaveBeenCalledOnce());
    expect(getPurviewAuditRecords).toHaveBeenCalledOnce();
    await act(async () => finish(partialJob));
    expect(await screen.findByText("Revalidated actor")).toBeVisible();
    expect(screen.queryByText("Selected record actor")).not.toBeInTheDocument();
    expect(getPurviewAuditRecords).toHaveBeenLastCalledWith(partialJob.id, 100, 0, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2);
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
    expect(resumePurviewAuditSearch).not.toHaveBeenCalled();
    expect(cancelPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("discards private results when selected-scope revalidation is denied", async () => {
    const value = context(viewer, true);
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockResolvedValue(recordPage());
    vi.mocked(getPurviewAuditJob).mockRejectedValue(new ApiError(404, "not_found", "Saved search is unavailable."));
    const view = render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", { name: /View results/ }));
    await screen.findByText("Selected record actor");
    view.rerender(<CapabilityContext value={value}><PurviewAuditView active={false} /></CapabilityContext>);
    view.rerender(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    expect(await screen.findByRole("alert")).toHaveTextContent("unavailable");
    expect(screen.queryByText("Selected record actor")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Export results/ })).not.toBeInTheDocument();
    expect(getPurviewAuditRecords).toHaveBeenCalledOnce();
  });

  it.each([
    { stage: "job", outcome: "resolve" }, { stage: "job", outcome: "reject" },
    { stage: "records", outcome: "resolve" }, { stage: "records", outcome: "reject" },
  ] as const)("cancels a returning selection's $stage read after draft edits and ignores its late $outcome", async ({ stage, outcome }) => {
    const value = context(viewer, true);
    let finish!: () => void;
    let reject!: (error: Error) => void;
    let signal!: AbortSignal;
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    if (stage === "job") {
      vi.mocked(getPurviewAuditJob).mockImplementation((_id, options) => {
        signal = options!.signal!;
        return new Promise((resolve, rejectRead) => { finish = () => resolve(partialJob); reject = rejectRead; });
      });
      vi.mocked(getPurviewAuditRecords).mockResolvedValueOnce(recordPage());
    } else {
      vi.mocked(getPurviewAuditJob).mockResolvedValue(partialJob);
      vi.mocked(getPurviewAuditRecords).mockResolvedValueOnce(recordPage())
        .mockImplementationOnce((_id, _limit, _offset, options) => {
          signal = options!.signal!;
          return new Promise((resolve, rejectRead) => {
            finish = () => resolve(recordPage(partialJob, "Obsolete selected actor")); reject = rejectRead;
          });
        });
    }
    vi.mocked(getPurviewAuditRecords).mockResolvedValue(recordPage(partialJob, "Current selected actor"));
    const view = render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", { name: /View results/ }));
    await screen.findByText("Selected record actor");
    view.rerender(<CapabilityContext value={value}><PurviewAuditView active={false} /></CapabilityContext>);
    view.rerender(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await waitFor(() => expect(stage === "job" ? getPurviewAuditJob : getPurviewAuditRecords).toHaveBeenCalledTimes(stage === "job" ? 1 : 2));
    expect(screen.getByText("Loading Audit Search history...")).toBeVisible();

    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-08T10:30" } });
    await waitFor(() => expect(signal.aborted).toBe(true));
    expect(screen.queryByText("Loading Audit Search history...")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Minimized results" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /View results/ }));
    expect(await screen.findByText("Current selected actor")).toBeVisible();
    await act(async () => {
      if (outcome === "resolve") finish();
      else reject(new ApiError(403, "forbidden", "Obsolete record denial"));
    });
    expect(screen.getByText("Current selected actor")).toBeVisible();
    expect(screen.queryByText("Obsolete selected actor")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2);
    expect(getPurviewAuditRecords).toHaveBeenCalledTimes(stage === "job" ? 2 : 3);
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("aborts inactive polling, rejects late reads, and preserves the polling budget", async () => {
    vi.useFakeTimers();
    const value = context(viewer, true);
    const running = { ...partialJob, status: "running" as const };
    const history = { value: [running], count: 1, limit: 20, offset: 0 };
    let finish!: (history: Awaited<ReturnType<typeof getPurviewAuditJobs>>) => void;
    let signal!: AbortSignal;
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce(history).mockImplementationOnce((_limit, _offset, options) => {
      signal = options!.signal!;
      return new Promise(resolve => { finish = resolve; });
    }).mockResolvedValue(history);
    const view = render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    view.rerender(<CapabilityContext value={value}><PurviewAuditView active={false} /></CapabilityContext>);
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ value: [partialJob], count: 1, limit: 20, offset: 0 }));
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2);
    view.rerender(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await act(async () => {});
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("button", { name: /View results/ })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByText(/Automatic history refresh paused/)).toBeVisible();
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(3);
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("aborts an in-flight search on leaving without replaying it or accepting its late selection", async () => {
    const value = context(viewer, true);
    let finish!: (job: PurviewAuditJob) => void;
    let signal!: AbortSignal;
    vi.mocked(submitPurviewAuditSearch).mockImplementation((_mode, _filters, options) => {
      signal = options!.signal!;
      return new Promise(resolve => { finish = resolve; });
    });
    const view = render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    await userEvent.click(screen.getByRole("button", { name: "Run Audit Search" }));
    view.rerender(<CapabilityContext value={value}><PurviewAuditView active={false} /></CapabilityContext>);
    expect(signal.aborted).toBe(true);
    await act(async () => finish(partialJob));
    view.rerender(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    expect(screen.queryByRole("heading", { name: "Minimized results" })).not.toBeInTheDocument();
    expect(submitPurviewAuditSearch).toHaveBeenCalledOnce();
    expect(startPurviewAuditQualification).not.toHaveBeenCalled();
    expect(resumePurviewAuditSearch).not.toHaveBeenCalled();
  });

  it.each(["role", "selected user", "application scope", "application revision"] as const)("isolates private state after a %s change", async change => {
    const value = context(viewer, true);
    value.views.splice(1, 1, { ...capabilityView(true, "purview.audit.search.application"), configuration: { enabled: true, sharedDataScope: true, revision: 1 } });
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce({ value: [partialJob], count: 1, limit: 20, offset: 0 })
      .mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockResolvedValue(recordPage());
    const view = render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await screen.findByRole("button", { name: /View results/ });
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-08T10:30" } });
    await userEvent.click(screen.getByRole("button", { name: /View results/ }));
    await screen.findByText("Selected record actor");
    const next = { ...value, user: change === "role" ? administrator : viewer,
      views: change.startsWith("application") ? [value.views[0], { ...value.views[1],
        configuration: { enabled: true, sharedDataScope: change !== "application scope", revision: 2 } }] : value.views };
    view.rerender(<CapabilityContext value={next}><PurviewAuditView userPrincipalName={change === "selected user" ? "other@example.invalid" : viewer.username} /></CapabilityContext>);
    expect(screen.queryByText("Selected record actor")).not.toBeInTheDocument();
    await screen.findByText("No Audit Search history");
    expect(screen.getByLabelText("Start")).not.toHaveValue("2026-09-08T10:30");
    expect(screen.queryByRole("button", { name: /Export results/ })).not.toBeInTheDocument();
  });

  it.each([false, true])("retains action-selected records only when manual refresh confirms the same version (changed: %s)", async changed => {
    const waiting = { ...partialJob, status: "waiting_authorization" as const, canResume: true };
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce({ value: [waiting], count: 1, limit: 20, offset: 0 })
      .mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    vi.mocked(resumePurviewAuditSearch).mockResolvedValue(partialJob);
    vi.mocked(getPurviewAuditRecords).mockImplementation(async (_id, _limit, offset = 0) => ({
      ...recordPage(), count: 101, offset,
    }));
    let finish!: (job: PurviewAuditJob) => void;
    vi.mocked(getPurviewAuditJob).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", { name: /Resume search/ }));
    await userEvent.click(await screen.findByRole("button", { name: /View results/ }));
    await screen.findByText("Selected record actor");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Showing 101-101 of/);
    await userEvent.click(screen.getByRole("button", { name: "Refresh Audit Search history" }));
    expect(screen.queryByText("Selected record actor")).not.toBeInTheDocument();
    await act(async () => finish(changed ? { ...partialJob, updatedAt: "2026-09-08T13:03:00.000Z" } : partialJob));
    if (changed) {
      expect(screen.queryByText("Selected record actor")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Load minimized results" })).toBeEnabled();
    } else {
      expect(screen.getByText("Selected record actor")).toBeVisible();
      expect(screen.getByText(/Showing 101-101 of/)).toBeVisible();
    }
    expect(getPurviewAuditRecords).toHaveBeenCalledTimes(2);
    expect(resumePurviewAuditSearch).toHaveBeenCalledOnce();
  });

  it("does not reuse another account's pending request from a shared saved-query client", async () => {
    const client = createSavedQueryClient();
    let finish!: (history: Awaited<ReturnType<typeof getPurviewAuditJobs>>) => void;
    vi.mocked(getPurviewAuditJobs).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
    const value = context(viewer, true);
    const second = context({ ...viewer, homeAccountId: "reader-b" }, true);
    const view = render(<SavedQueryProvider client={client}>
      <CapabilityContext value={value}><section aria-label="Old account"><PurviewAuditView /></section></CapabilityContext>
      <CapabilityContext value={second}><section aria-label="New account"><PurviewAuditView /></section></CapabilityContext>
    </SavedQueryProvider>);
    try {
      const fresh = within(screen.getByRole("region", { name: "New account" }));
      expect(await fresh.findByText("No Audit Search history")).toBeVisible();
      expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2);
      await act(async () => finish({ value: [partialJob], count: 1, limit: 20, offset: 0 }));
      expect(fresh.queryByRole("button", { name: /View results/ })).not.toBeInTheDocument();
    } finally {
      view.unmount();
      client.clear();
    }
  });

  it("rejects a record page belonging to a different saved search", async () => {
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockResolvedValue(recordPage({ ...partialJob, id: "22222222-2222-4222-8222-222222222222" }));
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", { name: /View results/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("different job");
    expect(screen.queryByText("Selected record actor")).not.toBeInTheDocument();
  });

  it("shows saved authorization failures inline and only offers resume to the original account", async () => {
    const shared = { ...partialJob, tokenMode: "application" as const, authorizationPrincipalId: "other-admin",
      status: "waiting_authorization" as const, canResume: true, errorCode: "provider_denied", message: "Microsoft denied the audit query." };
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [shared], count: 1, limit: 20, offset: 0 });
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    expect(await screen.findByText(/provider_denied: Microsoft denied the audit query/)).toBeVisible();
    expect(screen.getByText("Resume requires the original authorizing account.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Resume search/ })).not.toBeInTheDocument();
    expect(resumePurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("resumes the saved job and cancels its local worker only after explicit actions", async () => {
    let job = { ...partialJob, status: "waiting_authorization" as PurviewAuditJob["status"], canResume: true };
    vi.mocked(getPurviewAuditJobs).mockImplementation(async () => ({ value: [job], count: 1, limit: 20, offset: 0 }));
    vi.mocked(resumePurviewAuditSearch).mockImplementation(async () => {
      job = { ...job, status: "running", canResume: false };
      return job;
    });
    vi.mocked(cancelPurviewAuditSearch).mockImplementation(async () => {
      job = { ...job, status: "cancelled", remoteWorkMayContinue: true };
      return job;
    });
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", { name: /Resume search/ }));
    await waitFor(() => expect(resumePurviewAuditSearch).toHaveBeenCalledExactlyOnceWith(job.id, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    await userEvent.click(await screen.findByRole("button", { name: /Cancel local polling/ }));
    await waitFor(() => expect(cancelPurviewAuditSearch).toHaveBeenCalledExactlyOnceWith(job.id, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(await screen.findByText("Remote work may continue")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Cancel local polling/ })).not.toBeInTheDocument();
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("downloads the explicit saved CSV export and releases the local object URL", async () => {
    const createUrl = vi.fn(() => "blob:saved-purview");
    const revokeUrl = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = revokeUrl;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.mocked(downloadPurviewAuditCsv).mockResolvedValue(new Blob(["jobId,operation\nsaved,CopilotInteraction"]));
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    try {
      render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
      await userEvent.click(await screen.findByRole("button", { name: /Export results/ }));
      expect(downloadPurviewAuditCsv).toHaveBeenCalledExactlyOnceWith(partialJob.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(createUrl).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledOnce();
      await waitFor(() => expect(revokeUrl).toHaveBeenCalledWith("blob:saved-purview"));
      expect(document.querySelector("a[download]")).toBeNull();
      expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["request", "activation"] as const)("recovers an export %s failure without leaking downloads or reloading history", async stage => {
    vi.useFakeTimers();
    const failure = new Error(`CSV ${stage} failed`);
    const blob = new Blob(["saved audit rows"]);
    const createObjectURL = vi.fn(() => `blob:purview-${createObjectURL.mock.calls.length}`);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.mocked(downloadPurviewAuditCsv).mockResolvedValue(blob);
    if (stage === "request") vi.mocked(downloadPurviewAuditCsv).mockRejectedValueOnce(failure);
    else click.mockImplementationOnce(() => { throw failure; });
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await act(async () => {});
    const button = screen.getByRole("button", { name: /Export results/ });

    await act(async () => { button.click(); button.click(); });
    expect(downloadPurviewAuditCsv).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent(failure.message);
    expect(button).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(document.querySelector("a[download]")).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledTimes(stage === "activation" ? 1 : 0);

    await act(async () => { button.click(); button.click(); });
    expect(downloadPurviewAuditCsv).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(document.querySelector("a[download]")).toHaveAttribute("download", `purview-audit-${partialJob.id}.csv`);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(document.querySelector("a[download]")).not.toBeInTheDocument();
    expect(revokeObjectURL.mock.calls).toEqual(createObjectURL.mock.results.map(result => [result.value]));
    expect(getPurviewAuditCatalog).toHaveBeenCalledOnce();
    expect(getPurviewAuditJobs).toHaveBeenCalledOnce();
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("keeps delegated search disabled without exposing a qualification ritual", async () => {
    render(
      <CapabilityContext value={context(viewer)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );

    expect(await screen.findByText("Delegated authorization is not ready")).toBeVisible();
    expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Approve qualification" })).not.toBeInTheDocument();
    expect(getPurviewAuditCatalog).toHaveBeenCalledOnce();
    expect(getPurviewAuditJobs).toHaveBeenCalledExactlyOnceWith(
      20,
      0,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
    expect(approvePurviewAuditQualification).not.toHaveBeenCalled();
    expect(startPurviewAuditQualification).not.toHaveBeenCalled();
  });

  it.each([true, false])("uses application authorization independently of delegated readiness (available: %s)", async (available) => {
    const user = userEvent.setup();
    const selectedContext = context(administrator, !available);
    selectedContext.views.splice(1, 1, capabilityView(available, "purview.audit.search.application"));
    vi.mocked(submitPurviewAuditSearch).mockResolvedValue({ ...partialJob, tokenMode: "application" });
    render(
      <CapabilityContext value={selectedContext}>
        <PurviewAuditView />
      </CapabilityContext>,
    );

    const authorization = await screen.findByLabelText("Authorization");
    const search = screen.getByRole("button", { name: "Run Audit Search" });
    expect(search).toHaveProperty("disabled", available);
    await user.selectOptions(authorization, "application");
    expect(search).toHaveProperty("disabled", !available);
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
    await user.click(search);

    if (available) {
      await waitFor(() => expect(submitPurviewAuditSearch).toHaveBeenCalledExactlyOnceWith(
        "application", expect.objectContaining({ presetId: "copilot_interactions" }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ));
    } else {
      expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
    }
  });

  it("locks searches and paginated history to the selected user without starting an investigation", async () => {
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [], count: 0, offset: 0, limit: 20 });
    vi.mocked(submitPurviewAuditSearch).mockImplementation(async (_mode, filters) => ({ ...partialJob, filters }));
    render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView userPrincipalName="employee@example.invalid" />
      </CapabilityContext>,
    );
    await screen.findByText("No Audit Search history");
    expect(screen.queryByRole("textbox", { name: "User principal names" })).not.toBeInTheDocument();
    expect(getPurviewAuditJobs).toHaveBeenCalledWith(20, 0, expect.objectContaining({ userPrincipalName: "employee@example.invalid" }));
    expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeEnabled();
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
    expect(startPurviewAuditQualification).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Run Audit Search" }));
    expect(submitPurviewAuditSearch).toHaveBeenCalledWith("delegated",
      expect.objectContaining({ userPrincipalNames: ["employee@example.invalid"] }), expect.anything());
  });

  it("rejects unrelated saved jobs in a user-scoped history rather than displaying or exporting them", async () => {
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, offset: 0, limit: 20 });
    render(<CapabilityContext value={context(viewer, true)}>
      <PurviewAuditView userPrincipalName="employee@example.invalid" />
    </CapabilityContext>);
    expect(await screen.findByRole("alert")).toHaveTextContent("did not match the selected user");
    expect(screen.queryByRole("button", { name: /View results/ })).not.toBeInTheDocument();
    expect(downloadPurviewAuditCsv).not.toHaveBeenCalled();
  });

  it("keeps explicit Admin application qualification approval and start", async () => {
    vi.mocked(approvePurviewAuditQualification).mockImplementation(
      async (tokenMode, approvedFilters) => ({
        id: "qualification-a",
        capabilityId: "purview.audit.search.application",
        tokenMode,
        authorizationPrincipalId: "reader-a",
        resultScope: { kind: "principal", scopeId: "reader-a", configurationRevision: null },
        filters: approvedFilters,
        status: "approved",
        contractRevision: "fixture-contract",
        permissionRevision: "fixture-permission",
        configurationRevision: 1,
        approvedBy: "reader-a",
        approvedAt: "2026-09-08T13:00:00.000Z",
        expiresAt: "2026-09-08T13:10:00.000Z",
        jobId: null,
      }),
    );
    vi.mocked(startPurviewAuditQualification).mockResolvedValue({
      ...partialJob,
      status: "running",
      qualificationId: "qualification-a",
      canResume: false,
    });
    const user = userEvent.setup();

    render(
      <CapabilityContext value={context(administrator)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );

    await screen.findByText("Delegated authorization is not ready");
    await user.selectOptions(screen.getByLabelText("Authorization"), "application");
    await screen.findByText("Application qualification required");
    const approve = screen.getByRole("button", {
      name: "Approve qualification",
    });
    expect(approve).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: "Approve one narrow remote query for contract qualification",
      }),
    );
    await user.click(approve);

    expect(approvePurviewAuditQualification).toHaveBeenCalledOnce();
    expect(approvePurviewAuditQualification).toHaveBeenCalledWith(
      "application",
      expect.objectContaining({
        presetId: "copilot_interactions",
        operations: ["CopilotInteraction"],
        userPrincipalNames: [viewer.username],
        ipAddresses: [],
        objectIds: [],
        administrativeUnitIds: [],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(startPurviewAuditQualification).not.toHaveBeenCalled();

    await user.click(
      await screen.findByRole("button", {
        name: "Run approved qualification",
      }),
    );
    expect(startPurviewAuditQualification).toHaveBeenCalledExactlyOnceWith(
      "qualification-a",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("keeps application qualification approval Admin-only", async () => {
    const user = userEvent.setup();
    render(
      <CapabilityContext value={context(viewer)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );

    await screen.findByText("Delegated authorization is not ready");
    await user.selectOptions(screen.getByLabelText("Authorization"), "application");
    expect(screen.queryByRole("button", { name: "Approve qualification" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", {
      name: "Approve one narrow remote query for contract qualification",
    })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeDisabled();
  });

  it("shows bounded partial coverage, minimized identifiers, and exact associations", async () => {
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({
      value: [partialJob],
      count: 1,
      limit: 20,
      offset: 0,
    });
    vi.mocked(getPurviewAuditRecords).mockResolvedValue({
      value: [
        {
          projectionVersion: 1,
          wrapperId: "wrapper-a",
          nativeEventId: "native-event-a",
          eventDateTime: "2026-09-08T12:30:00.000Z",
          auditLogRecordType: "copilotInteraction",
          operation: "CopilotInteraction",
          service: "Copilot",
          resultStatus: "Succeeded",
          actorUserId: "actor-a",
          actorUserPrincipalName: "actor@example.invalid",
          actorUserType: "Member",
          objectId: "object-a",
          clientIp: "192.0.2.10",
          administrativeUnits: [],
          correlationId: "correlation-a",
          agentId: "agent-a",
          appIdentity: null,
          appHost: null,
          botId: "bot-a",
          environmentId: "environment-a",
          botComponentId: null,
          aiPluginOperationId: null,
          messages: [{ id: "message-a", isPrompt: true }],
          contentAvailable: false,
          unknownFieldCount: 2,
          association: {
            status: "resolved",
            sourceSystem: "power_platform",
            nativeId: "inventory-agent-a",
            resourceType: "microsoft.copilotstudio/agents",
            environmentId: "environment-a",
            matchedKind: "cds_bot_id",
          },
        },
      ],
      count: 1,
      limit: 100,
      offset: 0,
      job: partialJob,
    });
    const user = userEvent.setup();

    render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );

    await user.click(
      await screen.findByRole("button", { name: /View results 11111111/ }),
    );
    expect(await screen.findByText("Partial coverage")).toBeVisible();
    expect(screen.queryByText("Authorizing actor")).not.toBeInTheDocument();
    expect(screen.queryByText("Result scope")).not.toBeInTheDocument();
    expect(screen.queryByText("Request / activation budget")).not.toBeInTheDocument();
    expect(screen.getByText("Page completeness").parentElement).toHaveTextContent("Incomplete");
    expect(screen.getByText("native-event-a")).toBeVisible();
    expect(screen.getByText(/Prompt ID: message-a/)).toBeVisible();
    expect(
      screen.getByText(
        "Exact microsoft.copilotstudio/agents: inventory-agent-a",
      ),
    ).toBeVisible();
    expect(screen.getByText(/Conversation text is not included/)).toBeVisible();
    expect(screen.queryByText("Unknown fields omitted")).not.toBeInTheDocument();
    expect(resumePurviewAuditSearch).not.toHaveBeenCalled();
    expect(cancelPurviewAuditSearch).not.toHaveBeenCalled();
    expect(deletePurviewAuditSearch).not.toHaveBeenCalled();
    expect(downloadPurviewAuditCsv).not.toHaveBeenCalled();
  });

  it("submits only selected code-owned operations", async () => {
    vi.mocked(submitPurviewAuditSearch).mockResolvedValue(partialJob);
    const user = userEvent.setup();
    render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );

    await screen.findByRole("heading", { name: "Search Purview logs" });
    await user.selectOptions(screen.getByLabelText("Log type"), "copilot_studio_admin");
    expect(screen.queryByRole("checkbox", { name: "BotCreate" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run Audit Search" }));
    expect(submitPurviewAuditSearch).toHaveBeenCalledWith("delegated", expect.objectContaining({
      presetId: "copilot_studio_admin",
      operations: ["BotCreate"],
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await screen.findByRole("heading", { name: "Minimized results" })).toBeVisible();
  });

  it("pages server history and binds local deletion to the selected job", async () => {
    vi.mocked(getPurviewAuditJobs).mockImplementation(async (_limit, offset = 0) => ({
      value: [{ ...partialJob, id: offset ? "22222222-2222-4222-8222-222222222222" : partialJob.id }],
      count: 21,
      limit: 20,
      offset,
    }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );

    await user.click(await screen.findByRole("button", { name: "Next Audit Search history page" }));
    await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenLastCalledWith(
      20,
      20,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    await user.click(await screen.findByRole("button", { name: /Delete local cache 22222222/ }));
    expect(deletePurviewAuditSearch).toHaveBeenCalledExactlyOnceWith("22222222-2222-4222-8222-222222222222", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("reloads saved history for a new account and ignores the previous account's late response", async () => {
    let resolveStaleHistory!: (value: Awaited<ReturnType<typeof getPurviewAuditJobs>>) => void;
    let staleSignal!: AbortSignal;
    const currentUser: SessionUser = {
      ...viewer,
      homeAccountId: "reader-b",
      username: "reader-b@example.invalid",
    };
    const currentJob: PurviewAuditJob = {
      ...partialJob,
      id: "22222222-2222-4222-8222-222222222222",
      authorizationPrincipalId: "reader-b",
      resultScope: { kind: "principal", scopeId: "reader-b", configurationRevision: null },
    };
    vi.mocked(getPurviewAuditJobs)
      .mockImplementationOnce((_limit, _offset, options) => {
        staleSignal = options!.signal!;
        return new Promise((resolve) => { resolveStaleHistory = resolve; });
      })
      .mockResolvedValueOnce({ value: [currentJob], count: 1, limit: 20, offset: 0 });

    const view = render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenCalledOnce());

    view.rerender(
      <CapabilityContext value={context(currentUser, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );

    expect(await screen.findByRole("button", { name: /View results 22222222/ })).toBeVisible();
    expect(staleSignal.aborted).toBe(true);
    resolveStaleHistory({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: /View results 11111111/ })).not.toBeInTheDocument();
  });

  it("ignores a late record page after the account changes", async () => {
    let resolveStaleRecords!: (value: Awaited<ReturnType<typeof getPurviewAuditRecords>>) => void;
    const currentUser: SessionUser = {
      ...viewer,
      homeAccountId: "reader-b",
      username: "reader-b@example.invalid",
    };
    vi.mocked(getPurviewAuditJobs)
      .mockResolvedValueOnce({ value: [partialJob], count: 1, limit: 20, offset: 0 })
      .mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockReturnValueOnce(
      new Promise((resolve) => { resolveStaleRecords = resolve; }),
    );
    const user = userEvent.setup();
    const view = render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await user.click(await screen.findByRole("button", { name: /View results 11111111/ }));
    await waitFor(() => expect(getPurviewAuditRecords).toHaveBeenCalledOnce());

    view.rerender(
      <CapabilityContext value={context(currentUser, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveStaleRecords({ value: [], count: 0, limit: 100, offset: 0, job: partialJob });
    });

    expect(screen.queryByRole("heading", { name: "Minimized results" })).not.toBeInTheDocument();
  });

  it("reloads saved state when the current account's capability configuration changes", async () => {
    const view = render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenCalledOnce());

    view.rerender(
      <CapabilityContext value={context(viewer)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );

    await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeDisabled();
  });

  it("keeps saved results and delegated search usable after available capability evidence expires", async () => {
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({
      value: [partialJob],
      count: 1,
      limit: 20,
      offset: 0,
    });
    const user = userEvent.setup();
    render(
      <CapabilityContext
        value={context(viewer, true, Date.parse("2026-09-08T14:00:00.001Z"))}
      >
        <PurviewAuditView />
      </CapabilityContext>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeEnabled());
    expect(screen.queryByRole("region", { name: "Audit Search authorization pending" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /View results 11111111/ }));
    expect(getPurviewAuditRecords).toHaveBeenCalledExactlyOnceWith(
      partialJob.id,
      100,
      0,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each(["", "not-a-date"])("rejects malformed approval expiry at the provider-start boundary (%j)", async expiresAt => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T13:05:00.000Z"));
    const approved = approvedQualification();
    vi.mocked(approvePurviewAuditQualification).mockResolvedValue(approved);
    vi.mocked(startPurviewAuditQualification).mockResolvedValue({ ...partialJob, status: "running", qualificationId: approved.id });
    render(<CapabilityContext value={context(administrator)}><PurviewAuditView /></CapabilityContext>);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve one narrow/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve qualification" }));
    await act(async () => {});
    const start = screen.getByRole("button", { name: "Run approved qualification" });
    // The handler must validate the current approval, not trust an already rendered button.
    approved.expiresAt = expiresAt;
    fireEvent.click(start);
    await act(async () => {});
    expect(startPurviewAuditQualification).not.toHaveBeenCalled();
  });

  it("does not run an approved qualification after its approval expires", async () => {
    vi.mocked(approvePurviewAuditQualification).mockResolvedValue({
      id: "qualification-expired",
      capabilityId: "purview.audit.search.delegated",
      tokenMode: "delegated",
      authorizationPrincipalId: "reader-a",
      resultScope: { kind: "principal", scopeId: "reader-a", configurationRevision: null },
      filters,
      status: "approved",
      contractRevision: "fixture-contract",
      permissionRevision: "fixture-permission",
      configurationRevision: 1,
      approvedBy: "reader-a",
      approvedAt: "2026-09-08T13:00:00.000Z",
      expiresAt: "2026-09-08T13:20:00.000Z",
      jobId: null,
    });
    const user = userEvent.setup();
    render(
      <CapabilityContext
        value={context(administrator, false, Date.parse("2026-09-08T13:30:00.000Z"))}
      >
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await user.selectOptions(await screen.findByLabelText("Authorization"), "application");
    await user.click(await screen.findByRole("checkbox", {
      name: "Approve one narrow remote query for contract qualification",
    }));
    await user.click(screen.getByRole("button", { name: "Approve qualification" }));

    expect(screen.queryByRole("button", { name: "Run approved qualification" })).not.toBeInTheDocument();
    expect(startPurviewAuditQualification).not.toHaveBeenCalled();
  });

  it.each(["timer", "suspended timer"] as const)(
    "expires newly received approvals using wall time with a stale capability clock (%s)", async phase => {
      vi.useFakeTimers();
      const access = context(administrator);
      vi.setSystemTime(new Date("2026-09-08T13:10:00.000Z"));
      const expiresAt = new Date(Date.now() + 1_000).toISOString();
      vi.mocked(approvePurviewAuditQualification).mockResolvedValue(approvedQualification({ expiresAt }));
      render(<CapabilityContext value={access}><PurviewAuditView /></CapabilityContext>);
      await act(async () => {});
      fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
      fireEvent.click(screen.getByRole("checkbox", { name: /Approve one narrow/ }));
      fireEvent.click(screen.getByRole("button", { name: "Approve qualification" }));
      await act(async () => {});
      const start = screen.getByRole("button", { name: "Run approved qualification" });
      if (phase === "timer") {
        await act(() => vi.advanceTimersByTimeAsync(1_001));
        expect(screen.queryByRole("button", { name: "Run approved qualification" })).not.toBeInTheDocument();
      } else {
        vi.setSystemTime(new Date(Date.parse(expiresAt) + 1));
        fireEvent.click(start);
        await act(async () => {});
      }
      expect(startPurviewAuditQualification).not.toHaveBeenCalled();
      expect(getPurviewAuditCatalog).toHaveBeenCalledOnce();
      expect(access.reload).not.toHaveBeenCalled();
    },
  );

  it("invalidates approval and qualification when exact filters change", async () => {
    vi.mocked(approvePurviewAuditQualification).mockImplementation(
      async (tokenMode, approvedFilters) => ({
        id: "qualification-filter-bound",
        capabilityId: "purview.audit.search.delegated",
        tokenMode,
        authorizationPrincipalId: "reader-a",
        resultScope: { kind: "principal", scopeId: "reader-a", configurationRevision: null },
        filters: approvedFilters,
        status: "approved",
        contractRevision: "fixture-contract",
        permissionRevision: "fixture-permission",
        configurationRevision: 1,
        approvedBy: "reader-a",
        approvedAt: "2026-09-08T13:00:00.000Z",
        expiresAt: "2026-09-08T13:20:00.000Z",
        jobId: null,
      }),
    );
    const user = userEvent.setup();
    render(
      <CapabilityContext value={context(administrator)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await user.selectOptions(await screen.findByLabelText("Authorization"), "application");
    const approval = await screen.findByRole("checkbox", {
      name: "Approve one narrow remote query for contract qualification",
    });
    await user.click(approval);
    await user.click(screen.getByRole("button", { name: "Approve qualification" }));
    expect(await screen.findByRole("button", { name: "Run approved qualification" })).toBeVisible();

    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-08T10:30" } });

    expect(approval).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "Run approved qualification" })).not.toBeInTheDocument();
  });

  it("ignores an active-job poll that resolves after the account changes", async () => {
    vi.useFakeTimers();
    let resolveStalePoll!: (value: Awaited<ReturnType<typeof getPurviewAuditJobs>>) => void;
    const runningJob: PurviewAuditJob = {
      ...partialJob,
      status: "running",
      providerStatus: "running",
      finishedAt: null,
    };
    const currentUser: SessionUser = {
      ...viewer,
      homeAccountId: "reader-b",
      username: "reader-b@example.invalid",
    };
    vi.mocked(getPurviewAuditJobs)
      .mockResolvedValueOnce({ value: [runningJob], count: 1, limit: 20, offset: 0 })
      .mockReturnValueOnce(new Promise((resolve) => { resolveStalePoll = resolve; }))
      .mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 });
    const view = render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await act(async () => {});
    expect(screen.getByRole("button", { name: /Cancel local polling 11111111/ })).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2);

    view.rerender(
      <CapabilityContext value={context(currentUser, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await act(async () => {});
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(3);
    await act(async () => {
      resolveStalePoll({ value: [runningJob], count: 1, limit: 20, offset: 0 });
    });

    expect(screen.queryByRole("button", { name: /Cancel local polling 11111111/ })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(3);
  });

  it("clears selected results when refreshed history no longer contains the job", async () => {
    vi.mocked(getPurviewAuditJobs)
      .mockResolvedValueOnce({ value: [partialJob], count: 1, limit: 20, offset: 0 })
      .mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockResolvedValue({
      value: [],
      count: 0,
      limit: 100,
      offset: 0,
      job: partialJob,
    });
    const user = userEvent.setup();
    render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await user.click(await screen.findByRole("button", { name: /View results 11111111/ }));
    expect(await screen.findByRole("heading", { name: "Minimized results" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Refresh Audit Search history" }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Minimized results" })).not.toBeInTheDocument();
    });
  });

  it("fails closed when refreshed saved history is no longer authorized", async () => {
    vi.mocked(getPurviewAuditJobs)
      .mockResolvedValueOnce({ value: [partialJob], count: 1, limit: 20, offset: 0 })
      .mockRejectedValueOnce(new ApiError(403, "forbidden", "Saved audit access denied"));
    const user = userEvent.setup();
    render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    expect(await screen.findByRole("button", { name: /View results 11111111/ })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Refresh Audit Search history" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Saved audit access denied");
    expect(screen.queryByRole("button", { name: /View results 11111111/ })).not.toBeInTheDocument();
    expect(screen.getByText("Audit Search history unavailable")).toBeVisible();
  });

  it("distinguishes failed bootstrap from empty history and retries the complete catalog/history read", async () => {
    vi.mocked(getPurviewAuditCatalog).mockRejectedValueOnce(new Error("Catalog unavailable")).mockResolvedValue(catalog);
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Catalog unavailable");
    expect(screen.queryByText("No Audit Search history")).not.toBeInTheDocument();
    expect(screen.getByText("Unknown jobs")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Refresh Audit Search history" }));
    await waitFor(() => expect(getPurviewAuditCatalog).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No Audit Search history")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("withholds old records during a replacement page and invalidates it when filters change", async () => {
    const second = { ...partialJob, id: "22222222-2222-4222-8222-222222222222" };
    let finish!: (value: PurviewAuditRecordPage) => void;
    let signal!: AbortSignal;
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob, second], count: 2, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockResolvedValueOnce(recordPage())
      .mockImplementationOnce((_id, _limit, _offset, options) => {
        signal = options!.signal!;
        return new Promise(resolve => { finish = resolve; });
      });
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", { name: /View results 11111111/ }));
    expect(await screen.findByText("Selected record actor")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /View results 22222222/ }));
    expect(screen.queryByText("Selected record actor")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-08T10:30" } });
    expect(signal.aborted).toBe(true);
    await act(async () => finish(recordPage(second, "Obsolete filtered actor")));
    expect(screen.queryByRole("heading", { name: "Minimized results" })).not.toBeInTheDocument();
    expect(screen.queryByText("Obsolete filtered actor")).not.toBeInTheDocument();
  });

  it.each(["refresh", "history"] as const)("lets independent %s reads finish after draft edits", async action => {
    let finish!: (value: Awaited<ReturnType<typeof getPurviewAuditJobs>>) => void;
    let signal!: AbortSignal;
    const history = { value: [partialJob], count: 21, limit: 20, offset: 0 };
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce(history)
      .mockImplementationOnce((_limit, _offset, options) => {
        signal = options!.signal!;
        return new Promise(resolve => { finish = resolve; });
      });
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", {
      name: action === "refresh" ? "Refresh Audit Search history" : "Next Audit Search history page",
    }));
    await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-08T10:00" } });
    expect(signal.aborted).toBe(false);
    await act(async () => finish({ ...history, offset: action === "history" ? 20 : 0 }));
    expect(screen.queryByText("Loading Audit Search history...")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "Minimized results" })).not.toBeInTheDocument();
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2);
  });

  it("retires selected-job revalidation without cancelling independent refreshed history after draft edits", async () => {
    const waiting = { ...partialJob, status: "waiting_authorization" as const, canResume: true };
    const history = { value: [partialJob], count: 1, limit: 20, offset: 0 };
    let finishHistory!: (value: typeof history) => void;
    let rejectJob!: (error: Error) => void;
    let historySignal!: AbortSignal;
    let jobSignal!: AbortSignal;
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce({ ...history, value: [waiting] })
      .mockResolvedValueOnce(history)
      .mockImplementationOnce((_limit, _offset, options) => {
        historySignal = options!.signal!;
        return new Promise(resolve => { finishHistory = resolve; });
      });
    vi.mocked(resumePurviewAuditSearch).mockResolvedValue(partialJob);
    vi.mocked(getPurviewAuditJob).mockImplementation((_id, options) => {
      jobSignal = options!.signal!;
      return new Promise((_resolve, reject) => { rejectJob = reject; });
    });
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", { name: /Resume search/ }));
    await screen.findByRole("button", { name: /View results/ });
    await userEvent.click(screen.getByRole("button", { name: "Refresh Audit Search history" }));
    await waitFor(() => expect(getPurviewAuditJob).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-08T10:30" } });
    expect(jobSignal.aborted).toBe(true);
    expect(historySignal.aborted).toBe(false);
    expect(screen.getByText("Loading Audit Search history...")).toBeVisible();
    await act(async () => finishHistory(history));
    expect(screen.queryByText("Loading Audit Search history...")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Minimized results" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /View results/ })).toBeEnabled();
    await act(async () => rejectJob(new ApiError(404, "not_found", "Retired saved selection")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeEnabled();
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(3);
    expect(getPurviewAuditCatalog).toHaveBeenCalledTimes(2);
    expect(resumePurviewAuditSearch).toHaveBeenCalledOnce();
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("cancels a deselected exact-job poll while continuing independent history polling", async () => {
    vi.useFakeTimers();
    const selectedJob = { ...partialJob, status: "running" as const, finishedAt: null };
    const otherJob = { ...selectedJob, id: "22222222-2222-4222-8222-222222222222" };
    let rejectJob!: (error: Error) => void;
    let signal!: AbortSignal;
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [otherJob], count: 1, limit: 20, offset: 0 });
    vi.mocked(submitPurviewAuditSearch).mockResolvedValue(selectedJob);
    vi.mocked(getPurviewAuditJob).mockImplementation((_id, options) => {
      signal = options!.signal!;
      return new Promise((_resolve, reject) => { rejectJob = reject; });
    });
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Run Audit Search" }));
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(getPurviewAuditJob).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-08T10:30" } });
    expect(signal.aborted).toBe(true);
    await act(async () => rejectJob(new ApiError(404, "not_found", "Retired saved selection")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Minimized results" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel local polling 22222222/ })).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(4);
    expect(getPurviewAuditJob).toHaveBeenCalledOnce();
    expect(submitPurviewAuditSearch).toHaveBeenCalledOnce();
  });

  it("does not restore a cleared selection after a refreshed history page is clamped", async () => {
    let finish!: (value: Awaited<ReturnType<typeof getPurviewAuditJobs>>) => void;
    const other = { ...partialJob, id: "22222222-2222-4222-8222-222222222222" };
    const waiting = { ...partialJob, status: "waiting_authorization" as const, canResume: true };
    vi.mocked(resumePurviewAuditSearch).mockResolvedValue(partialJob);
    vi.mocked(getPurviewAuditJob).mockResolvedValue(partialJob);
    vi.mocked(getPurviewAuditJobs)
      .mockResolvedValueOnce({ value: [other], count: 21, limit: 20, offset: 0 })
      .mockResolvedValueOnce({ value: [waiting], count: 21, limit: 20, offset: 20 })
      .mockResolvedValueOnce({ value: [partialJob], count: 21, limit: 20, offset: 20 })
      .mockResolvedValueOnce({ value: [], count: 1, limit: 20, offset: 20 })
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", { name: "Next Audit Search history page" }));
    await userEvent.click(await screen.findByRole("button", { name: /Resume search/ }));
    await screen.findByRole("heading", { name: "Minimized results" });
    await userEvent.click(screen.getByRole("button", { name: "Refresh Audit Search history" }));
    await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenCalledTimes(5));
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-08T10:30" } });
    await act(async () => finish({ value: [partialJob], count: 1, limit: 20, offset: 0 }));
    expect(screen.queryByText("Loading Audit Search history...")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Minimized results" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /View results/ })).toBeEnabled();
  });

  it.each(["resume", "cancel", "delete", "export"] as const)("keeps admitted %s ownership across draft edits", async action => {
    const running = { ...partialJob, status: "running" as const };
    const job = action === "resume" ? { ...partialJob, status: "waiting_authorization" as const, canResume: true }
      : action === "cancel" ? running : partialJob;
    const refreshed = action === "resume" ? running : { ...partialJob, status: "cancelled" as const };
    let finish!: () => void;
    let signal!: AbortSignal;
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce({ value: [job], count: 1, limit: 20, offset: 0 })
      .mockResolvedValue({ value: action === "delete" ? [] : [refreshed], count: action === "delete" ? 0 : 1, limit: 20, offset: 0 });
    const command = action === "resume" ? resumePurviewAuditSearch : cancelPurviewAuditSearch;
    if (action === "resume" || action === "cancel") {
      vi.mocked(command).mockImplementation((_id, options) => {
        signal = options!.signal!;
        return new Promise(resolve => { finish = () => resolve(refreshed); });
      });
    } else if (action === "delete") {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      vi.mocked(deletePurviewAuditSearch).mockImplementation((_id, options) => {
        signal = options!.signal!;
        return new Promise(resolve => { finish = resolve; });
      });
    } else {
      vi.mocked(downloadPurviewAuditCsv).mockImplementation((_id, options) => {
        signal = options!.signal!;
        return new Promise(resolve => { finish = () => resolve(new Blob(["saved"])); });
      });
    }
    const createUrl = vi.fn(() => "blob:purview-draft");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createUrl;
      static revokeObjectURL = vi.fn();
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
      const name = action === "resume" ? /Resume search/ : action === "cancel" ? /Cancel local polling/
        : action === "delete" ? /Delete local cache/ : /Export results/;
      await userEvent.click(await screen.findByRole("button", { name }));
      fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-08T10:30" } });
      expect(signal.aborted).toBe(false);
      expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeDisabled();
      if (action === "export") expect(screen.getByRole("status")).toHaveTextContent("Exporting saved Audit Search results");
      await act(async () => finish());
      expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeEnabled();
      expect(screen.queryByRole("heading", { name: "Minimized results" })).not.toBeInTheDocument();
      expect(getPurviewAuditJobs).toHaveBeenCalledTimes(action === "export" ? 1 : 2);
      if (action === "export") {
        expect(createUrl).toHaveBeenCalledOnce();
        expect(click).toHaveBeenCalledOnce();
        await waitFor(() => expect(document.querySelector("a[download]")).toBeNull());
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("admits a detail selection once before React disables competing result buttons", async () => {
    const second = { ...partialJob, id: "22222222-2222-4222-8222-222222222222" };
    let finish!: (value: PurviewAuditRecordPage) => void;
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob, second], count: 2, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    const firstButton = await screen.findByRole("button", { name: /View results 11111111/ });
    const secondButton = screen.getByRole("button", { name: /View results 22222222/ });
    act(() => { firstButton.click(); secondButton.click(); });
    const detail = screen.getByRole("heading", { name: "Minimized results" }).closest("section")!;
    expect(firstButton.closest("tr")).toHaveClass("selected-row");
    expect(secondButton.closest("tr")).not.toHaveClass("selected-row");
    expect(within(detail).getByRole("status")).toHaveTextContent("Loading minimized results");
    expect(getPurviewAuditRecords).toHaveBeenCalledOnce();
    expect(getPurviewAuditRecords).toHaveBeenCalledWith(partialJob.id, 100, 0, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await act(async () => finish(recordPage()));
    expect(await screen.findByText("Selected record actor")).toBeVisible();
  });

  it("shares equivalent pending detail reads without cancelling another active reader", async () => {
    const client = createSavedQueryClient();
    const value = context(viewer, true);
    let finish!: (value: PurviewAuditRecordPage) => void;
    let signal!: AbortSignal;
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockImplementation((_id, _limit, _offset, options) => {
      signal = options!.signal!;
      return new Promise(resolve => { finish = resolve; });
    });
    const ui = (firstActive: boolean) => <SavedQueryProvider client={client}><CapabilityContext value={value}>
      <section aria-label="First reader"><PurviewAuditView active={firstActive} /></section>
      <section aria-label="Second reader"><PurviewAuditView /></section>
    </CapabilityContext></SavedQueryProvider>;
    const view = render(ui(true));
    try {
      const first = within(screen.getByRole("region", { name: "First reader" }));
      const second = within(screen.getByRole("region", { name: "Second reader" }));
      await userEvent.click(await first.findByRole("button", { name: /View results/ }));
      await userEvent.click(await second.findByRole("button", { name: /View results/ }));
      expect(getPurviewAuditRecords).toHaveBeenCalledOnce();
      view.rerender(ui(false));
      expect(signal.aborted).toBe(false);
      await act(async () => finish(recordPage()));
      expect(await second.findByText("Selected record actor")).toBeVisible();
      expect(first.queryByText("Selected record actor")).not.toBeInTheDocument();
    } finally {
      view.unmount();
      client.clear();
    }
  });

  it("does not join a pending record read from an older saved job version", async () => {
    const client = createSavedQueryClient();
    const value = context(viewer, true);
    const updatedJob = { ...partialJob, updatedAt: "2026-09-08T13:04:00.000Z" };
    let finishOld!: (page: PurviewAuditRecordPage) => void;
    let oldSignal!: AbortSignal;
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce({ value: [partialJob], count: 1, limit: 20, offset: 0 })
      .mockResolvedValue({ value: [updatedJob], count: 1, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockImplementationOnce((_id, _limit, _offset, options) => {
      oldSignal = options!.signal!;
      return new Promise(resolve => { finishOld = resolve; });
    }).mockResolvedValue(recordPage(updatedJob, "Current saved actor"));
    const ui = (secondMounted: boolean) => <SavedQueryProvider client={client}><CapabilityContext value={value}>
      <section aria-label="First reader"><PurviewAuditView /></section>
      {secondMounted ? <section aria-label="Second reader"><PurviewAuditView /></section> : null}
    </CapabilityContext></SavedQueryProvider>;
    const view = render(ui(false));
    try {
      const first = within(screen.getByRole("region", { name: "First reader" }));
      await userEvent.click(await first.findByRole("button", { name: /View results/ }));
      view.rerender(ui(true));
      const second = within(screen.getByRole("region", { name: "Second reader" }));
      await userEvent.click(await second.findByRole("button", { name: /View results/ }));
      expect(getPurviewAuditRecords).toHaveBeenCalledTimes(2);
      expect(await second.findByText("Current saved actor")).toBeVisible();
      expect(oldSignal.aborted).toBe(false);
      await act(async () => finishOld(recordPage(partialJob, "Older saved actor")));
      expect(await first.findByText("Older saved actor")).toBeVisible();
      expect(second.queryByText("Older saved actor")).not.toBeInTheDocument();
      expect(second.getByText("Current saved actor")).toBeVisible();
    } finally {
      view.unmount();
      client.clear();
    }
  });

  it("updates history actions when a record read reveals a changed job state", async () => {
    const running = { ...partialJob, status: "running" as const, updatedAt: "2026-09-08T13:04:00.000Z", finishedAt: null };
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockResolvedValue(recordPage(running));
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", { name: /View results/ }));
    await waitFor(() => expect(screen.queryByText("Loading minimized results...")).not.toBeInTheDocument());
    expect(screen.queryByText("Selected record actor")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: /View results|Export results|Delete local cache/ })).toEqual([]);
    expect(screen.getByRole("button", { name: /Cancel local polling/ })).toBeEnabled();
    expect(getPurviewAuditJobs).toHaveBeenCalledOnce();
    expect(getPurviewAuditRecords).toHaveBeenCalledOnce();
  });

  it.each([
    { action: "export", error: new ApiError(404, "not_found", "Saved job unavailable") },
    { action: "resume", error: new ApiError(404, "not_found", "Saved job unavailable") },
    { action: "cancel", error: new ApiError(404, "not_found", "Saved job unavailable") },
    { action: "delete", error: new ApiError(404, "not_found", "Saved job unavailable") },
    { action: "resume", error: new ApiError(409, "application_scope_changed", "Saved scope changed") },
    { action: "delete", error: new ApiError(409, "audit_job_state", "Saved job changed") },
  ] as const)("withdraws stale saved evidence after $action rejects it with $error.code", async ({ action, error }) => {
    const job = action === "resume" ? { ...partialJob, canResume: true }
      : action === "cancel" ? { ...partialJob, status: "running" as const } : partialJob;
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce({ value: [job], count: 1, limit: 20, offset: 0 })
      .mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditRecords).mockResolvedValue(recordPage(job));
    const command = action === "export" ? downloadPurviewAuditCsv : action === "resume" ? resumePurviewAuditSearch
      : action === "cancel" ? cancelPurviewAuditSearch : deletePurviewAuditSearch;
    vi.mocked(command).mockRejectedValue(error);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    const name = action === "resume" ? /Resume search/ : action === "cancel" ? /Cancel local polling/
      : action === "delete" ? /Delete local cache/ : /Export results/;
    await screen.findByRole("button", { name });
    if (action !== "cancel") {
      await userEvent.click(screen.getByRole("button", { name: /View results/ }));
      expect(await screen.findByText("Selected record actor")).toBeVisible();
    }
    await userEvent.click(screen.getByRole("button", { name }));
    expect(await screen.findByRole("alert")).toHaveTextContent(error.message);
    expect(screen.queryByText("Selected record actor")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.getByText("Audit Search history unavailable")).toBeVisible();
    expect(screen.queryByText("No Audit Search history")).not.toBeInTheDocument();
    expect(command).toHaveBeenCalledOnce();
    expect(getPurviewAuditJobs).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Refresh Audit Search history" }));
    expect(await screen.findByText("No Audit Search history")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(command).toHaveBeenCalledOnce();
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2);
    expect(getPurviewAuditCatalog).toHaveBeenCalledTimes(2);
  });

  it("clears a retired read error when returning to successfully revalidated saved history", async () => {
    const value = context(viewer, true);
    vi.mocked(getPurviewAuditJobs).mockRejectedValueOnce(new Error("History temporarily unavailable"))
      .mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
    const view = render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    expect(await screen.findByRole("alert")).toHaveTextContent("History temporarily unavailable");
    view.rerender(<CapabilityContext value={value}><PurviewAuditView active={false} /></CapabilityContext>);
    view.rerender(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("refreshes qualification readiness from the exact completed job (in history: %s)", async inHistory => {
    vi.useFakeTimers();
    const value = context(administrator);
    const running = { ...partialJob, status: "running" as const, qualificationId: "qualification-a" };
    const succeeded = { ...running, status: "succeeded" as const };
    vi.mocked(approvePurviewAuditQualification).mockResolvedValue(approvedQualification());
    vi.mocked(startPurviewAuditQualification).mockResolvedValue(running);
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 })
      .mockResolvedValue({ value: inHistory ? [running] : [], count: inHistory ? 1 : 0, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditJob).mockResolvedValueOnce(running).mockResolvedValue(succeeded);
    render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "application" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Approve one narrow/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve qualification" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Run approved qualification" }));
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(getPurviewAuditJob).toHaveBeenCalledTimes(inHistory ? 0 : 1);
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: inHistory ? [succeeded] : [], count: inHistory ? 1 : 0, limit: 20, offset: 0 });
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(value.reload).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(value.reload).toHaveBeenCalledOnce();
    expect(startPurviewAuditQualification).toHaveBeenCalledOnce();
  });

  it("never claims complete coverage for an empty partial result", async () => {
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", { name: /View results 11111111/ }));
    expect(await screen.findByText("No matching metadata records")).toBeVisible();
    expect(screen.queryByText("The provider lifecycle completed for the requested range.")).not.toBeInTheDocument();
    expect(screen.getByText(/Empty saved results do not establish complete coverage/)).toBeVisible();
  });

  it("retains authorized history and other owners' shared reads after live provider admission fails", async () => {
    const client = createSavedQueryClient();
    const outside = new AbortController();
    let finish!: (value: string) => void;
    let sharedSignal!: AbortSignal;
    const shared = readSavedQuery(client, ["other-saved-source"], signal => {
      sharedSignal = signal;
      return new Promise<string>(resolve => { finish = resolve; });
    }, outside.signal);
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    vi.mocked(submitPurviewAuditSearch).mockRejectedValue(new ApiError(403, "capability_unavailable", "Provider permission expired"));
    const view = render(<SavedQueryProvider client={client}>
      <CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>
    </SavedQueryProvider>);
    try {
      await screen.findByRole("button", { name: /View results 11111111/ });
      await userEvent.click(screen.getByRole("button", { name: "Run Audit Search" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Provider permission expired");
      expect(screen.getByRole("button", { name: /View results 11111111/ })).toBeEnabled();
      expect(sharedSignal.aborted).toBe(false);
      await act(async () => {
        finish("unrelated saved evidence");
        await expect(shared).resolves.toBe("unrelated saved evidence");
      });
    } finally {
      const settled = shared.catch(() => undefined);
      outside.abort();
      view.unmount();
      client.clear();
      await settled;
    }
  });

  it("enforces current authorization and operations in the form handler, not only the button", async () => {
    vi.mocked(getPurviewAuditCatalog).mockResolvedValue({ ...catalog,
      presets: catalog.presets.map(preset => preset.id === "copilot_studio_admin" ? { ...preset, operations: [] } : preset) });
    const view = render(<CapabilityContext value={context(viewer)}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    fireEvent.submit(screen.getByRole("button", { name: "Run Audit Search" }).closest("form")!);
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
    view.rerender(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    await userEvent.selectOptions(screen.getByLabelText("Log type"), "copilot_studio_admin");
    fireEvent.submit(screen.getByRole("button", { name: "Run Audit Search" }).closest("form")!);
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("stops failed polling and resumes only after an explicit complete refresh", async () => {
    vi.useFakeTimers();
    const running = { ...partialJob, status: "running" as const, finishedAt: null };
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce({ value: [running], count: 1, limit: 20, offset: 0 })
      .mockRejectedValueOnce(new Error("Polling unavailable"))
      .mockResolvedValue({ value: [running], count: 1, limit: 20, offset: 0 });
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByRole("alert")).toHaveTextContent("Polling unavailable");
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Refresh Audit Search history" }));
    await act(async () => {});
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(4);
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("loads current saved evidence under real StrictMode without creating provider work", async () => {
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>, true);
    expect(await screen.findByRole("button", { name: /View results 11111111/ })).toBeVisible();
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("fences a pending history poll and makes a fresh saved request after deletion", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const running = { ...partialJob, id: "22222222-2222-4222-8222-222222222222", status: "running" as const, finishedAt: null };
    const history = { value: [partialJob, running], count: 2, limit: 20, offset: 0 };
    let finish!: (value: typeof history) => void;
    let signal!: AbortSignal;
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce(history)
      .mockImplementationOnce((_limit, _offset, options) => {
        signal = options!.signal!;
        return new Promise(resolve => { finish = resolve; });
      }).mockResolvedValue({ value: [running], count: 1, limit: 20, offset: 0 });
    vi.mocked(deletePurviewAuditSearch).mockResolvedValue(undefined);
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    fireEvent.click(screen.getByRole("button", { name: /Delete local cache 11111111/ }));
    await act(async () => {});
    expect(signal.aborted).toBe(true);
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("button", { name: /View results 11111111/ })).not.toBeInTheDocument();
    await act(async () => finish(history));
    expect(screen.queryByRole("button", { name: /View results 11111111/ })).not.toBeInTheDocument();
  });

  it("does not reattach a post-delete read to another consumer's shared refresh", async () => {
    const client = createSavedQueryClient();
    const history = { value: [partialJob], count: 1, limit: 20, offset: 0 };
    let phase: "initial" | "old" | "fresh" = "initial";
    let finish!: (value: typeof history) => void;
    let oldSignal!: AbortSignal;
    const oldRead = new Promise<typeof history>(resolve => { finish = resolve; });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(deletePurviewAuditSearch).mockResolvedValue(undefined);
    vi.mocked(getPurviewAuditJobs).mockImplementation((_limit, _offset, options) => {
      if (phase === "old") {
        oldSignal = options!.signal!;
        return oldRead;
      }
      return Promise.resolve(phase === "fresh" ? { ...history, value: [], count: 0 } : history);
    });
    const view = render(<SavedQueryProvider client={client}><CapabilityContext value={context(viewer, true)}>
      <section aria-label="First audit investigation"><PurviewAuditView /></section>
      <section aria-label="Second audit investigation"><PurviewAuditView /></section>
    </CapabilityContext></SavedQueryProvider>);
    try {
      const first = within(screen.getByRole("region", { name: "First audit investigation" }));
      const second = within(screen.getByRole("region", { name: "Second audit investigation" }));
      await first.findByRole("button", { name: /View results 11111111/ });
      await second.findByRole("button", { name: /View results 11111111/ });
      const initialCalls = vi.mocked(getPurviewAuditJobs).mock.calls.length;
      phase = "old";
      await userEvent.click(first.getByRole("button", { name: "Refresh Audit Search history" }));
      expect(getPurviewAuditJobs).toHaveBeenCalledTimes(initialCalls + 1);
      phase = "fresh";
      await userEvent.click(second.getByRole("button", { name: /Delete local cache 11111111/ }));
      await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenCalledTimes(initialCalls + 2));
      expect(await second.findByText("No Audit Search history")).toBeVisible();
      expect(oldSignal.aborted).toBe(false);
      await act(async () => finish(history));
      expect(await first.findByRole("button", { name: /View results 11111111/ })).toBeVisible();
      expect(second.queryByRole("button", { name: /View results 11111111/ })).not.toBeInTheDocument();
    } finally {
      view.unmount();
      client.clear();
    }
  });

  it("keeps post-delete polling in its new revision while another owner retains a shared poll", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const client = createSavedQueryClient();
    const outside = new AbortController();
    const running = { ...partialJob, id: "22222222-2222-4222-8222-222222222222", status: "running" as const };
    const oldHistory = { value: [partialJob, running], count: 2, limit: 20, offset: 0 };
    const freshHistory = { value: [running], count: 1, limit: 20, offset: 0 };
    let finish!: (value: typeof oldHistory) => void;
    let oldSignal!: AbortSignal;
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce(oldHistory)
      .mockImplementationOnce((_limit, _offset, options) => {
        oldSignal = options!.signal!;
        return new Promise(resolve => { finish = resolve; });
      }).mockResolvedValue(freshHistory);
    vi.mocked(deletePurviewAuditSearch).mockResolvedValue(undefined);
    const view = render(<SavedQueryProvider client={client}>
      <CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>
    </SavedQueryProvider>);
    let shared: Promise<typeof oldHistory> | undefined;
    try {
      await act(async () => {});
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      const oldQuery = client.getQueryCache().getAll().find(query => query.queryKey[1] === "purview-audit-jobs")!;
      shared = readSavedQuery(client, oldQuery.queryKey.slice(1),
        signal => getPurviewAuditJobs(20, 0, { signal, userPrincipalName: viewer.username }), outside.signal);
      expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2);
      expect(oldQuery?.getObserversCount()).toBe(2);
      fireEvent.click(screen.getByRole("button", { name: /Delete local cache 11111111/ }));
      await act(async () => {});
      expect(getPurviewAuditJobs).toHaveBeenCalledTimes(3);
      expect(oldQuery?.getObserversCount()).toBe(1);
      expect(oldSignal.aborted).toBe(false);
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(getPurviewAuditJobs).toHaveBeenCalledTimes(4);
      expect(oldQuery?.getObserversCount()).toBe(1);
      expect(oldSignal.aborted).toBe(false);
      await act(async () => {
        finish(oldHistory);
        await expect(shared).resolves.toEqual(oldHistory);
      });
      expect(screen.queryByRole("button", { name: /View results 11111111/ })).not.toBeInTheDocument();
    } finally {
      const settled = shared?.catch(() => undefined);
      outside.abort();
      view.unmount();
      client.clear();
      await settled;
    }
  });

  it("clamps a deleted final history page to the last authoritative server page", async () => {
    const last = { ...partialJob, id: "22222222-2222-4222-8222-222222222222" };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce({ value: [partialJob], count: 21, limit: 20, offset: 0 })
      .mockResolvedValueOnce({ value: [last], count: 21, limit: 20, offset: 20 })
      .mockResolvedValueOnce({ value: [], count: 20, limit: 20, offset: 20 })
      .mockResolvedValueOnce({ value: [partialJob], count: 20, limit: 20, offset: 0 });
    vi.mocked(deletePurviewAuditSearch).mockResolvedValue(undefined);
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await userEvent.click(await screen.findByRole("button", { name: "Next Audit Search history page" }));
    await userEvent.click(await screen.findByRole("button", { name: /Delete local cache 22222222/ }));
    expect(await screen.findByRole("button", { name: /View results 11111111/ })).toBeVisible();
    expect(getPurviewAuditJobs).toHaveBeenLastCalledWith(20, 0, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.queryByText("No Audit Search history")).not.toBeInTheDocument();
  });

  it.each([false, true])("keeps its polling budget across passive history transitions (frozen clock: %s)", async frozenClock => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    if (frozenClock) vi.spyOn(Date, "now").mockReturnValue(startedAt);
    const running = { ...partialJob, status: "running" as const, finishedAt: null };
    const terminal = { ...partialJob, id: "22222222-2222-4222-8222-222222222222" };
    const requestTimes: number[] = [];
    vi.mocked(getPurviewAuditJobs).mockImplementation(async (_limit, offset = 0) => {
      requestTimes.push(Date.now());
      return { value: [offset ? terminal : running], count: 21, limit: 20, offset };
    });
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(285_000));
    fireEvent.click(screen.getByRole("button", { name: "Next Audit Search history page" }));
    await act(async () => {});
    const inactiveCount = requestTimes.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(requestTimes).toHaveLength(inactiveCount);
    fireEvent.click(screen.getByRole("button", { name: "Previous Audit Search history page" }));
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.getByText(/Automatic history refresh paused/)).toBeVisible();
    if (frozenClock) expect(requestTimes).toHaveLength(153);
    else expect(requestTimes.filter(time => time >= startedAt + 300_000)).toEqual([]);

    const pausedCount = requestTimes.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh Audit Search history" }));
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(requestTimes).toHaveLength(pausedCount + 2);
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("pauses the bounded polling budget until a manual refresh starts a new budget", async () => {
    vi.useFakeTimers();
    const running = { ...partialJob, status: "running" as const, finishedAt: null };
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [running], count: 1, limit: 20, offset: 0 });
    render(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(300_000));
    expect(screen.getByText(/Automatic history refresh paused/)).toBeVisible();
    const count = vi.mocked(getPurviewAuditJobs).mock.calls.length;
    expect(count).toBeLessThanOrEqual(151);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(count);
    fireEvent.click(screen.getByRole("button", { name: "Refresh Audit Search history" }));
    await act(async () => {});
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(count + 2);
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
  });

  it("reports failed qualification-readiness refresh and retries it manually without another provider start", async () => {
    const value = context(administrator);
    value.reload.mockRejectedValueOnce(new Error("Readiness unavailable")).mockResolvedValue(undefined);
    vi.mocked(approvePurviewAuditQualification).mockResolvedValue(approvedQualification());
    const succeeded = { ...partialJob, status: "succeeded" as const, qualificationId: "qualification-a" };
    vi.mocked(startPurviewAuditQualification).mockResolvedValue(succeeded);
    vi.mocked(getPurviewAuditJobs).mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 })
      .mockResolvedValue({ value: [succeeded], count: 1, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditJob).mockResolvedValue(succeeded);
    render(<CapabilityContext value={value}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    await userEvent.selectOptions(screen.getByLabelText("Authorization"), "application");
    await userEvent.click(screen.getByRole("checkbox", { name: /Approve one narrow/ }));
    await userEvent.click(screen.getByRole("button", { name: "Approve qualification" }));
    await userEvent.click(await screen.findByRole("button", { name: "Run approved qualification" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Readiness unavailable");
    expect(value.reload).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Refresh Audit Search history" }));
    await waitFor(() => expect(value.reload).toHaveBeenCalledTimes(2));
    expect(startPurviewAuditQualification).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores a qualification approval that resolves after the account changes", async () => {
    let resolveStaleApproval!: (value: PurviewAuditQualification) => void;
    const currentAdmin: SessionUser = {
      ...administrator,
      homeAccountId: "reader-b",
      username: "reader-b@example.invalid",
    };
    vi.mocked(approvePurviewAuditQualification).mockReturnValueOnce(
      new Promise((resolve) => { resolveStaleApproval = resolve; }),
    );
    const user = userEvent.setup();
    const view = render(
      <CapabilityContext value={context(administrator)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await user.selectOptions(await screen.findByLabelText("Authorization"), "application");
    await user.click(await screen.findByRole("checkbox", {
      name: "Approve one narrow remote query for contract qualification",
    }));
    await user.click(screen.getByRole("button", { name: "Approve qualification" }));
    await waitFor(() => expect(approvePurviewAuditQualification).toHaveBeenCalledOnce());

    view.rerender(
      <CapabilityContext value={context(currentAdmin)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await act(async () => {
      resolveStaleApproval(approvedQualification());
    });

    expect(screen.queryByRole("button", { name: "Run approved qualification" })).not.toBeInTheDocument();
  });

  it("ignores a qualification job that starts after the account changes", async () => {
    let resolveStaleStart!: (value: PurviewAuditJob) => void;
    const currentAdmin: SessionUser = {
      ...administrator,
      homeAccountId: "reader-b",
      username: "reader-b@example.invalid",
    };
    vi.mocked(approvePurviewAuditQualification).mockResolvedValue(
      approvedQualification(),
    );
    vi.mocked(startPurviewAuditQualification).mockReturnValueOnce(
      new Promise((resolve) => { resolveStaleStart = resolve; }),
    );
    const user = userEvent.setup();
    const view = render(
      <CapabilityContext value={context(administrator)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await user.selectOptions(await screen.findByLabelText("Authorization"), "application");
    await user.click(await screen.findByRole("checkbox", {
      name: "Approve one narrow remote query for contract qualification",
    }));
    await user.click(screen.getByRole("button", { name: "Approve qualification" }));
    await user.click(await screen.findByRole("button", { name: "Run approved qualification" }));
    await waitFor(() => expect(startPurviewAuditQualification).toHaveBeenCalledOnce());

    view.rerender(
      <CapabilityContext value={context(currentAdmin)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await act(async () => {
      resolveStaleStart({ ...partialJob, status: "running", finishedAt: null });
    });

    expect(screen.queryByRole("heading", { name: "Minimized results" })).not.toBeInTheDocument();
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      action: "resume" as const,
      job: { ...partialJob, canResume: true },
      buttonName: /Resume search 11111111/,
    },
    {
      action: "cancel" as const,
      job: { ...partialJob, status: "running" as const, finishedAt: null },
      buttonName: /Cancel local polling 11111111/,
    },
    {
      action: "delete" as const,
      job: partialJob,
      buttonName: /Delete local cache 11111111/,
    },
  ])("ignores a late $action callback after the account changes", async ({
    action,
    buttonName,
    job,
  }) => {
    let resolveJob!: (value: PurviewAuditJob) => void;
    let resolveDelete!: () => void;
    const currentUser: SessionUser = {
      ...viewer,
      homeAccountId: "reader-b",
      username: "reader-b@example.invalid",
    };
    vi.mocked(getPurviewAuditJobs)
      .mockResolvedValueOnce({ value: [job], count: 1, limit: 20, offset: 0 })
      .mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 });
    if (action === "resume") {
      vi.mocked(resumePurviewAuditSearch).mockReturnValueOnce(
        new Promise((resolve) => { resolveJob = resolve; }),
      );
    } else if (action === "cancel") {
      vi.mocked(cancelPurviewAuditSearch).mockReturnValueOnce(
        new Promise((resolve) => { resolveJob = resolve; }),
      );
    } else {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      vi.mocked(deletePurviewAuditSearch).mockReturnValueOnce(
        new Promise<void>((resolve) => { resolveDelete = resolve; }),
      );
    }
    const user = userEvent.setup();
    const view = render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await user.click(await screen.findByRole("button", { name: buttonName }));

    view.rerender(
      <CapabilityContext value={context(currentUser, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2));
    await act(async () => {
      if (action === "delete") {
        resolveDelete();
      } else {
        resolveJob(job);
      }
    });

    expect(screen.queryByRole("heading", { name: "Minimized results" })).not.toBeInTheDocument();
    expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2);
  });

  it.each(["account", "application revision"] as const)("does not create a delayed CSV download after the %s changes", async change => {
    let resolveStaleExport!: (value: Blob) => void;
    const currentUser: SessionUser = {
      ...viewer,
      homeAccountId: "reader-b",
      username: "reader-b@example.invalid",
    };
    const createObjectUrl = vi.fn(() => "blob:purview-audit");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectUrl;
    });
    vi.mocked(getPurviewAuditJobs)
      .mockResolvedValueOnce({ value: [partialJob], count: 1, limit: 20, offset: 0 })
      .mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 });
    vi.mocked(downloadPurviewAuditCsv).mockReturnValueOnce(
      new Promise((resolve) => { resolveStaleExport = resolve; }),
    );
    const access = (changed = false) => {
      const value = context(changed && change === "account" ? currentUser : viewer, true);
      value.views.splice(1, 1, { ...capabilityView(true, "purview.audit.search.application"),
        configuration: { enabled: true, sharedDataScope: true, revision: changed && change === "application revision" ? 2 : 1 } });
      return value;
    };
    const user = userEvent.setup();
    const view = render(
      <CapabilityContext value={access()}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await user.click(await screen.findByRole("button", { name: /Export results 11111111/ }));
    const signal = vi.mocked(downloadPurviewAuditCsv).mock.calls[0][1]!.signal!;

    view.rerender(
      <CapabilityContext value={access(true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveStaleExport(new Blob(["saved"]));
    });

    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("has no DOM accessibility violations", async () => {
    const { container } = render(
      <main>
        <CapabilityContext value={context(viewer, true)}>
          <PurviewAuditView />
        </CapabilityContext>
      </main>,
    );

    await screen.findByRole("heading", { name: "Search Purview logs" });
    await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenCalledOnce());
    const result = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});