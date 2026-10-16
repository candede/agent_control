import { afterEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SavedAgentAbout } from "./SavedAgentAbout";
import { ApiError, getAgentAbout } from "../api/client";
import type { AgentAboutPage } from "../../../backend/src/types/savedReadContracts";

vi.mock("../api/client", async original => ({ ...await original<typeof import("../api/client")>(), getAgentAbout: vi.fn() }));
afterEach(() => vi.mocked(getAgentAbout).mockReset());
const source = { scopeId: "source-scope", identity: "Exact-package" };
const page: AgentAboutPage = {
  recordId: "agent:canonical", sourceScopeId: source.scopeId, sourceIdentity: source.identity, generationId: "generation",
  field: "long", state: "available", source: "graph_packages", observedAt: "2026-01-01T00:00:00Z", text: "First 🧭",
  provenance: { path: "longDescription", maturity: "ga" },
  totalBytes: 20, returnedBytes: 10, nextCursor: "pinned-next",
  selection: { id: "selection", revision: "1", evaluatedAt: "2026-01-01T00:00:00Z", validatedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2026-01-02T00:00:00Z", publicationRevisions: { graph_packages: "a".repeat(64), power_platform: "b".repeat(64), users: "c".repeat(64) } },
};
it("automatically displays the complete description without metadata or load-more controls", async () => {
  const first = "A".repeat(16_384), second = "B".repeat(16_384), last = "Complete description.";
  vi.mocked(getAgentAbout).mockResolvedValueOnce({ ...page, text: first })
    .mockResolvedValueOnce({ ...page, text: second, nextCursor: "last-page" })
    .mockResolvedValueOnce({ ...page, text: last, nextCursor: null });
  render(<SavedAgentAbout selectionId="selection" recordId={page.recordId} source={source} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect((await screen.findByLabelText("Agent description")).textContent).toBe(first + second + last);
  expect(getAgentAbout).toHaveBeenCalledTimes(3);
  expect(getAgentAbout).toHaveBeenNthCalledWith(2, "selection", page.recordId, source, "long",
    { cursor: "pinned-next", signal: expect.any(AbortSignal) });
  expect(getAgentAbout).toHaveBeenLastCalledWith("selection", page.recordId, source, "long",
    { cursor: "last-page", signal: expect.any(AbortSignal) });
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByText(/graph_packages|observed|bytes/)).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
});
it("uses exact native source and retains explicit missing instead of synthesizing description", async () => {
  vi.mocked(getAgentAbout).mockResolvedValue({ ...page, field: "native", source: "power_platform", state: "missing", text: null, nextCursor: null, totalBytes: 0, returnedBytes: 0 });
  const view = render(<SavedAgentAbout selectionId="selection" recordId={page.recordId} source={source} native />);
  expect(await screen.findByText("About text was not supplied by this saved source.")).toBeVisible();
  const signal = vi.mocked(getAgentAbout).mock.calls[0][4]!.signal!;
  view.unmount(); expect(signal.aborted).toBe(true);
});
it("invalidates expired selected text and never resumes against a substituted revision", async () => {
  vi.mocked(getAgentAbout).mockRejectedValue(new ApiError(409, "selection_invalidated", "The saved source changed."));
  const invalidated = vi.fn();
  render(<SavedAgentAbout selectionId="selection" recordId={page.recordId} source={source} onInvalidated={invalidated} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("The saved source changed.");
  expect(invalidated).toHaveBeenCalledOnce(); expect(getAgentAbout).toHaveBeenCalledOnce();
});
it("uses complete native text after missing long About and keeps its source on continuation", async () => {
  const nativeSource = { scopeId: "native-scope", identity: "Exact-native" };
  const nativePage: AgentAboutPage = { ...page, ...{ sourceScopeId: nativeSource.scopeId, sourceIdentity: nativeSource.identity },
    source: "power_platform", field: "native", provenance: { path: "properties.description", maturity: "observed" } };
  vi.mocked(getAgentAbout).mockResolvedValueOnce({ ...page, state: "missing", text: null, nextCursor: null })
    .mockResolvedValueOnce(nativePage).mockResolvedValueOnce({ ...nativePage, text: " Complete", nextCursor: null });
  render(<SavedAgentAbout selectionId="selection" recordId={page.recordId} source={source} nativeSource={nativeSource} />);
  expect(await screen.findByLabelText("Agent description")).toHaveTextContent("First 🧭 Complete");
  expect(getAgentAbout).toHaveBeenLastCalledWith("selection", page.recordId, nativeSource, "native",
    { cursor: "pinned-next", signal: expect.any(AbortSignal) });
});
it("preserves short fallback for completely empty long and native fields", async () => {
  vi.mocked(getAgentAbout).mockResolvedValueOnce({ ...page, text: "  ", nextCursor: null, totalBytes: 2 })
    .mockResolvedValueOnce({ ...page, field: "native", text: "", nextCursor: null, totalBytes: 0 })
    .mockResolvedValueOnce({ ...page, field: "short", text: "Saved short description", nextCursor: null });
  render(<SavedAgentAbout selectionId="selection" recordId={page.recordId} source={source}
    nativeSource={{ scopeId: "native-scope", identity: "Exact-native" }} />);
  expect(await screen.findByLabelText("Agent description")).toHaveTextContent("Saved short description");
  expect(getAgentAbout).toHaveBeenLastCalledWith("selection", page.recordId, source, "short", { signal: expect.any(AbortSignal) });
});
it("does not skip a full available source merely because its first segment is whitespace", async () => {
  vi.mocked(getAgentAbout).mockResolvedValueOnce({ ...page, text: "  " })
    .mockResolvedValueOnce({ ...page, text: "Later available text", nextCursor: null });
  render(<SavedAgentAbout selectionId="selection" recordId={page.recordId} source={source} />);
  expect(await screen.findByLabelText("Agent description")).toHaveTextContent("Later available text");
  expect(getAgentAbout).toHaveBeenCalledTimes(2);
  expect(getAgentAbout).toHaveBeenLastCalledWith("selection", page.recordId, source, "long",
    { cursor: "pinned-next", signal: expect.any(AbortSignal) });
});
it.each(["selection_invalidated", "backend_unavailable"])("surfaces %s during automatic continuation instead of displaying incomplete text", async code => {
  vi.mocked(getAgentAbout).mockResolvedValueOnce(page)
    .mockRejectedValueOnce(new ApiError(code === "selection_invalidated" ? 409 : 503, code, "The remaining description is unavailable."));
  const invalidated = vi.fn();
  render(<SavedAgentAbout selectionId="selection" recordId={page.recordId} source={source} onInvalidated={invalidated} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("The remaining description is unavailable.");
  expect(screen.queryByLabelText("Agent description")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  expect(getAgentAbout).toHaveBeenCalledTimes(2);
  expect(invalidated).toHaveBeenCalledTimes(code === "selection_invalidated" ? 1 : 0);
});
it("clears the previous description while loading a changed source scope", async () => {
  vi.mocked(getAgentAbout).mockResolvedValueOnce({ ...page, text: "Previous description", nextCursor: null });
  const view = render(<SavedAgentAbout selectionId="selection" recordId={page.recordId} source={source} />);
  expect(await screen.findByLabelText("Agent description")).toHaveTextContent("Previous description");
  const previousSignal = vi.mocked(getAgentAbout).mock.calls[0][4]!.signal!;
  const changedSource = { ...source, scopeId: "changed-scope" };
  vi.mocked(getAgentAbout).mockResolvedValueOnce({ ...page, sourceScopeId: changedSource.scopeId, text: "Current description", nextCursor: null });
  view.rerender(<SavedAgentAbout selectionId="selection" recordId={page.recordId} source={changedSource} />);
  expect(screen.queryByLabelText("Agent description")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Loading saved About text");
  expect(previousSignal.aborted).toBe(true);
  expect(await screen.findByLabelText("Agent description")).toHaveTextContent("Current description");
  expect(getAgentAbout).toHaveBeenLastCalledWith("selection", page.recordId, changedSource, "long", { signal: expect.any(AbortSignal) });
});
