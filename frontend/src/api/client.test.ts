import { afterEach, describe, expect, it, vi } from "vitest";

import {
  searchDirectoryPrincipals,
  updateAgentAccess,
  updateAgentsAccess,
  type PackageAccessReplacement,
  type PackageAccessUpdate,
} from "./client";

const accessUpdate: PackageAccessReplacement = {
  target: "availability",
  mode: "replace",
  scope: "specific",
  principals: [
    { resourceId: "user-1", resourceType: "user" },
    { resourceId: "group-1", resourceType: "group" },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("access API client", () => {
  it("encodes directory searches and limits", async () => {
    const fetchMock = mockJsonResponse({ value: [] });

    await searchDirectoryPrincipals("Research & Development", 40);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/directory/principals?search=Research+%26+Development&limit=40",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("sends a single-agent replacement to the encoded access route", async () => {
    const fetchMock = mockJsonResponse({ agent: {}, result: {} });

    await updateAgentAccess("package/with spaces", accessUpdate);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/package%2Fwith%20spaces/access",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify(accessUpdate),
      }),
    );
  });

  it("sends agent ids and Add semantics in one bulk request", async () => {
    const fetchMock = mockJsonResponse({ id: "job-1" });
    const addUpdate: PackageAccessUpdate = {
      ...accessUpdate,
      mode: "add",
    };

    await updateAgentsAccess(["agent-1", "agent-2"], addUpdate);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/agents/access",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ids: ["agent-1", "agent-2"], ...addUpdate }),
      }),
    );
  });
});

function mockJsonResponse(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
