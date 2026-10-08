import { createRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getInventoryFacets } from "../api/client";
import { InventoryFacetSelect } from "./InventoryFacetSelect";
import { encodeInventoryFacet, type InventoryFacetValue } from "../../../backend/src/types/inventoryFacets";

vi.mock("../api/client", async original => ({ ...await original<typeof import("../api/client")>(), getInventoryFacets: vi.fn() }));
beforeEach(() => { vi.mocked(getInventoryFacets).mockReset(); });
const props = { selectionId: "selected-fixture", field: "availableTo" as const, label: "Assigned access", allLabel: "Any assignment" };

describe("bounded selected inventory facets", () => {
  it("keeps facet search across same-owner selection changes but clears it for a different principal", async () => {
    vi.mocked(getInventoryFacets).mockResolvedValue({ value: [], total: 5001, nextCursor: "next" });
    const { rerender } = render(<InventoryFacetSelect {...props} scopeKey="principal-a" onChange={vi.fn()} />);
    const search = await screen.findByRole("searchbox");
    await userEvent.setup().type(search, "literal");
    rerender(<InventoryFacetSelect {...props} selectionId="next-selection" scopeKey="principal-a" onChange={vi.fn()} />);
    expect(search).toHaveValue("literal");
    await waitFor(() => expect(getInventoryFacets).toHaveBeenLastCalledWith("next-selection", props.field,
      { search: "literal", cursor: undefined }, expect.objectContaining({ signal: expect.any(AbortSignal) })));
    rerender(<InventoryFacetSelect {...props} selectionId="other-selection" scopeKey="principal-b" onChange={vi.fn()} />);
    expect(await screen.findByRole("searchbox")).toHaveValue("");
    await waitFor(() => expect(getInventoryFacets).toHaveBeenLastCalledWith("other-selection", props.field,
      { search: undefined, cursor: undefined }, expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it("keeps bounded option paging inside the compact select without another toolbar control", async () => {
    vi.mocked(getInventoryFacets).mockResolvedValue({ value: [{ value: "first", label: "First" }], total: 5001, nextCursor: "next" });
    render(<InventoryFacetSelect {...props} compact onChange={vi.fn()} />);
    await screen.findByRole("option", { name: "First" });
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(document.querySelector("details")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await userEvent.setup().selectOptions(screen.getByRole("combobox"), "next-options");
    await waitFor(() => expect(getInventoryFacets).toHaveBeenLastCalledWith(props.selectionId, props.field,
      { search: undefined, cursor: "next" }, expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it.each(["selection", "account"] as const)("does not revive retired search, cursor or options on a %s revisit", async boundary => {
    const read = vi.mocked(getInventoryFacets).mockResolvedValue({
      value: [{ value: "old", label: "Retired option" }], total: 5001, nextCursor: "next",
    });
    const initial = { ...props, field: "environmentId" as const, scopeKey: "owner-a", onChange: vi.fn() };
    const { rerender } = render(<InventoryFacetSelect {...initial} />);
    await screen.findByRole("option", { name: /Retired option/ });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "literal" } });
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "false"));
    await userEvent.setup().selectOptions(screen.getByRole("combobox"), "next-options");
    await waitFor(() => expect(read).toHaveBeenLastCalledWith(props.selectionId, "environmentId",
      { search: "literal", cursor: "next" }, expect.anything()));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "false"));
    read.mockImplementation(() => new Promise(() => {}));
    rerender(<InventoryFacetSelect {...initial} selectionId={boundary === "selection" ? "selection-b" : props.selectionId}
      scopeKey={boundary === "account" ? "owner-b" : "owner-a"} />);
    expect(screen.queryByRole("option", { name: /Retired option/ })).not.toBeInTheDocument();
    const pending = read.mock.calls.at(-1)![3]!.signal!;
    rerender(<InventoryFacetSelect {...initial} />);
    expect(pending.aborted).toBe(true);
    expect(screen.getByRole("searchbox")).toHaveValue(boundary === "selection" ? "literal" : "");
    expect(read).toHaveBeenLastCalledWith(props.selectionId, "environmentId",
      { search: boundary === "selection" ? "literal" : undefined, cursor: undefined }, expect.anything());
    expect(screen.queryByRole("option", { name: /Retired option/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "true");
  });

  it("preserves the focused facet search while clearing, loading and recovering from an error", async () => {
    const read = vi.mocked(getInventoryFacets).mockResolvedValue({ value: [], total: 5001, nextCursor: "next" });
    render(<InventoryFacetSelect {...props} onChange={vi.fn()} />);
    const search = await screen.findByRole("searchbox");
    const user = userEvent.setup();
    await user.type(search, "literal");
    let reject!: (error: Error) => void;
    read.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await user.clear(search);
    expect(search).toBeInTheDocument();
    expect(search).toHaveFocus();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "true");
    await act(async () => { reject(new Error("Facet search unavailable")); });
    expect(screen.getByRole("alert")).toHaveTextContent("Facet search unavailable");
    expect(search).toHaveFocus();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "false");
    read.mockResolvedValue({ value: [], total: 0, nextCursor: null });
    await user.type(search, "new");
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    await user.clear(search);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "false"));
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
  });

  it("bounds option searches to the API limit without requesting rejected extra input", async () => {
    const read = vi.mocked(getInventoryFacets).mockResolvedValue({ value: [], total: 0, nextCursor: null });
    render(<InventoryFacetSelect {...props} field="environmentId" onChange={vi.fn()} />);
    const search = screen.getByRole("searchbox");
    const bounded = "x".repeat(256);
    fireEvent.change(search, { target: { value: bounded } });
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "false"));
    expect(read).toHaveBeenCalledTimes(2);
    await userEvent.setup().type(search, "y");
    expect(search).toHaveValue(bounded);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(props.selectionId, "environmentId",
      { search: bounded, cursor: undefined }, expect.anything());
  });

  it("treats whitespace-only search edits as the current unfiltered page without reloading or moving focus", async () => {
    const read = vi.mocked(getInventoryFacets)
      .mockResolvedValueOnce({ value: [{ value: "first", label: "First" }], total: 51, nextCursor: "next" })
      .mockResolvedValue({ value: [{ value: "last", label: "Last" }], total: 51, nextCursor: null });
    render(<InventoryFacetSelect {...props} field="environmentId" onChange={vi.fn()} />);
    const search = screen.getByRole("searchbox");
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "First (first)" });
    await user.type(search, " ");
    expect(search).toHaveValue(" ");
    expect(search).toHaveFocus();
    expect(read).toHaveBeenCalledOnce();
    expect(screen.getByRole("option", { name: "First (first)" })).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox"), "next-options");
    await screen.findByRole("option", { name: "Last (last)" });
    expect(read).toHaveBeenLastCalledWith(props.selectionId, "environmentId",
      { search: undefined, cursor: "next" }, expect.anything());
    await user.type(search, "\u00a0 ");
    await user.clear(search);
    expect(search).toHaveFocus();
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("option", { name: "First options..." })).toBeVisible();
    expect(screen.getByRole("option", { name: "Last (last)" })).toBeVisible();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["page", "error"] as const)("cancels a literal search cleared to whitespace and ignores its late %s", async outcome => {
    let resolve!: (page: Awaited<ReturnType<typeof getInventoryFacets>>) => void;
    let reject!: (error: Error) => void;
    let resolveUnfiltered!: (page: Awaited<ReturnType<typeof getInventoryFacets>>) => void;
    const read = vi.mocked(getInventoryFacets)
      .mockResolvedValueOnce({ value: [{ value: "first", label: "First" }], total: 51, nextCursor: "next" })
      .mockResolvedValueOnce({ value: [{ value: "last", label: "Last" }], total: 51, nextCursor: null })
      .mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }))
      .mockImplementationOnce(() => new Promise(done => { resolveUnfiltered = done; }));
    const invalidated = vi.fn(), changed = vi.fn();
    render(<InventoryFacetSelect {...props} field="environmentId" onChange={changed} onInvalidated={invalidated} />);
    await screen.findByRole("option", { name: "First (first)" });
    await userEvent.setup().selectOptions(screen.getByRole("combobox"), "next-options");
    await screen.findByRole("option", { name: "Last (last)" });
    const search = screen.getByRole("searchbox");
    search.focus();
    fireEvent.change(search, { target: { value: " literal " } });
    expect(read).toHaveBeenLastCalledWith(props.selectionId, "environmentId",
      { search: " literal ", cursor: undefined }, expect.anything());
    const literalSignal = read.mock.calls[2][3]!.signal!;
    fireEvent.change(search, { target: { value: " " } });
    expect(literalSignal.aborted).toBe(true);
    expect(read).toHaveBeenLastCalledWith(props.selectionId, "environmentId",
      { search: undefined, cursor: undefined }, expect.anything());
    const unfilteredSignal = read.mock.calls[3][3]!.signal!;
    fireEvent.change(search, { target: { value: "   " } });
    expect(read).toHaveBeenCalledTimes(4);
    expect(unfilteredSignal.aborted).toBe(false);
    expect(search).toHaveFocus();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      if (outcome === "page") resolve({ value: [{ value: "retired", label: "Retired" }], total: 1, nextCursor: null });
      else reject(new ApiError(409, "selection_invalidated", "Retired selection"));
    });
    expect(screen.queryByRole("option", { name: /Retired/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(invalidated).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "true");
    await act(async () => { resolveUnfiltered({ value: [], total: 0, nextCursor: null }); });
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "false");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it.each(["internal", "external"] as const)("returns retry focus to the stable select (%s ref) while retrying only the failed option page", async refSource => {
    let resolve!: (page: Awaited<ReturnType<typeof getInventoryFacets>>) => void;
    const read = vi.mocked(getInventoryFacets)
      .mockResolvedValueOnce({ value: [{ value: "first", label: "First" }], total: 51, nextCursor: "next" })
      .mockRejectedValueOnce(new Error("Next options unavailable"))
      .mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const onChange = vi.fn();
    const selectRef = refSource === "external" ? createRef<HTMLSelectElement>() : undefined;
    render(<InventoryFacetSelect {...props} selectRef={selectRef} onChange={onChange} />);
    const select = screen.getByRole("combobox");
    await screen.findByRole("option", { name: "First" });
    const user = userEvent.setup();
    await user.selectOptions(select, "next-options");
    expect(screen.queryByRole("option", { name: "First" })).not.toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: "Retry options" });
    expect(read).toHaveBeenCalledTimes(2);
    await user.click(retry);
    expect(select).toHaveFocus();
    expect(select).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenLastCalledWith(props.selectionId, props.field,
      { search: undefined, cursor: "next" }, expect.anything());
    await act(async () => { resolve({ value: [{ value: "last", label: "Last" }], total: 51, nextCursor: null }); });
    expect(select).toHaveFocus();
    expect(select).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("option", { name: "Last" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "More options..." })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not reload for display-only changes and delivers failure to the current invalidation callback", async () => {
    let reject!: (error: Error) => void;
    const read = vi.mocked(getInventoryFacets).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const previousInvalidated = vi.fn(), invalidated = vi.fn();
    const { rerender } = render(<InventoryFacetSelect {...props} scopeKey="owner"
      onChange={vi.fn()} onInvalidated={previousInvalidated} />);
    const signal = read.mock.calls[0][3]!.signal!;
    rerender(<InventoryFacetSelect {...props} scopeKey="owner" loading compact value="selected" label="Updated label"
      onChange={vi.fn()} onInvalidated={invalidated} onOptionLabel={vi.fn()} />);
    expect(read).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);
    await act(async () => { reject(new ApiError(409, "selection_invalidated", "Selection expired")); });
    expect(invalidated).toHaveBeenCalledOnce();
    expect(previousInvalidated).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(["page", "error"] as const)("does not revive an earlier %s while a revisited search is loading", async outcome => {
    const read = vi.mocked(getInventoryFacets);
    if (outcome === "page") read.mockResolvedValueOnce({ value: [{ value: "old", label: "Retired option" }], total: 1, nextCursor: null });
    else read.mockRejectedValueOnce(new Error("Retired failure"));
    render(<InventoryFacetSelect {...props} field="environmentId" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "false"));
    read.mockImplementation(() => new Promise(() => {}));
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "other" } });
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "true");
    fireEvent.change(search, { target: { value: "" } });
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[1][3]!.signal!.aborted).toBe(true);
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("option", { name: /Retired option/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps every literal, null, combined and unrestricted choice distinct in the DOM and callbacks", async () => {
    const values: InventoryFacetValue[] = ["all", "__unknown__", "__some_or_all__", "available:all", "~null", "~some-or-all", null, { kind: "some-or-all" }];
    vi.mocked(getInventoryFacets).mockResolvedValue({ value: values.map((value, index) => ({ value, label: `Choice ${index}` })), total: values.length, nextCursor: null });
    const change = vi.fn();
    function Facet() {
      const [value, setValue] = useState<InventoryFacetValue>();
      return <InventoryFacetSelect {...props} value={value} onChange={value => { setValue(value); change(value); }} />;
    }
    render(<Facet />);
    await screen.findByRole("option", { name: "Choice 7" });
    const select = screen.getByRole("combobox", { name: props.label }), user = userEvent.setup();
    const keys = within(select).getAllByRole("option").map(option => option.getAttribute("value"));
    expect(new Set(keys).size).toBe(9);
    for (const value of values) {
      await user.selectOptions(select, encodeInventoryFacet(value));
      expect(change).toHaveBeenLastCalledWith(value);
      expect(select).toHaveValue(encodeInventoryFacet(value));
    }
    await user.selectOptions(select, "");
    expect(change).toHaveBeenLastCalledWith(undefined);
  });

  it("aborts abandoned selection reads and never displays a late previous-principal page", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof getInventoryFacets>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof getInventoryFacets>>>(done => { resolve = done; });
    const read = vi.mocked(getInventoryFacets).mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ value: [{ value: "new", label: "New option" }], total: 1, nextCursor: null });
    const { rerender, unmount } = render(<InventoryFacetSelect {...props} onChange={vi.fn()} />);
    const first = read.mock.calls[0][3]!.signal!;
    rerender(<InventoryFacetSelect {...props} selectionId="another-principal-selection" onChange={vi.fn()} />);
    expect(first.aborted).toBe(true);
    await screen.findByRole("option", { name: "New option" });
    await act(async () => { resolve({ value: [{ value: "private", label: "Old private option" }], total: 1, nextCursor: null }); });
    expect(screen.queryByRole("option", { name: "Old private option" })).not.toBeInTheDocument();
    const second = read.mock.calls[1][3]!.signal!;
    unmount();
    expect(second.aborted).toBe(true);
  });

  it("withdraws options and reloads when only the account scope changes", async () => {
    let resolve!: (page: Awaited<ReturnType<typeof getInventoryFacets>>) => void;
    const read = vi.mocked(getInventoryFacets)
      .mockResolvedValueOnce({ value: [{ value: "private", label: "Previous account option" }], total: 1, nextCursor: null })
      .mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const onChange = vi.fn();
    const { rerender } = render(<InventoryFacetSelect {...props} scopeKey="owner-a" onChange={onChange} />);
    await screen.findByRole("option", { name: "Previous account option" });
    const firstSignal = read.mock.calls[0][3]!.signal!;
    rerender(<InventoryFacetSelect {...props} scopeKey="owner-b" onChange={onChange} />);
    expect(firstSignal.aborted).toBe(true);
    expect(screen.queryByRole("option", { name: "Previous account option" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "true");
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => { resolve({ value: [{ value: "current", label: "Current account option" }], total: 1, nextCursor: null }); });
    expect(screen.getByRole("option", { name: "Current account option" })).toBeVisible();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "false");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a late invalidation from a previous account with the same selection ID", async () => {
    let reject!: (error: Error) => void;
    const read = vi.mocked(getInventoryFacets)
      .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }))
      .mockResolvedValueOnce({ value: [], total: 0, nextCursor: null });
    const invalidated = vi.fn();
    const { rerender } = render(<InventoryFacetSelect {...props} scopeKey="owner-a" onChange={vi.fn()} onInvalidated={invalidated} />);
    rerender(<InventoryFacetSelect {...props} scopeKey="owner-b" onChange={vi.fn()} onInvalidated={invalidated} />);
    await act(async () => { reject(new ApiError(409, "selection_invalidated", "Previous account expired")); });
    expect(read.mock.calls[0][3]!.signal!.aborted).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(invalidated).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-busy", "false");
  });

  it("replaces each selected option page instead of accumulating or walking all options", async () => {
    const read = vi.mocked(getInventoryFacets);
    read.mockResolvedValueOnce({ value: Array.from({ length: 50 }, (_, i) => ({ value: `first-${i}`, label: `First ${i}` })), total: 5001, nextCursor: "next" })
      .mockResolvedValueOnce({ value: [{ value: "last", label: "Last option" }], total: 5001, nextCursor: null });
    render(<InventoryFacetSelect {...props} onChange={vi.fn()} />);
    await screen.findByRole("option", { name: "First 49" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("option")).toHaveLength(52);
    await userEvent.setup().selectOptions(screen.getByRole("combobox"), "next-options");
    await screen.findByRole("option", { name: "Last option" });
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.queryByRole("option", { name: "First 0" })).not.toBeInTheDocument();
    expect(read.mock.calls[1][2]).toMatchObject({ cursor: "next" });
    expect(screen.queryByRole("option", { name: "More options..." })).not.toBeInTheDocument();
  });

  it("reports selection invalidation and retries only on explicit request", async () => {
    const read = vi.mocked(getInventoryFacets).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Selection expired"))
      .mockResolvedValueOnce({ value: [], total: 0, nextCursor: null });
    const invalidated = vi.fn();
    render(<InventoryFacetSelect {...props} onChange={vi.fn()} onInvalidated={invalidated} />);
    await screen.findByText("Selection expired");
    expect(invalidated).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry options" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(read).toHaveBeenCalledTimes(2);
  });
});
