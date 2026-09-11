import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBlob } from "./agentExport";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("server-generated download delivery", () => {
  it("releases the object URL and removes its temporary download anchor", () => {
    vi.useFakeTimers();
    const blob = new Blob(["server-approved-data"], { type: "text/csv" });
    const create = vi.fn(() => "blob:fixture");
    const revoke = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    downloadBlob("inventory.csv", blob);
    expect(create).toHaveBeenCalledWith(blob);
    expect(document.querySelector("a[download='inventory.csv']")).not.toBeNull();
    vi.runAllTimers();
    expect(document.querySelector("a[download='inventory.csv']")).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:fixture");
  });
});
