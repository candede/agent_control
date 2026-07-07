import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import {
  buildCopilotAgentsListUrl,
  bulkGetPackageDetails,
  bulkSetBlockedState,
  GraphPackagesClient,
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
