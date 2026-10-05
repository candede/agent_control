import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentInventoryFilters, type AgentFilterValues } from "./AgentInventoryFilters";
import { getInventoryFacets } from "../api/client";
import { encodeInventoryFacet } from "../../../backend/src/types/inventoryFacets";

vi.mock("../api/client", async original => ({ ...await original<typeof import("../api/client")>(), getInventoryFacets: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const defaults: AgentFilterValues = {
  search: "", packageType: undefined, platform: undefined, availability: undefined, host: undefined,
  endUserAccess: "all", reportedUsage: "all", management: "all", relevance: "all",
  status: "all", createdWithinDays: "", publisher: undefined, environmentId: undefined,
  sortBy: "displayName", sortDirection: "asc",
};
const options = {
  types: [
    { value: "firstParty", label: "firstParty" }, { value: "thirdParty", label: "thirdParty" },
    { value: "shared", label: "shared" }, { value: "lob", label: "lob" },
    { value: "futureType", label: "futureType" },
  ],
  platforms: [{ value: "studio", label: "Copilot Studio" }],
  availability: [{ value: "some", label: "Some users" }],
  hosts: [{ value: "Teams", label: "Teams" }],
  publishers: [{ value: "Contoso", label: "Contoso" }],
  environments: [{ value: "environment-a", label: "Finance" }],
};
beforeEach(() => {
  vi.mocked(getInventoryFacets).mockImplementation(async (_selection, field) => {
    const fields: Partial<Record<Parameters<typeof getInventoryFacets>[1], keyof typeof options>> = {
      type: "types", platform: "platforms", availableTo: "availability", host: "hosts", publisher: "publishers", environmentId: "environments",
    };
    const key = fields[field];
    const value = key ? options[key] : [];
    return { value, total: value.length, nextCursor: null };
  });
});

function setup(initial: Partial<AgentFilterValues> = {}) {
  const changed = vi.fn();
  const error = vi.fn();
  function Filters() {
    const [values, setValues] = useState({ ...defaults, ...initial });
    return <>
      <AgentInventoryFilters selectionId="selected-fixture" values={values} options={options} loading={false}
        onChange={patch => { changed(patch); setValues(current => ({ ...current, ...patch })); }}
        onClear={() => setValues(current => ({ ...defaults, sortBy: current.sortBy, sortDirection: current.sortDirection }))}
        onError={error} />
      <button type="button">Outside</button>
    </>;
  }
  render(<Filters />);
  return { changed, error, user: userEvent.setup() };
}

describe("inventory filter toolbar", () => {
  it.each([
    { matchingCount: 0, loading: false, text: "0 matching agents" },
    { matchingCount: 1, loading: false, text: "1 matching agent" },
    { matchingCount: 1093, loading: false, text: "1,093 matching agents" },
    { matchingCount: 1093, loading: true, text: "Updating... matching agents" },
    { matchingCount: undefined, loading: false, text: "Unavailable matching agents" },
  ])("shows the current matching total without treating pending or missing data as zero: $text", ({ matchingCount, loading, text }) => {
    render(<AgentInventoryFilters values={defaults} options={options} loading={loading}
      matchingCount={matchingCount} onChange={vi.fn()} onClear={vi.fn()} onError={vi.fn()} />);
    expect(screen.getByRole("status", { name: "Matching agents" })).toHaveTextContent(text);
  });

  it.each<Partial<AgentFilterValues>>([{ packageType: "firstParty" }, { search: "policy" }, { host: "Teams" }])(
    "keeps Clear filters with the query controls and only renders a chip row for detailed restrictions: %j", initial => {
      setup(initial);
      const clear = screen.getByRole("button", { name: "Clear filters" });
      expect(clear.closest(".agent-query-bar")).not.toBeNull();
      expect(clear.closest(".agent-filter-chips")).toBeNull();
      expect(document.querySelectorAll(".agent-filter-chips")).toHaveLength(initial.host ? 1 : 0);
    },
  );

  it("offers only the saved Graph types and passes their exact values through", async () => {
    const { user, changed } = setup();
    const selector = screen.getByRole("combobox", { name: "Show agents" });
    await screen.findByRole("option", { name: "futureType" });
    expect(within(selector).getAllByRole("option").map(option => option.getAttribute("value")))
      .toEqual(["", ...options.types.map(option => encodeInventoryFacet(option.value))]);
    for (const type of options.types) {
      await user.selectOptions(selector, encodeInventoryFacet(type.value));
      expect(changed).toHaveBeenLastCalledWith({ packageType: type.value });
      expect(selector).toHaveValue(encodeInventoryFacet(type.value));
    }
    await user.selectOptions(selector, "Built by your org");
    expect(changed).toHaveBeenLastCalledWith({ packageType: "lob" });
    expect(selector).toHaveValue(encodeInventoryFacet("lob"));
  });

  it("retains a bookmarked type missing from the current catalog without silently broadening results", async () => {
    const { user } = setup({ packageType: "noLongerPresent" });
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue(encodeInventoryFacet("noLongerPresent"));
    expect(screen.getByRole("option", { name: "noLongerPresent" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue("");
  });

  it("keeps only everyday controls visible and makes every detailed filter keyboard accessible", async () => {
    const { user } = setup();
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.getByRole("searchbox", { name: "Search" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Filters" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = within(screen.getByRole("dialog", { name: "Filter agents" }));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(dialog.getByRole("combobox", { name: "Built with" })).toHaveFocus();
    for (const name of ["Built with", "End-user access", "Reported usage", "Management", "Assigned access", "Host", "Publisher", "Package status", "Environment", "Sort"]) {
      expect(dialog.getByRole("combobox", { name })).toBeVisible();
    }
    expect(dialog.getByRole("spinbutton", { name: "Created within days" })).toBeVisible();
    expect(dialog.getByRole("searchbox", { name: "Search environments" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows bookmarked restrictions without opening a panel and removes them independently", async () => {
    const { user, changed } = setup({
      host: "Teams", publisher: "Contoso", createdWithinDays: "30", environmentId: "environment-a",
    });
    expect(screen.getByRole("button", { name: "Filters, 4 active" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Remove environment filter" })).toHaveTextContent("Finance");
    expect(screen.getByRole("button", { name: "Remove created within filter" })).toHaveTextContent("30 days");
    await user.click(screen.getByRole("button", { name: "Remove host filter" }));
    expect(changed).toHaveBeenLastCalledWith({ host: undefined });
    expect(screen.getByRole("button", { name: "Filters, 3 active" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Filters, 3 active" }));
    expect(screen.getByRole("combobox", { name: "Host" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Publisher" })).toHaveValue(encodeInventoryFacet("Contoso"));
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveValue(encodeInventoryFacet("environment-a"));
  });

  it("applies filters immediately, preserves them on outside dismissal, and resets without changing sort", async () => {
    const { user, changed } = setup();
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "policy");
    await user.selectOptions(screen.getByRole("combobox", { name: "Show agents" }), encodeInventoryFacet("firstParty"));
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Built with" }), encodeInventoryFacet("studio"));
    expect(changed).toHaveBeenLastCalledWith({ platform: "studio" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "lastModifiedAt:desc");
    expect(changed).toHaveBeenLastCalledWith({ sortBy: "lastModifiedAt", sortDirection: "desc" });
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove built with filter" })).toHaveTextContent("Copilot Studio");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: "Filters" })).toHaveFocus();
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Remove built with filter" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("lastModifiedAt:desc");
    expect(screen.getByRole("combobox", { name: "Built with" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Reset filters" })).toBeDisabled();
  });

  it("keeps unavailable environment identities visible and removable", async () => {
    const { user } = setup({ environmentId: "missing-environment" });
    expect(screen.getByRole("button", { name: "Remove environment filter" })).toHaveTextContent("missing-environment");
    await user.click(screen.getByRole("button", { name: "Filters, 1 active" }));
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveValue(encodeInventoryFacet("missing-environment"));
    expect(screen.getByRole("option", { name: "missing-environment" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close filters" }));
    expect(screen.getByRole("button", { name: "Filters, 1 active" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Remove environment filter" }));
    expect(screen.getByRole("button", { name: "Filters" })).toBeVisible();
  });

  it("combines Graph types with independent evidence filters and removes each without changing the type", async () => {
    const { user, changed } = setup();
    await screen.findByRole("option", { name: "3rd party agents" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Show agents" }), encodeInventoryFacet("thirdParty"));
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "End-user access" }), "available");
    await user.selectOptions(screen.getByRole("combobox", { name: "Reported usage" }), "used");
    await user.selectOptions(screen.getByRole("combobox", { name: "Management" }), "organization_managed");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue(encodeInventoryFacet("thirdParty"));
    expect(screen.getByRole("button", { name: "Filters, 3 active" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove reported usage filter" }));
    expect(changed).toHaveBeenLastCalledWith({ reportedUsage: "all" });
    expect(screen.getByRole("button", { name: "Remove end-user access filter" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove management filter" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue(encodeInventoryFacet("thirdParty"));
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: /Remove .* filter/ })).not.toBeInTheDocument();
  });

  it("preserves keyboard focus when applying an environment or resetting the panel", async () => {
    const { user, changed } = setup();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    const environment = screen.getByRole("combobox", { name: "Environment" });
    await user.selectOptions(environment, encodeInventoryFacet("environment-a"));
    expect(environment).toHaveFocus();
    expect(changed).toHaveBeenLastCalledWith({ environmentId: "environment-a" });
    expect(screen.getByRole("dialog", { name: "Filter agents" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getByRole("combobox", { name: "Built with" })).toHaveFocus();
    expect(environment).toHaveValue("");
  });

  it("fits the anchored panel into the remaining viewport and repositions on scroll", async () => {
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    let anchorTop = window.innerHeight - 470;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("agent-filter-picker")
        ? new DOMRect(600, anchorTop, 90, 36) : originalBounds.call(this);
    });
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    const dialog = screen.getByRole("dialog", { name: "Filter agents" });
    expect(dialog).toHaveAttribute("data-side", "below");
    expect(dialog.style.getPropertyValue("--agent-filter-max-height")).toBe("408px");
    anchorTop = window.innerHeight - 60;
    fireEvent.scroll(window);
    expect(dialog).toHaveAttribute("data-side", "above");
    expect(dialog.style.getPropertyValue("--agent-filter-max-height")).toBe("560px");
    anchorTop = 80;
    fireEvent(window, new Event("resize"));
    expect(dialog).toHaveAttribute("data-side", "below");
    expect(screen.getByRole("combobox", { name: "Built with" })).toHaveFocus();
  });

  it("clamps both horizontal edges and clears its anchor offset in fixed layout", async () => {
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    let right = 530;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("agent-filter-picker")) return new DOMRect(right - 90, 220, 90, 36);
      if (this.classList.contains("agent-filter-popover")) return new DOMRect(right - 600, 266, 600, 400);
      return originalBounds.call(this);
    });
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    const dialog = screen.getByRole("dialog", { name: "Filter agents" });
    expect(dialog.style.getPropertyValue("--agent-filter-right")).toBe("-86px");
    right = window.innerWidth + 20;
    fireEvent.scroll(window);
    expect(dialog.style.getPropertyValue("--agent-filter-right")).toBe("36px");
    vi.stubGlobal("innerWidth", 360);
    fireEvent(window, new Event("resize"));
    expect(dialog.style.getPropertyValue("--agent-filter-right")).toBe("");
    expect(dialog.style.getPropertyValue("--agent-filter-max-height")).toBe("");
    expect(screen.getByRole("combobox", { name: "Built with" })).toHaveFocus();
  });

  it("surfaces invalid view and sort choices instead of silently changing the query", async () => {
    const { user, error, changed } = setup();
    const selector = screen.getByRole("combobox", { name: "Show agents" });
    const unsupported = document.createElement("option");
    unsupported.value = "unsupported";
    selector.append(unsupported);
    fireEvent.change(selector, { target: { value: "unsupported" } });
    expect(error).toHaveBeenLastCalledWith("Choose a saved inventory facet option.");
    await user.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "unsupported" } });
    expect(error).toHaveBeenLastCalledWith("Choose a supported agent sort order.");
    expect(changed).not.toHaveBeenCalled();
  });
});
