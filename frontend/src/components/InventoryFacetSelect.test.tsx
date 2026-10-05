import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getInventoryFacets } from "../api/client";
import { InventoryFacetSelect } from "./InventoryFacetSelect";
import { encodeInventoryFacet, type InventoryFacetValue } from "../../../backend/src/types/inventoryFacets";

vi.mock("../api/client", async original => ({ ...await original<typeof import("../api/client")>(), getInventoryFacets: vi.fn() }));
beforeEach(() => vi.mocked(getInventoryFacets).mockReset());
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
