import { act, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import {
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
  type SessionUser,
} from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { PurviewAuditView } from "./PurviewAuditView";
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

function render(ui: ReactNode) {
  const wrap = (children: ReactNode) => <WorkbenchActionProvider value={workbenchActions}>{children}</WorkbenchActionProvider>;
  const result = rtlRender(wrap(ui));
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
  userPrincipalNames: [],
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

function capabilityView(authorized: boolean): CapabilityView {
  const definition = capabilityDefinitions.find(
    (candidate) => candidate.id === "purview.audit.search.delegated",
  )!;

  return {
    definition,
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
    views: [capabilityView(authorized)],
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

describe("PurviewAuditView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/audit?source=purview");
    vi.mocked(getPurviewAuditCatalog).mockResolvedValue(catalog);
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [], count: 0, limit: 20, offset: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (URL as Partial<typeof URL>).createObjectURL;
  });

  it("keeps delegated search disabled without exposing a qualification ritual", async () => {
    render(
      <CapabilityContext value={context(viewer)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );

    expect(await screen.findByText(/automatic permission checks establish delegated authorization/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Approve qualification" })).not.toBeInTheDocument();
    expect(getPurviewAuditCatalog).toHaveBeenCalledOnce();
    expect(getPurviewAuditJobs).toHaveBeenCalledExactlyOnceWith(20, 0);
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
    expect(approvePurviewAuditQualification).not.toHaveBeenCalled();
    expect(startPurviewAuditQualification).not.toHaveBeenCalled();
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

    await screen.findByText(/automatic permission checks establish delegated authorization/);
    await user.selectOptions(screen.getByLabelText("Authorization"), "application");
    await screen.findByText("Live lifecycle not qualified");
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
        userPrincipalNames: [],
        ipAddresses: [],
        objectIds: [],
        administrativeUnitIds: [],
      }),
    );
    expect(startPurviewAuditQualification).not.toHaveBeenCalled();

    await user.click(
      await screen.findByRole("button", {
        name: "Run approved qualification",
      }),
    );
    expect(startPurviewAuditQualification).toHaveBeenCalledExactlyOnceWith(
      "qualification-a",
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

    await screen.findByText(/automatic permission checks establish delegated authorization/);
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
    expect(screen.getByText("Authorizing actor").parentElement).toHaveTextContent("reader-a");
    expect(screen.getByText("Result scope").parentElement).toHaveTextContent("principal: reader-a");
    expect(screen.getByText("Selected operations").parentElement).toHaveTextContent("CopilotInteraction");
    expect(screen.getByText("Structured filters").parentElement).toHaveTextContent("No structured identity filters");
    expect(screen.getByText("native-event-a")).toBeVisible();
    expect(screen.getByText(/Prompt ID: message-a/)).toBeVisible();
    expect(
      screen.getByText(
        "Exact microsoft.copilotstudio/agents: inventory-agent-a",
      ),
    ).toBeVisible();
    expect(
      screen.getAllByText(/Content not present in Purview audit/).length,
    ).toBeGreaterThan(1);
    expect(screen.getByText("3")).toBeVisible();
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

    await screen.findByRole("heading", { name: "Purview Audit Search" });
    await user.selectOptions(screen.getByLabelText("Search preset"), "copilot_studio_admin");
    expect(screen.getByRole("checkbox", { name: "BotCreate" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Run Audit Search" }));
    expect(submitPurviewAuditSearch).toHaveBeenCalledWith("delegated", expect.objectContaining({
      presetId: "copilot_studio_admin",
      operations: ["BotCreate"],
    }));
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
    await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenLastCalledWith(20, 20));
    await user.click(await screen.findByRole("button", { name: /Delete local cache 22222222/ }));
    expect(deletePurviewAuditSearch).toHaveBeenCalledExactlyOnceWith("22222222-2222-4222-8222-222222222222");
  });

  it("reloads saved history for a new account and ignores the previous account's late response", async () => {
    let resolveStaleHistory!: (value: Awaited<ReturnType<typeof getPurviewAuditJobs>>) => void;
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
      .mockReturnValueOnce(new Promise((resolve) => { resolveStaleHistory = resolve; }))
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
    resolveStaleHistory({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: /View results 11111111/ })).not.toBeInTheDocument();
  });

  it("selects an exact older deep-linked job rather than the latest history row", async () => {
    const latest = { ...partialJob, id: "99999999-9999-4999-8999-999999999999" };
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [latest], count: 21, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditJob).mockResolvedValue(partialJob);
    render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView initialJobId={partialJob.id} />
      </CapabilityContext>,
    );

    expect(await screen.findByText(new RegExp(partialJob.localRequestId))).toBeVisible();
    expect(getPurviewAuditJob).toHaveBeenCalledWith(partialJob.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("shows a safe exact-link error for a job outside the current role scope", async () => {
    vi.mocked(getPurviewAuditJobs).mockResolvedValue({ value: [partialJob], count: 1, limit: 20, offset: 0 });
    vi.mocked(getPurviewAuditJob).mockRejectedValue(new Error("Not found"));
    render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView initialJobId="other-principal-job" />
      </CapabilityContext>,
    );

    expect(await screen.findByText(/exact Audit Search job is expired, deleted, or unavailable/i)).toBeVisible();
    expect(screen.queryByText(partialJob.localRequestId)).not.toBeInTheDocument();
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

  it("keeps saved results readable after live capability evidence expires", async () => {
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

    expect(await screen.findByText(/automatic permission checks establish delegated authorization/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /View results 11111111/ }));
    expect(getPurviewAuditRecords).toHaveBeenCalledExactlyOnceWith(partialJob.id, 100, 0);
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

    await user.click(screen.getByText("Structured identity filters"));
    await user.type(screen.getByLabelText("User principal names"), "other@example.invalid");

    expect(approval).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "Run approved qualification" })).not.toBeInTheDocument();
  });

  it("ignores an active-job poll that resolves after the account changes", async () => {
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
    const timeout = vi.spyOn(window, "setTimeout");
    vi.mocked(getPurviewAuditJobs)
      .mockResolvedValueOnce({ value: [runningJob], count: 1, limit: 20, offset: 0 })
      .mockReturnValueOnce(new Promise((resolve) => { resolveStalePoll = resolve; }))
      .mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 });
    const view = render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await screen.findByRole("button", { name: /Cancel local polling 11111111/ });
    const poll = timeout.mock.calls.find(([, milliseconds]) => milliseconds === 2_000)?.[0];
    expect(poll).toBeTypeOf("function");
    act(() => (poll as () => void)());
    await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2));

    view.rerender(
      <CapabilityContext value={context(currentUser, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenCalledTimes(3));
    await act(async () => {
      resolveStalePoll({ value: [runningJob], count: 1, limit: 20, offset: 0 });
    });

    expect(screen.queryByRole("button", { name: /Cancel local polling 11111111/ })).not.toBeInTheDocument();
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

  it("does not create a delayed CSV download after the account changes", async () => {
    let resolveStaleExport!: (value: Blob) => void;
    const currentUser: SessionUser = {
      ...viewer,
      homeAccountId: "reader-b",
      username: "reader-b@example.invalid",
    };
    const createObjectUrl = vi.fn(() => "blob:purview-audit");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    vi.mocked(getPurviewAuditJobs)
      .mockResolvedValueOnce({ value: [partialJob], count: 1, limit: 20, offset: 0 })
      .mockResolvedValueOnce({ value: [], count: 0, limit: 20, offset: 0 });
    vi.mocked(downloadPurviewAuditCsv).mockReturnValueOnce(
      new Promise((resolve) => { resolveStaleExport = resolve; }),
    );
    const user = userEvent.setup();
    const view = render(
      <CapabilityContext value={context(viewer, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
    await user.click(await screen.findByRole("button", { name: /Export results 11111111/ }));

    view.rerender(
      <CapabilityContext value={context(currentUser, true)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );
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

    await screen.findByRole("heading", { name: "Purview Audit Search" });
    await waitFor(() => expect(getPurviewAuditJobs).toHaveBeenCalledOnce());
    const result = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});