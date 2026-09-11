import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import type { CapabilityView, SessionUser } from "./api/client";
import { providerActionAllowed } from "./capabilityState";
import { useCapabilities } from "./useCapabilities";

const user: SessionUser = { displayName: "Fixture", username: "fixture@example.invalid", homeAccountId: "fixture-a", roles: ["AgentControl.Reader"] };
function available(): CapabilityView {
  return { definition: capabilityDefinitions[0], decision: { capabilityId: "graph.package.read.delegated", status: "available", authorized: true, fresh: true, expiresAt: new Date(Date.now() + 1000).toISOString(), previewQualification: "not_required", remediation: [] } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("expires evidence without polling or calling the provider", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => Response.json({ value: [available()] })); vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(1100));
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(false);
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("hides prior account evidence and fences its pending probe", async () => {
  let finishProbe!: (value: Response) => void;
  let finishAccount!: (value: Response) => void;
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/probe")) return new Promise<Response>(done => { finishProbe = done; });
    if (++reads === 1) return Response.json({ value: [available()] });
    return new Promise<Response>(done => { finishAccount = done; });
  }));
  const { result, rerender } = renderHook(({ principal }) => useCapabilities(principal), { initialProps: { principal: user } });
  await waitFor(() => expect(result.current.views).toHaveLength(1));
  let probe!: Promise<void>;
  act(() => { probe = result.current.refresh("graph.package.read.delegated"); });
  rerender({ principal: { ...user, homeAccountId: "fixture-b" } });
  expect(result.current.views).toEqual([]);
  await act(async () => { finishProbe(Response.json(available().decision)); await probe; finishAccount(Response.json({ value: [] })); });
  expect(result.current.views).toEqual([]);
  expect(result.current.pending).toBeUndefined();
});