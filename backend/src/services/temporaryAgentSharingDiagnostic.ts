import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { acquireAuthorizedToken, revalidateAuthorizedUser } from "../auth/msal.js";
import { config } from "../config.js";
import { AppError, errorTelemetry } from "../errors.js";
import { hasAppRole, type CapabilityId } from "../types/capability.js";
import type { AuthenticatedUser } from "../types/session.js";
import { capabilities } from "./capabilities.js";
import { GraphPackagesClient } from "./graphPackages.js";
import { PowerPlatformResourceQueryClient } from "./powerPlatformResourceQuery.js";
import { createRefreshExecutionSignal } from "./refreshExecution.js";
import { operationalLog } from "./telemetry.js";

const tenantId = "5dc17551-d2fb-4e89-93da-178b52154818";
const environmentId = `default-${tenantId}`;
const targets = [
  { key: "brd", name: "BRD Review Analyst", packageId: "T_01d12748-6737-d92a-636a-74afd2e69389",
    nativeId: "3deaf785-6ba7-44e6-b67d-e255791c432c", userReportedOrgWideChat: true },
  { key: "visual-architect", name: "Enterprise Visual Architect", packageId: "T_c64118dc-9257-8cdc-bb50-566be946169a",
    nativeId: "97dbaaf8-5ee0-4c79-9ce3-0cd3c94ad2ab", userReportedOrgWideChat: false },
] as const;
const maximumCaptures = 3;
const maximumFileBytes = 2_000_000;
const deadlineMs = 180_000;
const captureIdPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const credentialKey = /^(?:authorization|cookies?|set-cookie|(?:access|refresh|id)[_-]?token|client[_-]?secret|secret|password|api[_-]?key|connection[_-]?string)$/i;

export type AgentSharingDiagnosticContext = { runId: string; signal: AbortSignal; assertCurrent: () => void };
type ReadContext = { signal: AbortSignal; assertCurrent: () => void };
type Dependencies = {
  enabled: boolean;
  directory: string;
  files: Pick<typeof fs, "lstat" | "readdir" | "mkdir" | "open">;
  graph: Pick<GraphPackagesClient, "getDiagnosticPackageDetails">;
  powerPlatform: Pick<PowerPlatformResourceQueryClient, "getDiagnosticAgentDetail">;
  authorize: (user: AuthenticatedUser, capabilityId: CapabilityId, context: ReadContext) =>
    Promise<{ token: string; assertCurrent: () => void }>;
  log: typeof operationalLog;
};
type CaptureResult = {
  target: typeof targets[number]["key"];
  provider: "graph_packages" | "power_platform";
  apiVersion: "v1.0" | "beta" | "2024-10-01";
  method: "GET" | "POST";
  endpoint: string;
  startedAt: string;
  finishedAt?: string;
  status: "succeeded" | "failed";
  filename?: string;
  bytes?: number;
  error?: ReturnType<typeof errorTelemetry>;
};

// Temporary, deliberately fixed two-agent investigation; not a general raw-provider-data facility.
export class TemporaryAgentSharingDiagnostic {
  private active = false;
  private readonly dependencies: Dependencies;

  constructor(overrides: Partial<Dependencies> = {}) {
    this.dependencies = {
      enabled: config.agentSharingDiagnostics,
      directory: "/run/agent-sharing-diagnostics",
      files: fs,
      graph: new GraphPackagesClient(),
      powerPlatform: new PowerPlatformResourceQueryClient(),
      authorize,
      log: operationalLog,
      ...overrides,
    };
  }

  async run(user: AuthenticatedUser, context: AgentSharingDiagnosticContext) {
    if (!this.dependencies.enabled) return "disabled";
    const skipCode = user.tenantId?.toLowerCase() !== tenantId ? "diagnostic_tenant_not_targeted"
      : !hasAppRole(user.roles, "AgentControl.Admin") ? "diagnostic_admin_required"
      : this.active ? "diagnostic_busy" : undefined;
    if (skipCode) {
      this.dependencies.log("warn", "agent_sharing_diagnostic_skipped", { runId: context.runId, errorCode: skipCode });
      return "skipped";
    }
    this.active = true;
    const execution = createRefreshExecutionSignal(context.signal, deadlineMs);
    const assertCurrent = () => { execution.signal.throwIfAborted(); context.assertCurrent(); };
    const captureId = randomUUID();
    const directory = join(this.dependencies.directory, captureId);
    const startedAt = new Date().toISOString();
    const results: CaptureResult[] = [];
    let status: "succeeded" | "partial" | "cancelled" = "partial";
    try {
      assertCurrent();
      await this.prepareDirectory(directory);
      assertCurrent();
      const manifest = {
        captureId, runId: context.runId, tenantId, environmentId, startedAt, targets,
        userReportedStateNote: "Comparison labels supplied by the user; not API-observed sharing settings.",
        format: "Unprojected parsed provider JSON, with credential fields and the active access token redacted.",
        dataverse: { status: "not_attempted", reason: "No authenticated Dataverse discovery/read client is configured. bot.accesscontrolpolicy remains an unverified lead." },
      };
      await this.save(directory, "manifest.started.json", manifest, assertCurrent);
      this.dependencies.log("info", "agent_sharing_diagnostic_started", { runId: context.runId, jobId: captureId, count: targets.length });
      try {
        for (const [targetIndex, target] of targets.entries()) {
          for (const apiVersion of ["v1.0", "beta", "2024-10-01"] as const) {
            assertCurrent();
            const graph = apiVersion !== "2024-10-01";
            const provider = graph ? "graph_packages" : "power_platform";
            const endpoint = graph
              ? `https://graph.microsoft.com/${apiVersion}/copilot/admin/catalog/packages/${target.packageId}`
              : "https://api.powerplatform.com/resourcequery/resources/query?api-version=2024-10-01";
            const result: CaptureResult = { target: target.key, provider, apiVersion, method: graph ? "GET" : "POST",
              endpoint, startedAt: new Date().toISOString(), status: "failed" };
            results.push(result);
            let stage: "request" | "save_page" = "request";
            try {
              const authority = await this.dependencies.authorize(user,
                graph ? "graph.package.read.delegated" : "powerPlatform.inventory.read",
                { signal: execution.signal, assertCurrent });
              const readAssertCurrent = () => { assertCurrent(); authority.assertCurrent(); };
              readAssertCurrent();
              const options = { signal: execution.signal, assertCurrent: readAssertCurrent, executionDeadlineAt: Date.now() + 60_000 };
              const body = apiVersion === "2024-10-01"
                ? await this.dependencies.powerPlatform.getDiagnosticAgentDetail(authority.token, target.nativeId,
                  { ...options, expectedTenantId: tenantId, environmentId })
                : await this.dependencies.graph.getDiagnosticPackageDetails(authority.token, target.packageId, apiVersion, options);
              readAssertCurrent();
              stage = "save_page";
              const filename = `${target.key}.${graph ? `graph-${apiVersion}` : "power-platform"}.json`;
              const bytes = await this.save(directory, filename, body, readAssertCurrent, authority.token);
              readAssertCurrent();
              Object.assign(result, { status: "succeeded", filename, bytes });
              this.dependencies.log("info", "agent_sharing_diagnostic_response_saved",
                { runId: context.runId, jobId: captureId, provider, apiVersion, targetIndex, bytes, outcome: "collected" });
            } catch (error) {
              result.error = errorTelemetry(error);
              this.dependencies.log("warn", "agent_sharing_diagnostic_response_failed",
                { runId: context.runId, jobId: captureId, provider, apiVersion, targetIndex, stage, ...result.error });
              if (stage === "save_page" || error instanceof AppError && error.code === "diagnostic_authorization_changed") throw error;
              assertCurrent();
            } finally { result.finishedAt = new Date().toISOString(); }
          }
        }
        status = results.every(result => result.status === "succeeded") ? "succeeded" : "partial";
      } catch (error) {
        status = execution.signal.aborted ? "cancelled" : "partial";
        throw error;
      } finally {
        await this.save(directory, "manifest.json", { ...manifest, status, finishedAt: new Date().toISOString(), results });
        this.dependencies.log(status === "succeeded" ? "info" : "warn", "agent_sharing_diagnostic_finished",
          { runId: context.runId, jobId: captureId, status, count: results.filter(result => result.status === "succeeded").length });
      }
      return status;
    } finally {
      execution.dispose();
      this.active = false;
    }
  }

  private async prepareDirectory(directory: string) {
    const root = await storage(() => this.dependencies.files.lstat(this.dependencies.directory));
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0
      || process.getuid && root.uid !== process.getuid()) {
      throw new AppError(500, "diagnostic_storage_unsafe", "The diagnostic root must be a private, application-owned directory.");
    }
    const entries = await storage(() => this.dependencies.files.readdir(this.dependencies.directory, { withFileTypes: true }));
    if (entries.some(entry => !entry.isDirectory() || !captureIdPattern.test(entry.name))) {
      throw new AppError(500, "diagnostic_storage_unsafe", "Unexpected entries exist in the dedicated diagnostic root.");
    }
    if (entries.length >= maximumCaptures) {
      throw new AppError(507, "diagnostic_capture_limit", "Three diagnostic captures already exist. Review and explicitly remove an owned capture before retrying.");
    }
    await storage(() => this.dependencies.files.mkdir(directory, { mode: 0o700 }));
  }

  private async save(directory: string, filename: string, body: unknown, assertCurrent?: () => void, accessToken?: string) {
    let redactions = 0;
    const redact = (key: string, value: unknown): unknown => {
      if (credentialKey.test(key)) { redactions += 1; return "[REDACTED]"; }
      if (typeof value !== "string") return value;
      const text = accessToken ? value.replaceAll(accessToken, "[REDACTED]") : value;
      const trimmed = text.trimStart();
      // Provider definitions can contain another JSON document inside a string.
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && /token|secret|password|authorization|cookie|api[_-]?key|connection[_-]?string/i.test(text)) {
        let embedded: unknown;
        try { embedded = JSON.parse(text); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; return text; }
        const previous = redactions;
        const sanitized = JSON.stringify(embedded, redact);
        if (redactions > previous) return sanitized;
      }
      return text;
    };
    const text = JSON.stringify(body, redact);
    if (text === undefined) throw new AppError(502, "diagnostic_invalid_body", "The diagnostic body was not JSON.");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maximumFileBytes) throw new AppError(507, "diagnostic_file_limit", "The diagnostic artifact exceeds two million bytes.");
    assertCurrent?.();
    const file = await storage(() => this.dependencies.files.open(join(directory, filename), "wx", 0o600));
    try {
      assertCurrent?.();
      await storage(() => file.writeFile(text, "utf8"));
      assertCurrent?.();
    } finally { await storage(() => file.close()); }
    return bytes;
  }
}

async function authorize(user: AuthenticatedUser, capabilityId: CapabilityId, context: ReadContext) {
  if (!user.tenantId) throw AppError.unauthorized();
  const tenant = user.tenantId;
  const validateCapability = capabilities.beginOperationValidation(capabilityId, user);
  const assertCurrent = () => { context.signal.throwIfAborted(); context.assertCurrent(); validateCapability(); };
  assertCurrent();
  const fresh = await interruptible(() => revalidateAuthorizedUser(tenant, user.homeAccountId), context.signal);
  assertCurrent();
  if (fresh.tenantId !== tenant || fresh.homeAccountId !== user.homeAccountId || !hasAppRole(fresh.roles, "AgentControl.Admin")) {
    throw new AppError(401, "diagnostic_authorization_changed", "Diagnostic administrator authorization changed.");
  }
  await interruptible(() => capabilities.requireAvailable(capabilityId, fresh), context.signal);
  assertCurrent();
  const token = await interruptible(() => acquireAuthorizedToken(tenant, user.homeAccountId, capabilityId), context.signal);
  assertCurrent();
  return { token, assertCurrent };
}

async function interruptible<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let removeAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", abort);
  });
  try { return await Promise.race([work(), aborted]); }
  finally { removeAbort(); }
}

async function storage<T>(operation: () => Promise<T>) {
  try { return await operation(); }
  catch (error) {
    const code: unknown = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
    const known = typeof code === "string" && ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EDQUOT", "EROFS", "EEXIST", "EIO", "EMFILE", "ENFILE"].includes(code);
    throw new AppError(code === "ENOSPC" || code === "EDQUOT" ? 507 : 500,
      known ? `diagnostic_storage_${code.toLowerCase()}` : "diagnostic_storage_failed",
      "Private diagnostic storage failed. Check directory ownership, permissions and available disk space.");
  }
}

export const temporaryAgentSharingDiagnostic = new TemporaryAgentSharingDiagnostic();
