import { afterEach, expect, it, vi } from "vitest";
import { downloadFile } from "./downloadFile";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("releases the bounded administrative audit download and its anchor", () => {
  vi.useFakeTimers();
  const blob = new Blob(["bounded-audit-data"], { type: "text/csv" });
  const create = vi.fn(() => "blob:audit"), revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  downloadFile("administrative-audit.csv", blob);
  expect(create).toHaveBeenCalledWith(blob);
  expect(document.querySelector("a[download='administrative-audit.csv']")).not.toBeNull();
  vi.runAllTimers();
  expect(document.querySelector("a[download='administrative-audit.csv']")).toBeNull();
  expect(revoke).toHaveBeenCalledWith("blob:audit");
});
