import { describe, expect, it, vi } from "vitest";
import {
  buildCopilotAgentsListUrl,
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
          throw new Error("blocked by policy");
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
  });
});
