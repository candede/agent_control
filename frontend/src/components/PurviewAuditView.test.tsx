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

function PurviewAuditView({ userPrincipalName = viewer.username }: { userPrincipalName?: string } = {}) {
  return <UserPurviewAuditView userPrincipalName={userPrincipalName} />;
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
    delete (URL as Partial<typeof URL>).createObjectURL;
  });

  it("keeps delegated search disabled without exposing a qualification ritual", async () => {
    render(
      <CapabilityContext value={context(viewer)}>
        <PurviewAuditView />
      </CapabilityContext>,
    );

    expect(await screen.findByText(/a permission check establishes delegated authorization/)).toBeVisible();
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
    selectedContext.views.push(capabilityView(available, "purview.audit.search.application"));
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
    const identity = await screen.findByRole("textbox", { name: "User principal names" });
    expect(identity).toBeVisible();
    expect(identity).toHaveValue("employee@example.invalid");
    expect(identity).toHaveAttribute("readonly");
    expect(getPurviewAuditJobs).toHaveBeenCalledWith(20, 0, expect.objectContaining({ userPrincipalName: "employee@example.invalid" }));
    expect(screen.getByRole("button", { name: "Run Audit Search" })).toBeEnabled();
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
    expect(startPurviewAuditQualification).not.toHaveBeenCalled();
    await userEvent.type(identity, "other@example.invalid");
    expect(identity).toHaveValue("employee@example.invalid");
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

    await screen.findByText(/a permission check establishes delegated authorization/);
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

    await screen.findByText(/a permission check establishes delegated authorization/);
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
    expect(screen.getByText("Structured filters").parentElement).toHaveTextContent(`Users: ${viewer.username}`);
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
    await user.type(screen.getByLabelText("IP addresses"), "192.0.2.10");

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
    fireEvent.change(screen.getByLabelText("IP addresses"), { target: { value: "192.0.2.10" } });
    expect(signal.aborted).toBe(true);
    await act(async () => finish(recordPage(second, "Obsolete filtered actor")));
    expect(screen.queryByRole("heading", { name: "Minimized results" })).not.toBeInTheDocument();
    expect(screen.queryByText("Obsolete filtered actor")).not.toBeInTheDocument();
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
    const view = render(<CapabilityContext value={context(viewer)}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    fireEvent.submit(screen.getByRole("button", { name: "Run Audit Search" }).closest("form")!);
    expect(submitPurviewAuditSearch).not.toHaveBeenCalled();
    view.rerender(<CapabilityContext value={context(viewer, true)}><PurviewAuditView /></CapabilityContext>);
    await screen.findByText("No Audit Search history");
    await userEvent.click(screen.getByRole("checkbox", { name: "CopilotInteraction" }));
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
      shared = readSavedQuery(client, ["purview-audit-jobs", { limit: 20, offset: 0, userPrincipalName: viewer.username }, undefined],
        signal => getPurviewAuditJobs(20, 0, { signal, userPrincipalName: viewer.username }), outside.signal);
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(getPurviewAuditJobs).toHaveBeenCalledTimes(2);
      const oldQuery = client.getQueryCache().find({ queryKey: ["saved", "purview-audit-jobs", { limit: 20, offset: 0, userPrincipalName: viewer.username }, undefined], exact: true });
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