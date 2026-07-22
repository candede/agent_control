import { describe, expect, it, vi } from "vitest";
import {
  buildGroupSearchUrl,
  buildUserSearchUrl,
  DirectoryPrincipalsClient,
} from "./directoryPrincipals.js";
import type { FetchLike } from "./graphPackages.js";

describe("DirectoryPrincipalsClient", () => {
  it("escapes directory search terms and bounds selected fields", () => {
    const userUrl = new URL(buildUserSearchUrl('Sales "East"', 25));
    const groupUrl = new URL(buildGroupSearchUrl('Sales "East"', 25));

    expect(userUrl.searchParams.get("$search")).toContain(
      'displayName:Sales \\"East\\"',
    );
    expect(userUrl.searchParams.get("$select")).toBe(
      "id,displayName,mail,userPrincipalName",
    );
    expect(userUrl.searchParams.get("$count")).toBe("true");
    expect(groupUrl.searchParams.get("$search")).toContain(
      'description:Sales \\"East\\"',
    );
    expect(groupUrl.searchParams.get("$count")).toBe("true");
  });

  it("returns users, security groups, and Microsoft 365 groups only", async () => {
    const fetcher = vi.fn<FetchLike>(async (input, init) => {
      expect(new Headers(init?.headers).get("ConsistencyLevel")).toBe(
        "eventual",
      );

      if (input.toString().includes("/users")) {
        return Response.json({
          value: [
            {
              id: "user-1",
              displayName: "Adele Vance",
              mail: "adele@example.com",
            },
          ],
        });
      }

      return Response.json({
        value: [
          {
            id: "group-security",
            displayName: "Security Team",
            groupTypes: [],
            securityEnabled: true,
          },
          {
            id: "group-m365",
            displayName: "Marketing",
            groupTypes: ["Unified"],
            securityEnabled: false,
          },
          {
            id: "group-distribution",
            displayName: "Newsletter",
            groupTypes: [],
            securityEnabled: false,
          },
        ],
      });
    });

    const result = await new DirectoryPrincipalsClient(fetcher).search(
      "token",
      "ma",
    );

    expect(result.map((principal) => principal.principalKind).sort()).toEqual([
      "microsoft365Group",
      "securityGroup",
      "user",
    ]);
    expect(
      result.some((principal) => principal.resourceId === "group-distribution"),
    ).toBe(false);
  });

  it("rejects overlong directory searches before calling Graph", async () => {
    const fetcher = vi.fn<FetchLike>();

    await expect(
      new DirectoryPrincipalsClient(fetcher).search("token", "x".repeat(121)),
    ).rejects.toMatchObject({ status: 400, code: "invalid_directory_search" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses raw IDs for missing principals but surfaces permission errors", async () => {
    const missingFetcher = vi.fn<FetchLike>(async () =>
      Response.json(
        { error: { code: "Request_ResourceNotFound", message: "missing" } },
        { status: 404 },
      ),
    );
    const missing = await new DirectoryPrincipalsClient(missingFetcher).resolve(
      "token",
      [{ resourceType: "user", resourceId: "deleted-user" }],
    );

    expect(missing[0]).toMatchObject({
      displayName: "deleted-user",
      principalKind: "unknown",
    });

    const forbiddenFetcher = vi.fn<FetchLike>(async () =>
      Response.json(
        { error: { code: "Authorization_RequestDenied", message: "denied" } },
        { status: 403 },
      ),
    );

    await expect(
      new DirectoryPrincipalsClient(forbiddenFetcher).resolve("token", [
        { resourceType: "group", resourceId: "group-1" },
      ]),
    ).rejects.toMatchObject({
      status: 403,
      code: "Authorization_RequestDenied",
    });
  });

  it("preserves existing unsupported group labels during resolution", async () => {
    const fetcher = vi.fn<FetchLike>(async () =>
      Response.json({
        id: "group-distribution",
        displayName: "Newsletter",
        groupTypes: [],
        securityEnabled: false,
      }),
    );

    const [resolved] = await new DirectoryPrincipalsClient(fetcher).resolve(
      "token",
      [{ resourceType: "group", resourceId: "group-distribution" }],
    );

    expect(resolved).toMatchObject({
      displayName: "Newsletter",
      principalKind: "unknown",
    });
  });

  it("bounds concurrent requests while resolving principals", async () => {
    let activeRequests = 0;
    let peakRequests = 0;
    const fetcher = vi.fn<FetchLike>(async (input) => {
      activeRequests += 1;
      peakRequests = Math.max(peakRequests, activeRequests);
      await Promise.resolve();
      activeRequests -= 1;
      const id = input.toString().split("/users/")[1].split("?")[0];
      return Response.json({ id, displayName: id });
    });
    const principals = Array.from({ length: 24 }, (_, index) => ({
      resourceType: "user",
      resourceId: `user-${index}`,
    }));

    const result = await new DirectoryPrincipalsClient(fetcher).resolve(
      "token",
      principals,
    );

    expect(result).toHaveLength(24);
    expect(peakRequests).toBeLessThanOrEqual(8);
  });
});
