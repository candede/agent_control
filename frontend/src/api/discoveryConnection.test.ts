// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { getDiscoveryConnection } from "./client";
afterEach(() => vi.unstubAllGlobals());

it("uses the employee connection endpoint, not privileged metadata, and retains request cancellation", async () => {
  const value = { state: "available", resourceUrl: "https://mcp.example.test/mcp" };
  const fetcher = vi.fn().mockResolvedValue(Response.json(value));
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  expect(await getDiscoveryConnection(signal)).toEqual(value);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/discovery/connection", expect.objectContaining({ credentials: "include", signal }));
});
it.each([
  { state: "available", resourceUrl: "not-url" },
  { state: "available", resourceUrl: "https://mcp.example.test/mcp", tools: [] },
  { state: "not_configured", binding: {} },
  { state: "available", resourceUrl: "https://token@mcp.example.test/mcp" },
])("rejects malformed or privileged connection data (%#)", async value => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value)));
  await expect(getDiscoveryConnection()).rejects.toMatchObject({ code: "invalid_response" });
});
