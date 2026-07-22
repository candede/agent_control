import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type {
  CopilotPackageDetail,
  PackageAccessEntity,
} from "../types/copilotPackage.js";
import {
  buildCopilotAgentsListUrl,
  bulkGetPackageDetails,
  bulkSetBlockedState,
  bulkUpdatePackageAccess,
  GraphPackagesClient,
  updatePackageAccess,
  verifyPackageAccessApplied,
  type FetchLike,
} from "./graphPackages.js";

describe("GraphPackagesClient", () => {
  it("builds the Copilot agents list URL with the required filter", () => {
    const url = new URL(buildCopilotAgentsListUrl());

    expect(url.origin).toBe("https://graph.microsoft.com");
    expect(url.pathname).toBe("/v1.0/copilot/admin/catalog/packages");
    expect(url.searchParams.get("$filter")).toBe(
      "supportedHosts/any(h:h eq 'Copilot')",
    );
  });

  it("follows Microsoft Graph pagination while listing agents", async () => {
    const fetcher = vi.fn<FetchLike>(async (input) => {
      const url = input.toString();

      if (url.includes("page=2")) {
        return Response.json({
          value: [
            {
              id: "P_2",
              displayName: "Second",
              isBlocked: true,
              supportedHosts: ["Copilot"],
            },
          ],
        });
      }

      return Response.json({
        value: [
          {
            id: "P_1",
            displayName: "First",
            isBlocked: false,
            supportedHosts: ["Copilot"],
          },
        ],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?page=2",
      });
    });

    const client = new GraphPackagesClient(fetcher);
    const agents = await client.listCopilotAgents("token");

    expect(agents.map((agent) => agent.id)).toEqual(["P_1", "P_2"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries transient failures while reading package details", async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "ServiceUnavailable", message: "Try again" } },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ id: "P_1", displayName: "First", isBlocked: false }),
      );
    const retryDelay = vi.fn(async () => undefined);
    const client = new GraphPackagesClient(fetcher, {
      maxAttempts: 2,
      delay: retryDelay,
    });

    await expect(
      client.getPackageDetails("token", "P_1"),
    ).resolves.toMatchObject({ id: "P_1" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledTimes(1);
  });

  it("replaces the selected collection and preserves the other collection", async () => {
    const fetcher = vi.fn<FetchLike>(async (_url, init) =>
      init?.method === "PATCH"
        ? new Response(null, { status: 204 })
        : Response.json({
            id: "P_1",
            displayName: "First",
            isBlocked: false,
            allowedUsersAndGroups: [
              { resourceType: "group", resourceId: "old-group" },
            ],
            acquireUsersAndGroups: [
              { resourceType: "user", resourceId: "installed-user" },
            ],
          }),
    );
    const client = new GraphPackagesClient(fetcher);

    const result = await updatePackageAccess(client, "token", "P_1", {
      target: "availability",
      mode: "replace",
      scope: "specific",
      principals: [
        { resourceType: "group", resourceId: "group-1" },
        { resourceType: "user", resourceId: "user-1" },
      ],
    });

    expect(result).toMatchObject({
      changed: true,
      previousCount: 1,
      resultingCount: 2,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1];
    expect(url.toString()).toBe(
      "https://graph.microsoft.com/beta/copilot/admin/catalog/packages/P_1",
    );
    expect(init).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(init?.body))).toEqual({
      allowedUsersAndGroups: [
        { resourceType: "group", resourceId: "group-1" },
        { resourceType: "user", resourceId: "user-1" },
      ],
      acquireUsersAndGroups: [
        { resourceType: "user", resourceId: "installed-user" },
      ],
    });
  });

  it("refuses to update when the unselected collection is missing", async () => {
    class FakeClient extends GraphPackagesClient {
      patchPackageAccess = vi.fn();

      override async getPackageDetails(): Promise<CopilotPackageDetail> {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "some",
          allowedUsersAndGroups: [
            { resourceType: "group", resourceId: "old-group" },
          ],
        };
      }
    }

    const client = new FakeClient();

    await expect(
      updatePackageAccess(client, "token", "P_1", {
        target: "availability",
        mode: "replace",
        scope: "specific",
        principals: [{ resourceType: "group", resourceId: "new-group" }],
      }),
    ).rejects.toMatchObject({ code: "incomplete_package_access_state" });
    expect(client.patchPackageAccess).not.toHaveBeenCalled();
  });

  it("skips a replace when the selected collection already matches", async () => {
    class FakeClient extends GraphPackagesClient {
      patchPackageAccess = vi.fn();

      override async getPackageDetails(): Promise<CopilotPackageDetail> {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          allowedUsersAndGroups: [
            { resourceType: "user", resourceId: "user-1" },
            { resourceType: "group", resourceId: "group-1" },
          ],
        };
      }
    }

    const client = new FakeClient();
    const result = await updatePackageAccess(client, "token", "P_1", {
      target: "availability",
      mode: "replace",
      scope: "specific",
      principals: [
        { resourceType: "group", resourceId: "GROUP-1" },
        { resourceType: "user", resourceId: "USER-1" },
      ],
    });

    expect(result).toMatchObject({
      changed: false,
      previousCount: 2,
      resultingCount: 2,
    });
    expect(client.patchPackageAccess).not.toHaveBeenCalled();
  });

  it("merges package access for add mode and skips a no-op", async () => {
    class FakeClient extends GraphPackagesClient {
      patches: Array<Record<string, PackageAccessEntity[]>> = [];

      override async getPackageDetails(): Promise<CopilotPackageDetail> {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          allowedUsersAndGroups: [
            { resourceType: "user", resourceId: "allowed-user" },
          ],
          acquireUsersAndGroups: [
            { resourceType: "group", resourceId: "group-1" },
          ],
        };
      }

      override async patchPackageAccess(
        _accessToken: string,
        _id: string,
        payload: Record<string, PackageAccessEntity[]>,
      ) {
        this.patches.push(payload);
      }
    }

    const client = new FakeClient();
    const noOp = await updatePackageAccess(client, "token", "P_1", {
      target: "installation",
      mode: "add",
      scope: "specific",
      principals: [{ resourceType: "group", resourceId: "group-1" }],
    });
    const changed = await updatePackageAccess(client, "token", "P_1", {
      target: "installation",
      mode: "add",
      scope: "specific",
      principals: [{ resourceType: "user", resourceId: "user-2" }],
    });

    expect(noOp.changed).toBe(false);
    expect(changed).toMatchObject({
      changed: true,
      previousCount: 1,
      resultingCount: 2,
    });
    expect(client.patches).toEqual([
      {
        allowedUsersAndGroups: [
          { resourceType: "user", resourceId: "allowed-user" },
        ],
        acquireUsersAndGroups: [
          { resourceType: "group", resourceId: "group-1" },
          { resourceType: "user", resourceId: "user-2" },
        ],
      },
    ]);
  });

  it("does not narrow all-user access in add mode", async () => {
    class FakeClient extends GraphPackagesClient {
      patchPackageAccess = vi.fn();

      override async getPackageDetails(): Promise<CopilotPackageDetail> {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "all",
          allowedUsersAndGroups: [
            { resourceType: "group", resourceId: "group-existing" },
          ],
        };
      }
    }

    const client = new FakeClient();
    const result = await updatePackageAccess(client, "token", "P_1", {
      target: "availability",
      mode: "add",
      scope: "specific",
      principals: [{ resourceType: "group", resourceId: "group-1" }],
    });

    expect(result.changed).toBe(false);
    expect(client.patchPackageAccess).not.toHaveBeenCalled();
  });

  it("recognizes legacy some-user status in add mode", async () => {
    class FakeClient extends GraphPackagesClient {
      patchPackageAccess = vi.fn();

      override async getPackageDetails(): Promise<CopilotPackageDetail> {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "allowedForSome",
          allowedUsersAndGroups: [],
          acquireUsersAndGroups: [],
        };
      }
    }

    const client = new FakeClient();
    await updatePackageAccess(client, "token", "P_1", {
      target: "availability",
      mode: "add",
      scope: "specific",
      principals: [{ resourceType: "group", resourceId: "group-1" }],
    });

    expect(client.patchPackageAccess).toHaveBeenCalledWith("token", "P_1", {
      allowedUsersAndGroups: [{ resourceType: "group", resourceId: "group-1" }],
      acquireUsersAndGroups: [],
    });
  });

  it("does not skip a replacement when the status scope differs", async () => {
    class FakeClient extends GraphPackagesClient {
      patchPackageAccess = vi.fn();

      override async getPackageDetails(): Promise<CopilotPackageDetail> {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "all",
          allowedUsersAndGroups: [],
          acquireUsersAndGroups: [],
        };
      }
    }

    const client = new FakeClient();
    const result = await updatePackageAccess(client, "token", "P_1", {
      target: "availability",
      mode: "replace",
      scope: "none",
      principals: [],
    });

    expect(result.changed).toBe(true);
    expect(client.patchPackageAccess).toHaveBeenCalledWith("token", "P_1", {
      allowedUsersAndGroups: [],
      acquireUsersAndGroups: [],
    });
  });

  it("rejects a PATCH that Graph accepts without changing effective access", () => {
    expect(() =>
      verifyPackageAccessApplied(
        {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "all",
          allowedUsersAndGroups: [],
        },
        {
          target: "availability",
          mode: "replace",
          scope: "none",
          principals: [],
        },
        [],
        {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          deployedTo: "none",
          acquireUsersAndGroups: [],
        },
      ),
    ).toThrow("Effective access is still All users");
  });

  it("rejects a PATCH when Graph reports the scope but not the principals", () => {
    expect(() =>
      verifyPackageAccessApplied(
        {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "some",
          allowedUsersAndGroups: [
            { resourceType: "group", resourceId: "different-group" },
          ],
        },
        {
          target: "availability",
          mode: "replace",
          scope: "specific",
          principals: [{ resourceType: "group", resourceId: "group-1" }],
        },
        [{ resourceType: "group", resourceId: "group-1" }],
        {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          deployedTo: "none",
          acquireUsersAndGroups: [],
        },
      ),
    ).toThrow("did not apply the requested Specific users or groups");
  });

  it("rejects a PATCH that changes the unselected access setting", () => {
    expect(() =>
      verifyPackageAccessApplied(
        {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "none",
          deployedTo: "none",
          allowedUsersAndGroups: [],
          acquireUsersAndGroups: [],
        },
        {
          target: "availability",
          mode: "replace",
          scope: "none",
          principals: [],
        },
        [],
        {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "all",
          deployedTo: "all",
          allowedUsersAndGroups: [],
          acquireUsersAndGroups: [],
        },
      ),
    ).toThrow("changed the unselected Installed for access setting");
  });

  it("rejects add mode when the current access scope is ambiguous", async () => {
    class FakeClient extends GraphPackagesClient {
      override async getPackageDetails() {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
        };
      }
    }

    await expect(
      updatePackageAccess(new FakeClient(), "token", "P_1", {
        target: "availability",
        mode: "add",
        scope: "specific",
        principals: [{ resourceType: "group", resourceId: "group-1" }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "ambiguous_access_scope" });
  });

  it("summarizes best-effort bulk access updates", async () => {
    class FakeClient extends GraphPackagesClient {
      private updatedIds = new Set<string>();

      override async listCopilotAgents() {
        return [
          { id: "P_1", displayName: "Already assigned", isBlocked: false },
          { id: "P_2", displayName: "Updates", isBlocked: false },
          { id: "P_3", displayName: "Fails", isBlocked: false },
        ];
      }

      override async getPackageDetails(
        _accessToken: string,
        id: string,
      ): Promise<CopilotPackageDetail> {
        if (id === "P_3") {
          throw new AppError(403, "Authorization_RequestDenied", "denied");
        }

        return {
          id,
          displayName: id,
          isBlocked: false,
          availableTo:
            id === "P_1" || this.updatedIds.has(id) ? "some" : "none",
          acquireUsersAndGroups: [],
          allowedUsersAndGroups:
            id === "P_1" || this.updatedIds.has(id)
              ? [{ resourceType: "group", resourceId: "group-1" }]
              : [],
        };
      }

      override async patchPackageAccess(_accessToken: string, id: string) {
        this.updatedIds.add(id);
      }
    }

    const events: string[] = [];
    const result = await bulkUpdatePackageAccess(
      new FakeClient(),
      "token",
      {
        target: "availability",
        mode: "add",
        scope: "specific",
        principals: [{ resourceType: "group", resourceId: "group-1" }],
      },
      {
        packageIds: ["P_1", "P_2", "P_3", "P_missing"],
        writePauseMs: 0,
        onPackageStart: (agent) => {
          events.push(`start:${agent.id}`);
        },
        onPackageResult: (item) => {
          events.push(`result:${item.id}:${item.status}`);
        },
      },
    );

    expect(result).toMatchObject({
      total: 4,
      succeeded: 1,
      skipped: 1,
      failed: 2,
      accessUpdate: { target: "availability", mode: "add" },
    });
    expect(result.results.find((item) => item.id === "P_1")).toMatchObject({
      status: "skipped",
      accessResult: { changed: false, previousCount: 1, resultingCount: 1 },
    });
    expect(result.results.find((item) => item.id === "P_3")).toMatchObject({
      status: "failed",
      errorCode: "Authorization_RequestDenied",
    });
    expect(events).toContain("result:P_missing:failed");
  });

  it("summarizes best-effort bulk block results", async () => {
    class FakeClient extends GraphPackagesClient {
      override async listCopilotAgents() {
        return [
          { id: "P_1", displayName: "Ready", isBlocked: false },
          { id: "P_2", displayName: "Already blocked", isBlocked: true },
          { id: "P_3", displayName: "Fails", isBlocked: false },
        ];
      }

      override async blockPackage(_accessToken: string, id: string) {
        if (id === "P_3") {
          throw new AppError(403, "Forbidden", "blocked by policy", {
            graph: {
              error: { code: "Forbidden", message: "blocked by policy" },
            },
          });
        }
      }
    }

    const result = await bulkSetBlockedState(new FakeClient(), "token", true, {
      writePauseMs: 0,
    });

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results.map((item) => item.status).sort()).toEqual([
      "failed",
      "skipped",
      "succeeded",
    ]);
    expect(result.results.find((item) => item.id === "P_3")).toMatchObject({
      status: "failed",
      message: "blocked by policy",
      errorCode: "Forbidden",
      errorDetails: {
        graph: { error: { code: "Forbidden", message: "blocked by policy" } },
      },
    });
  });

  it("reports bulk package starts before package results", async () => {
    class FakeClient extends GraphPackagesClient {
      override async listCopilotAgents() {
        return [{ id: "P_1", displayName: "Ready", isBlocked: false }];
      }

      override async blockPackage() {}
    }

    const events: string[] = [];

    await bulkSetBlockedState(new FakeClient(), "token", true, {
      writePauseMs: 0,
      onPackageStart: (agent) => {
        events.push(`start:${agent.id}`);
      },
      onPackageResult: (result) => {
        events.push(`result:${result.id}:${result.status}`);
      },
    });

    expect(events).toEqual(["start:P_1", "result:P_1:succeeded"]);
  });

  it("keeps package results stable when progress hooks fail", async () => {
    class FakeClient extends GraphPackagesClient {
      override async listCopilotAgents() {
        return [
          { id: "P_1", displayName: "Ready", isBlocked: false },
          { id: "P_2", displayName: "Already blocked", isBlocked: true },
        ];
      }

      override async blockPackage() {}
    }

    const result = await bulkSetBlockedState(new FakeClient(), "token", true, {
      writePauseMs: 0,
      onPackageStart: () => {
        throw new Error("progress unavailable");
      },
      onPackageResult: () => {
        throw new Error("audit unavailable");
      },
    });

    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results.map((item) => item.status).sort()).toEqual([
      "skipped",
      "succeeded",
    ]);
    expect(result.sideEffectErrors).toEqual([
      { phase: "start", agentId: "P_2", message: "progress unavailable" },
      { phase: "result", agentId: "P_2", message: "audit unavailable" },
      { phase: "start", agentId: "P_1", message: "progress unavailable" },
      { phase: "result", agentId: "P_1", message: "audit unavailable" },
    ]);
  });

  it("falls back to the default concurrency for invalid values", async () => {
    class FakeClient extends GraphPackagesClient {
      override async listCopilotAgents() {
        return [{ id: "P_1", displayName: "Ready", isBlocked: false }];
      }

      override async blockPackage() {}
    }

    const result = await bulkSetBlockedState(new FakeClient(), "token", true, {
      writeConcurrency: 0,
      writePauseMs: 0,
    });

    expect(result.succeeded).toBe(1);
  });

  it("preserves plain-text Graph error messages", async () => {
    const client = new GraphPackagesClient(
      async () =>
        new Response("Service temporarily unavailable", { status: 503 }),
      { maxAttempts: 1 },
    );

    await expect(client.listCopilotAgents("token")).rejects.toMatchObject({
      status: 503,
      code: "graph_error",
      message: "Service temporarily unavailable",
      details: {
        graph: "Service temporarily unavailable",
      },
    });
  });

  it("limits bulk writes to selected packages", async () => {
    const blockedIds: string[] = [];

    class FakeClient extends GraphPackagesClient {
      override async listCopilotAgents() {
        return [
          { id: "P_1", displayName: "Ready", isBlocked: false },
          { id: "P_2", displayName: "Already blocked", isBlocked: true },
          { id: "P_3", displayName: "Not selected", isBlocked: false },
        ];
      }

      override async blockPackage(_accessToken: string, id: string) {
        blockedIds.push(id);
      }
    }

    const result = await bulkSetBlockedState(new FakeClient(), "token", true, {
      packageIds: ["P_1", "P_2", "P_missing"],
      writePauseMs: 0,
    });

    expect(blockedIds).toEqual(["P_1"]);
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results.map((item) => item.id).sort()).toEqual([
      "P_1",
      "P_2",
      "P_missing",
    ]);
  });

  it("summarizes best-effort bulk detail results", async () => {
    class FakeClient extends GraphPackagesClient {
      override async getPackageDetails(_accessToken: string, id: string) {
        if (id === "P_2") {
          throw new Error("detail unavailable");
        }

        return {
          id,
          displayName: id === "P_1" ? "First" : "Third",
          isBlocked: false,
          sensitivity: "Unspecified",
        };
      }
    }

    const result = await bulkGetPackageDetails(
      new FakeClient(),
      "token",
      ["P_1", "P_2", "P_3"],
      { detailConcurrency: 2 },
    );

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results.map((item) => item.status)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
  });
});
