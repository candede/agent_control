import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";
import { TemporaryAgentSharingDiagnostic } from "./temporaryAgentSharingDiagnostic.js";
import { acquireAuthorizedToken, revalidateAuthorizedUser } from "../auth/msal.js";

vi.mock("../db/pool.js", () => ({ pool: {}, secretValue: vi.fn(() => undefined) }));
vi.mock("../auth/msal.js", () => ({ acquireAuthorizedToken: vi.fn(), revalidateAuthorizedUser: vi.fn() }));
vi.mock("./capabilities.js", () => ({ capabilities: {
  beginOperationValidation: vi.fn(() => () => {}), requireAvailable: vi.fn(async () => {}),
} }));

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), "agent-sharing-case-"));
  await fs.chmod(directory, 0o700);
  roots.push(directory);
  const user: AuthenticatedUser = { tenantId: "5dc17551-d2fb-4e89-93da-178b52154818", homeAccountId: "synthetic-admin",
    roles: ["AgentControl.Admin"], username: "admin@example.invalid", displayName: "Admin" };
  const controller = new AbortController();
  const context = { runId: randomUUID(), signal: controller.signal, assertCurrent: vi.fn(() => controller.signal.throwIfAborted()) };
  const graph = { getDiagnosticPackageDetails: vi.fn(async (_token: string, id: string) =>
    ({ id, futureChatSetting: false, recipients: [], optional: null, instructions: "private agent instructions", access_token: "private credential" })) };
  const powerPlatform = { getDiagnosticAgentDetail: vi.fn(async (_token: string, nativeId: string) =>
    ({ data: [{ name: nativeId, properties: { futureSharing: { orgWide: true }, missingPreviously: [], optional: null } }] })) };
  vi.mocked(revalidateAuthorizedUser).mockResolvedValue(user);
  vi.mocked(acquireAuthorizedToken).mockResolvedValue("synthetic-transport-secret");
  const log = vi.fn();
  const dependencies = { enabled: true, directory, graph, powerPlatform, log };
  const service = new TemporaryAgentSharingDiagnostic(dependencies);
  const capture = async () => {
    const [captureId] = await fs.readdir(directory);
    const path = join(directory, captureId);
    return { path, files: await fs.readdir(path), manifest: JSON.parse(await fs.readFile(join(path, "manifest.json"), "utf8")) };
  };
  return { directory, user, controller, context, graph, powerPlatform, log, dependencies, service, capture };
}

describe("temporary two-agent sharing diagnostic", () => {
  it("performs no work when disabled", async () => {
    const f = await fixture();
    const lstat = vi.fn();
    const service = new TemporaryAgentSharingDiagnostic({ ...f.dependencies, enabled: false, files: { ...fs, lstat } });
    await expect(service.run(f.user, f.context)).resolves.toBe("disabled");
    expect(lstat).not.toHaveBeenCalled();
    expect(acquireAuthorizedToken).not.toHaveBeenCalled();
    expect(f.graph.getDiagnosticPackageDetails).not.toHaveBeenCalled();
    expect(f.log).not.toHaveBeenCalled();
  });

  it.each(["tenant", "role"] as const)("refuses non-target %s scope before touching disk or providers", async mismatch => {
    const f = await fixture();
    if (mismatch === "tenant") f.user.tenantId = randomUUID();
    else f.user.roles = ["AgentControl.Viewer"];
    await expect(f.service.run(f.user, f.context)).resolves.toBe("skipped");
    expect(await fs.readdir(f.directory)).toEqual([]);
    expect(acquireAuthorizedToken).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith("warn", "agent_sharing_diagnostic_skipped", expect.any(Object));
  });

  it("privately saves exactly two agents across the three APIs, preserving unknown/null/empty/absent fields", async () => {
    const f = await fixture();
    await expect(f.service.run(f.user, f.context)).resolves.toBe("succeeded");
    const capture = await f.capture();
    expect(capture.files).toHaveLength(8);
    expect(capture.manifest.status).toBe("succeeded");
    expect(capture.manifest.results).toHaveLength(6);
    expect(capture.manifest.dataverse.status).toBe("not_attempted");
    expect(f.graph.getDiagnosticPackageDetails.mock.calls.map(call => call[1])).toEqual([
      "T_01d12748-6737-d92a-636a-74afd2e69389", "T_01d12748-6737-d92a-636a-74afd2e69389",
      "T_c64118dc-9257-8cdc-bb50-566be946169a", "T_c64118dc-9257-8cdc-bb50-566be946169a",
    ]);
    expect(f.powerPlatform.getDiagnosticAgentDetail.mock.calls.map(call => call[1])).toEqual([
      "3deaf785-6ba7-44e6-b67d-e255791c432c", "97dbaaf8-5ee0-4c79-9ce3-0cd3c94ad2ab",
    ]);
    expect((await fs.stat(capture.path)).mode & 0o777).toBe(0o700);
    for (const filename of capture.files) {
      expect((await fs.stat(join(capture.path, filename))).mode & 0o777).toBe(0o600);
      expect(await fs.readFile(join(capture.path, filename), "utf8")).not.toContain("synthetic-transport-secret");
    }
    const body = JSON.parse(await fs.readFile(join(capture.path, "brd.graph-v1.0.json"), "utf8"));
    expect(body).toMatchObject({ futureChatSetting: false, recipients: [], optional: null, access_token: "[REDACTED]" });
    expect(body).not.toHaveProperty("neverSupplied");
    expect(JSON.stringify(f.log.mock.calls)).not.toMatch(/private agent instructions|private credential|futureChatSetting|synthetic-transport-secret/);
  });

  it("reports provider denials as partial evidence and continues independent probes", async () => {
    const f = await fixture();
    f.graph.getDiagnosticPackageDetails.mockRejectedValueOnce(new AppError(403, "access_denied", "private provider message"));
    await expect(f.service.run(f.user, f.context)).resolves.toBe("partial");
    const capture = await f.capture();
    expect(capture.files).toHaveLength(7);
    expect(capture.manifest.results[0]).toMatchObject({ status: "failed", error: { status: 403, errorCode: "access_denied" } });
    expect(capture.manifest.results.filter((result: { status: string }) => result.status === "succeeded")).toHaveLength(5);
    expect(JSON.stringify(capture.manifest)).not.toContain("private provider message");
    expect(f.log).toHaveBeenCalledWith("warn", "agent_sharing_diagnostic_finished", expect.objectContaining({ status: "partial", count: 5 }));
  });

  it("redacts credential fields inside stringified provider definitions without discarding sharing evidence", async () => {
    const f = await fixture();
    const definition = JSON.stringify({ sharing: { orgWide: false }, authentication: { apiKey: "private embedded credential" },
      nested: JSON.stringify({ clientSecret: "synthetic private nested credential", mode: "chat" }) });
    f.graph.getDiagnosticPackageDetails.mockResolvedValueOnce({ id: "target", futureChatSetting: false, recipients: [],
      optional: null, instructions: definition, access_token: "secret" });
    await expect(f.service.run(f.user, f.context)).resolves.toBe("succeeded");
    const capture = await f.capture();
    const body = JSON.parse(await fs.readFile(join(capture.path, "brd.graph-v1.0.json"), "utf8"));
    const decoded = JSON.parse(body.instructions);
    expect(decoded).toMatchObject({ sharing: { orgWide: false }, authentication: { apiKey: "[REDACTED]" } });
    expect(JSON.parse(decoded.nested)).toEqual({ clientSecret: "[REDACTED]", mode: "chat" });
    expect(JSON.stringify(body)).not.toContain("private embedded credential");
    expect(JSON.stringify(body)).not.toContain("private nested credential");
  });

  it("stops when fresh authorization no longer grants administrator scope", async () => {
    const f = await fixture();
    vi.mocked(revalidateAuthorizedUser).mockResolvedValue({ ...f.user, roles: ["AgentControl.Viewer"] });
    await expect(f.service.run(f.user, f.context)).rejects.toMatchObject({ code: "diagnostic_authorization_changed" });
    expect(acquireAuthorizedToken).not.toHaveBeenCalled();
    expect(f.graph.getDiagnosticPackageDetails).not.toHaveBeenCalled();
    expect((await f.capture()).files).toHaveLength(2);
  });

  it("cancels a pending token acquisition and ignores its late result", async () => {
    const f = await fixture();
    let resolve!: (value: string) => void;
    vi.mocked(acquireAuthorizedToken).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const running = f.service.run(f.user, f.context);
    await vi.waitFor(() => expect(acquireAuthorizedToken).toHaveBeenCalledOnce());
    f.controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    resolve("late-token");
    await Promise.resolve();
    const capture = await f.capture();
    expect(capture.manifest.status).toBe("cancelled");
    expect(capture.files).toHaveLength(2);
    expect(f.graph.getDiagnosticPackageDetails).not.toHaveBeenCalled();
  });

  it("fences a response after session revocation without storing it", async () => {
    const f = await fixture();
    f.graph.getDiagnosticPackageDetails.mockImplementationOnce(async () => {
      f.controller.abort(new DOMException("Session revoked", "AbortError"));
      return { id: "late", futureChatSetting: false, recipients: [], optional: null, instructions: "private", access_token: "secret" };
    });
    await expect(f.service.run(f.user, f.context)).rejects.toMatchObject({ name: "AbortError" });
    expect((await f.capture()).files).toHaveLength(2);
    expect(f.powerPlatform.getDiagnosticAgentDetail).not.toHaveBeenCalled();
  });

  it("does not overlap captures", async () => {
    const f = await fixture();
    let resolve!: (value: string) => void;
    vi.mocked(acquireAuthorizedToken).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const running = f.service.run(f.user, f.context);
    await vi.waitFor(() => expect(acquireAuthorizedToken).toHaveBeenCalledOnce());
    await expect(f.service.run(f.user, f.context)).resolves.toBe("skipped");
    resolve("synthetic-transport-secret");
    await expect(running).resolves.toBe("succeeded");
    expect(await fs.readdir(f.directory)).toHaveLength(1);
  });

  it("enforces the three-minute capture deadline while authorization is pending", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    let started!: () => void;
    const authorizing = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(acquireAuthorizedToken).mockImplementationOnce(() => { started(); return new Promise(() => {}); });
    const running = f.service.run(f.user, f.context);
    const rejected = expect(running).rejects.toMatchObject({ name: "TimeoutError" });
    await authorizing;
    await vi.advanceTimersByTimeAsync(180_000);
    await rejected;
    expect(f.graph.getDiagnosticPackageDetails).not.toHaveBeenCalled();
    expect((await f.capture()).manifest.results[0].error.errorKind).toBe("timeout");
  });

  it.each([0, 1])("enforces the exact two-million-byte artifact boundary with %i excess bytes", async excess => {
    const f = await fixture();
    const base = { id: "T_01d12748-6737-d92a-636a-74afd2e69389", futureChatSetting: false, recipients: [], optional: null,
      instructions: "", access_token: "[REDACTED]" };
    const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
    f.graph.getDiagnosticPackageDetails.mockResolvedValueOnce({ ...base, instructions: "a".repeat(2_000_000 - overhead + excess) });
    const running = f.service.run(f.user, f.context);
    if (excess) {
      await expect(running).rejects.toMatchObject({ code: "diagnostic_file_limit" });
      const capture = await f.capture();
      expect(capture.files).toHaveLength(2);
      expect(capture.manifest.status).toBe("partial");
      expect(capture.manifest.results[0].error.errorCode).toBe("diagnostic_file_limit");
    } else {
      await expect(running).resolves.toBe("succeeded");
      const capture = await f.capture();
      expect((await fs.stat(join(capture.path, "brd.graph-v1.0.json"))).size).toBe(2_000_000);
    }
  });

  it("records a response write failure and stops further provider reads", async () => {
    const f = await fixture();
    const open = vi.fn<typeof fs.open>(async (path, flags, mode) => {
      if (String(path).endsWith(".graph-v1.0.json")) throw Object.assign(new Error("Sensitive path"), { code: "ENOSPC" });
      return fs.open(path, flags, mode);
    });
    await expect(new TemporaryAgentSharingDiagnostic({ ...f.dependencies, files: { ...fs, open } }).run(f.user, f.context))
      .rejects.toMatchObject({ code: "diagnostic_storage_enospc", status: 507 });
    const capture = await f.capture();
    expect(capture.files).toHaveLength(2);
    expect(capture.manifest.status).toBe("partial");
    expect(f.graph.getDiagnosticPackageDetails).toHaveBeenCalledOnce();
    expect(f.powerPlatform.getDiagnosticAgentDetail).not.toHaveBeenCalled();
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("Sensitive path");
  });

  it("stops at the persistent three-capture quota before acquiring credentials", async () => {
    const f = await fixture();
    for (let index = 0; index < 3; index++) await fs.mkdir(join(f.directory, randomUUID()), { mode: 0o700 });
    await expect(f.service.run(f.user, f.context)).rejects.toMatchObject({ code: "diagnostic_capture_limit" });
    expect(acquireAuthorizedToken).not.toHaveBeenCalled();
    expect(await fs.readdir(f.directory)).toHaveLength(3);
  });

  it.each(["public", "symlink"] as const)("rejects unsafe %s storage", async unsafe => {
    const f = await fixture();
    let directory = f.directory;
    if (unsafe === "public") await fs.chmod(directory, 0o755);
    else {
      directory = join(f.directory, "linked");
      await fs.symlink(f.directory, directory);
    }
    await expect(new TemporaryAgentSharingDiagnostic({ ...f.dependencies, directory }).run(f.user, f.context))
      .rejects.toMatchObject({ code: "diagnostic_storage_unsafe" });
    expect(acquireAuthorizedToken).not.toHaveBeenCalled();
  });

  it("surfaces write failure without dispatching providers or claiming completion", async () => {
    const f = await fixture();
    const open = vi.fn(async () => { throw new Error("Synthetic disk full"); });
    await expect(new TemporaryAgentSharingDiagnostic({ ...f.dependencies, files: { ...fs, open } }).run(f.user, f.context))
      .rejects.toMatchObject({ code: "diagnostic_storage_failed" });
    expect(acquireAuthorizedToken).not.toHaveBeenCalled();
    expect(f.log.mock.calls.some(call => call[1] === "agent_sharing_diagnostic_finished")).toBe(false);
  });
});
