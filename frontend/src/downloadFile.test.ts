import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downloadFile } from "./downloadFile";

const create = vi.fn<(blob: Blob) => string>();
const revoke = vi.fn<(url: string) => void>();
let clicked: HTMLAnchorElement[];

beforeEach(() => {
  vi.useFakeTimers();
  create.mockReset().mockImplementation(() => `blob:download-${create.mock.calls.length}`);
  revoke.mockReset();
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = create;
    static revokeObjectURL = revoke;
  });
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.isConnected).toBe(true);
    clicked.push(this);
  });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  document.querySelectorAll("a[download]").forEach(anchor => anchor.remove());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("activates the exact file once and defers anchor and object URL cleanup", () => {
  const blob = new Blob(["bounded-audit-data"], { type: "text/csv" });
  downloadFile("administrative-audit.csv", blob);
  expect(create).toHaveBeenCalledExactlyOnceWith(blob);
  expect(clicked).toHaveLength(1);
  expect(clicked[0]).toHaveAttribute("download", "administrative-audit.csv");
  expect(clicked[0]).toHaveAttribute("href", "blob:download-1");
  expect(clicked[0]).toBeInTheDocument();
  expect(revoke).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);

  vi.runAllTimers();
  expect(clicked[0]).not.toBeInTheDocument();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:download-1");
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up repeated downloads independently even when their filename and blob match", () => {
  const blob = new Blob(["same saved data"]);
  const unrelated = document.createElement("a");
  unrelated.href = "/help";
  document.body.append(unrelated);
  try {
    downloadFile("saved.csv", blob);
    downloadFile("saved.csv", blob);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls).toEqual([[blob], [blob]]);
    expect(clicked).toHaveLength(2);
    expect(clicked[0]).not.toBe(clicked[1]);
    expect(clicked.map(anchor => anchor.href)).toEqual(["blob:download-1", "blob:download-2"]);
    expect(document.querySelectorAll("a[download='saved.csv']")).toHaveLength(2);
    expect(revoke).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(document.querySelectorAll("a[download='saved.csv']")).toHaveLength(0);
    expect(revoke.mock.calls).toEqual([["blob:download-1"], ["blob:download-2"]]);
    expect(unrelated).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    unrelated.remove();
  }
});

it.each(["append", "click"] as const)("preserves a failed %s error, releases its resources, and permits a retry", stage => {
  const failure = new Error(`Download ${stage} failed`);
  if (stage === "append") vi.spyOn(document.body, "append").mockImplementationOnce(() => { throw failure; });
  else vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => { throw failure; });
  const blob = new Blob(["saved data"]);

  expect(() => downloadFile("saved.csv", blob)).toThrow(failure);
  expect(create).toHaveBeenCalledExactlyOnceWith(blob);
  vi.runAllTimers();
  expect(document.querySelector("a[download]")).not.toBeInTheDocument();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:download-1");

  downloadFile("saved.csv", blob);
  expect(clicked).toHaveLength(1);
  expect(clicked[0]).toHaveAttribute("href", "blob:download-2");
  vi.runAllTimers();
  expect(clicked[0]).not.toBeInTheDocument();
  expect(revoke.mock.calls).toEqual([["blob:download-1"], ["blob:download-2"]]);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not activate a download or schedule cleanup when object URL creation fails", () => {
  const failure = new Error("Object URL unavailable");
  create.mockImplementationOnce(() => { throw failure; });
  expect(() => downloadFile("saved.csv", new Blob(["saved data"]))).toThrow(failure);
  expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  expect(document.querySelector("a[download]")).not.toBeInTheDocument();
  expect(revoke).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
