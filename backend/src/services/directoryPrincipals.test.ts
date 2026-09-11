import { describe, expect, it, vi } from "vitest";
import {
  buildGroupSearchUrl,
  buildUserSearchUrl,
  DirectoryPrincipalsClient,
  validateDirectoryUrl,
} from "./directoryPrincipals.js";
import type { FetchLike } from "./graphPackages.js";

const userId = "11111111-1111-4111-8111-111111111111";
const securityGroupId = "22222222-2222-4222-8222-222222222222";
const microsoft365GroupId = "33333333-3333-4333-8333-333333333333";
const distributionGroupId = "44444444-4444-4444-8444-444444444444";

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
              id: userId,
              displayName: "Adele Vance",
              mail: "adele@example.com",
            },
          ],
        });
      }

      return Response.json({
        value: [
          {
            id: securityGroupId,
            displayName: "Security Team",
            groupTypes: [],
            securityEnabled: true,
          },
          {
            id: microsoft365GroupId,
            displayName: "Marketing",
            groupTypes: ["Unified"],
            securityEnabled: false,
          },
          {
            id: distributionGroupId,
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
      result.some((principal) => principal.resourceId === distributionGroupId),
    ).toBe(false);
  });

  it("rejects overlong directory searches before calling Graph", async () => {
    const fetcher = vi.fn<FetchLike>();

    await expect(
      new DirectoryPrincipalsClient(fetcher).search("token", "x".repeat(121)),
    ).rejects.toMatchObject({ status: 400, code: "invalid_directory_search" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects directory requests outside the documented Graph origin and paths", () => {
    expect(() => validateDirectoryUrl("https://unapproved.invalid/v1.0/users")).toThrowError(expect.objectContaining({ code: "invalid_provider_link" }));
    expect(() => validateDirectoryUrl("https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages")).toThrowError(expect.objectContaining({ code: "invalid_provider_link" }));
    expect(() => validateDirectoryUrl("https://user:password@graph.microsoft.com/v1.0/groups")).toThrowError(expect.objectContaining({ code: "invalid_provider_link" }));
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
      [{ resourceType: "user", resourceId: userId }],
    );

    expect(missing[0]).toMatchObject({
      displayName: userId,
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
        { resourceType: "group", resourceId: securityGroupId },
      ]),
    ).rejects.toMatchObject({
      status: 403,
      code: "Authorization_RequestDenied",
    });
  });

  it("preserves existing unsupported group labels during resolution", async () => {
    const fetcher = vi.fn<FetchLike>(async () =>
      Response.json({
        id: distributionGroupId,
        displayName: "Newsletter",
        groupTypes: [],
        securityEnabled: false,
      }),
    );

    const [resolved] = await new DirectoryPrincipalsClient(fetcher).resolve(
      "token",
      [{ resourceType: "group", resourceId: distributionGroupId }],
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
      resourceId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));

    const result = await new DirectoryPrincipalsClient(fetcher).resolve(
      "token",
      principals,
    );

    expect(result).toHaveLength(24);
    expect(peakRequests).toBeLessThanOrEqual(8);
  });

  it("rejects duplicate requests and exact identity redirection", async () => {
    const redirected = vi.fn<FetchLike>(async () => Response.json({
      id: "99999999-9999-4999-8999-999999999999",
      displayName: "Different user",
    }));
    const client = new DirectoryPrincipalsClient(redirected);

    await expect(client.resolve("token", [
      { resourceType: "user", resourceId: userId },
      { resourceType: "user", resourceId: userId.toUpperCase() },
    ])).rejects.toMatchObject({ code: "duplicate_principal" });
    expect(redirected).not.toHaveBeenCalled();

    await expect(client.resolve("token", [{ resourceType: "user", resourceId: userId }]))
      .rejects.toMatchObject({ code: "principal_identity_mismatch" });
  });
});
