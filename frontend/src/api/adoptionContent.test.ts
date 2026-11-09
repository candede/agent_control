import { afterEach, expect, it, vi } from "vitest";
import { readSharedLearning } from "./adoptionContent";

afterEach(() => vi.unstubAllGlobals());
it("reads safe employee learning through the existing credential/CSRF owner", async () => {
  const fetcher = vi.fn().mockImplementation(async () => Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  await readSharedLearning({ cursor: "current-actor-cursor", company: "Exact label" });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/discovery/learning", expect.objectContaining({
    method: "POST", credentials: "include",
  }));
  const init = fetcher.mock.calls[0][1];
  expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  expect(JSON.parse(init.body)).toEqual({ cursor: "current-actor-cursor", company: "Exact label" });
});
it("preserves the requested bounded shared-learning page size", async () => {
  const fetcher = vi.fn().mockImplementation(async () => Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  await readSharedLearning({ limit: 1 });
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ limit: 1 });
});
