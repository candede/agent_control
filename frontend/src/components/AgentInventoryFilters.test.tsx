import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentInventoryFilters, type AgentFilterValues } from "./AgentInventoryFilters";

afterEach(() => vi.restoreAllMocks());

const defaults: AgentFilterValues = {
  search: "", packageType: "", platform: "all", availability: "all", host: "all",
  endUserAccess: "all", reportedUsage: "all", management: "all", relevance: "all",
  status: "all", createdWithinDays: "", publisher: "all", environmentId: "",
  sortBy: "displayName", sortDirection: "asc",
};
const options = {
  types: [
    { value: "firstParty", label: "1st party agents" }, { value: "thirdParty", label: "3rd party agents" },
    { value: "shared", label: "Shared in your organization" }, { value: "lob", label: "Built by your org" },
    { value: "futureType", label: "futureType" },
  ],
  platforms: [{ value: "studio", label: "Copilot Studio" }],
  availability: [{ value: "available:some", label: "Some users" }],
  hosts: [{ value: "Teams", label: "Teams" }],
  publishers: [{ value: "Contoso", label: "Contoso" }],
  environments: [{ value: "environment-a", label: "Finance" }],
};

function setup(initial: Partial<AgentFilterValues> = {}) {
  const changed = vi.fn();
  const error = vi.fn();
  function Filters() {
    const [values, setValues] = useState({ ...defaults, ...initial });
    return <>
      <AgentInventoryFilters values={values} options={options} loading={false}
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
    expect(within(selector).getAllByRole("option").map(option => option.getAttribute("value")))
      .toEqual(["", ...options.types.map(option => option.value)]);
    for (const type of options.types) {
      await user.selectOptions(selector, type.value);
      expect(changed).toHaveBeenLastCalledWith({ packageType: type.value });
      expect(selector).toHaveAttribute("title", `Graph package type: ${type.value}`);
    }
    await user.selectOptions(selector, "Built by your org");
    expect(changed).toHaveBeenLastCalledWith({ packageType: "lob" });
    expect(selector).toHaveValue("lob");
  });

  it("retains a bookmarked type missing from the current catalog without silently broadening results", async () => {
    const { user } = setup({ packageType: "noLongerPresent" });
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue("noLongerPresent");
    expect(screen.getByRole("option", { name: "Not in saved catalog: noLongerPresent" })).toBeVisible();
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
    expect(changed).toHaveBeenLastCalledWith({ host: "all" });
    expect(screen.getByRole("button", { name: "Filters, 3 active" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Filters, 3 active" }));
    expect(screen.getByRole("combobox", { name: "Host" })).toHaveValue("all");
    expect(screen.getByRole("combobox", { name: "Publisher" })).toHaveValue("Contoso");
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveValue("environment-a");
  });

  it("applies filters immediately, preserves them on outside dismissal, and resets without changing sort", async () => {
    const { user, changed } = setup();
    await user.type(screen.getByRole("searchbox", { name: "Search" }), "policy");
    await user.selectOptions(screen.getByRole("combobox", { name: "Show agents" }), "firstParty");
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Built with" }), "studio");
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
    expect(screen.getByRole("combobox", { name: "Built with" })).toHaveValue("all");
    expect(screen.getByRole("button", { name: "Reset filters" })).toBeDisabled();
  });

  it("keeps unavailable environment identities visible and removable", async () => {
    const { user } = setup({ environmentId: "missing-environment" });
    expect(screen.getByRole("button", { name: "Remove environment filter" })).toHaveTextContent("missing-environment");
    await user.click(screen.getByRole("button", { name: "Filters, 1 active" }));
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveValue("missing-environment");
    expect(screen.getByRole("option", { name: "Not in saved inventory: missing-environment" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close filters" }));
    expect(screen.getByRole("button", { name: "Filters, 1 active" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Remove environment filter" }));
    expect(screen.getByRole("button", { name: "Filters" })).toBeVisible();
  });

  it("combines Graph types with independent evidence filters and removes each without changing the type", async () => {
    const { user, changed } = setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Show agents" }), "thirdParty");
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "End-user access" }), "available");
    await user.selectOptions(screen.getByRole("combobox", { name: "Reported usage" }), "used");
    await user.selectOptions(screen.getByRole("combobox", { name: "Management" }), "organization_managed");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue("thirdParty");
    expect(screen.getByRole("button", { name: "Filters, 3 active" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove reported usage filter" }));
    expect(changed).toHaveBeenLastCalledWith({ reportedUsage: "all" });
    expect(screen.getByRole("button", { name: "Remove end-user access filter" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove management filter" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue("thirdParty");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("combobox", { name: "Show agents" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: /Remove .* filter/ })).not.toBeInTheDocument();
  });

  it("preserves keyboard focus when applying an environment or resetting the panel", async () => {
    const { user, changed } = setup();
    await user.click(screen.getByRole("button", { name: "Filters" }));
    const environment = screen.getByRole("combobox", { name: "Environment" });
    await user.selectOptions(environment, "environment-a");
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

  it("surfaces invalid view and sort choices instead of silently changing the query", async () => {
    const { user, error, changed } = setup();
    fireEvent.change(screen.getByRole("combobox", { name: "Show agents" }), { target: { value: "unsupported" } });
    expect(error).toHaveBeenLastCalledWith("Choose a package type from the saved catalog.");
    await user.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "unsupported" } });
    expect(error).toHaveBeenLastCalledWith("Choose a supported agent sort order.");
    expect(changed).not.toHaveBeenCalled();
  });
});
