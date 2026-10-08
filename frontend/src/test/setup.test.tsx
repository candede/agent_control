import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { afterAll, describe, expect, it, vi } from "vitest";
import { SavedQueryProvider } from "../components/SavedQueryProvider";
import { useSavedQuery } from "../savedQueries";
import { deferred } from "./deferred";

const baseline = {
  fetch, AbortController, URL, setTimeout, setInterval,
  href: window.location.href,
  history: window.history.state,
  title: document.title,
  visibility: document.visibilityState,
  online: navigator.onLine,
  environment: import.meta.env.VITE_SETUP_OWNER,
};
const service = { read: () => "native" };
const read = vi.fn(() => "default");

describe("global test-environment teardown", () => {
  const activity: string[] = [];
  const pending = deferred<string>();
  let client: QueryClient;
  let signal: AbortSignal;
  let unmounted = false;
  let cleanupSawMocks = false;
  let cleanupSawFakeTimers = false;
  const transport = vi.fn();

  function Reader() {
    client = useQueryClient();
    const query = useSavedQuery({
      queryKey: ["saved", "setup-owner"],
      queryFn: context => { signal = context.signal; return pending.promise; },
      staleTime: Infinity,
    });
    useEffect(() => {
      const active = () => activity.push("active");
      const timer = setInterval(active, 60_000);
      window.addEventListener("focus", active);
      window.addEventListener("pageshow", active);
      document.addEventListener("visibilitychange", active);
      return () => {
        unmounted = true;
        cleanupSawMocks = fetch === transport;
        cleanupSawFakeTimers = vi.isFakeTimers();
        clearInterval(timer);
        window.removeEventListener("focus", active);
        window.removeEventListener("pageshow", active);
        document.removeEventListener("visibilitychange", active);
      };
    }, []);
    return <p>{query.data ?? "Loading previous owner"}</p>;
  }

  it("exercises an owner with pending work and deliberately leaves test-owned browser state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    vi.stubGlobal("fetch", transport);
    vi.stubGlobal("AbortController", class extends AbortController {});
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:previous-owner");
      static revokeObjectURL = vi.fn();
    });
    vi.stubEnv("VITE_SETUP_OWNER", "previous-owner");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.spyOn(service, "read").mockReturnValue("previous-owner");
    read.mockReturnValueOnce("previous-owner");
    window.localStorage.setItem("previous-owner", "private");
    window.sessionStorage.setItem("previous-owner", "private");
    vi.spyOn(Storage.prototype, "clear").mockImplementation(() => { throw new DOMException("Storage denied", "SecurityError"); });
    window.history.replaceState({ owner: "previous" }, "", "/agents?selected=private#details");
    document.title = "Previous owner";
    document.documentElement.setAttribute("data-owner", "previous");
    document.body.style.overflow = "hidden";
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    render(<SavedQueryProvider><Reader /></SavedQueryProvider>);
    expect(signal!.aborted).toBe(false);
    expect(client!.isFetching()).toBe(1);
    expect(read()).toBe("previous-owner");
    read.mockReturnValueOnce("unused previous response");
    setTimeout(() => activity.push("abandoned timer"), 60_000);
  });

  afterAll(async () => {
    expect(unmounted).toBe(true);
    expect(cleanupSawMocks).toBe(true);
    expect(cleanupSawFakeTimers).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(vi.isFakeTimers()).toBe(false);
    expect(globalThis.setTimeout).toBe(baseline.setTimeout);
    expect(globalThis.setInterval).toBe(baseline.setInterval);
    expect(Date.now()).toBeGreaterThan(0);
    expect(fetch).toBe(baseline.fetch);
    expect(AbortController).toBe(baseline.AbortController);
    expect(URL).toBe(baseline.URL);
    expect(import.meta.env.VITE_SETUP_OWNER).toBe(baseline.environment);
    expect(service.read()).toBe("native");
    expect(document.visibilityState).toBe(baseline.visibility);
    expect(navigator.onLine).toBe(baseline.online);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.href).toBe(baseline.href);
    expect(window.history.state).toEqual(baseline.history);
    expect(document.title).toBe(baseline.title);
    expect(document.documentElement).not.toHaveAttribute("data-owner");
    expect(document.body).not.toHaveAttribute("style");
    expect(document.body.childNodes).toHaveLength(0);
    expect(document.activeElement).toBe(document.body);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(activity).toEqual([]);
    pending.reject(new Error("Late previous-owner failure"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});

it("starts with reset mock responses and a fresh saved-query owner without replacing native cancellation", async () => {
  expect(read).not.toHaveBeenCalled();
  expect(read()).toBe("default");
  const controller = new AbortController();
  const listener = vi.fn();
  controller.signal.addEventListener("abort", listener);
  const reason = new Error("Native cancellation");
  controller.abort(reason);
  controller.abort(new Error("Ignored repeated abort"));
  expect(listener).toHaveBeenCalledOnce();
  expect(controller.signal.reason).toBe(reason);
  expect(() => controller.signal.throwIfAborted()).toThrow(reason);

  const currentRead = vi.fn(async () => "Current owner");
  function Reader() {
    const query = useSavedQuery({ queryKey: ["saved", "setup-owner"], queryFn: currentRead });
    return <p>{query.error?.message ?? query.data ?? "Loading current owner"}</p>;
  }
  render(<SavedQueryProvider><Reader /></SavedQueryProvider>);
  expect(await screen.findByText("Current owner")).toBeInTheDocument();
  expect(screen.queryByText("Late previous-owner failure")).not.toBeInTheDocument();
  expect(currentRead).toHaveBeenCalledOnce();
});
