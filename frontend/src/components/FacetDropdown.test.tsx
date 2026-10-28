import { createRef, type ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { FacetDropdown } from "./FacetDropdown";

const options = [
  { value: "", label: "All companies" },
  { value: "contoso", label: "Contoso" },
  { value: "contoso-holdings", label: "Contoso Holdings" },
  { value: "copper", label: "Copper" },
  { value: "fabrikam", label: "Fabrikam" },
];

function dropdown(overrides: Partial<ComponentProps<typeof FacetDropdown>> = {}) {
  const props = { label: "Company", value: "", options, disabled: false,
    onChange: vi.fn(), controlRef: createRef<HTMLButtonElement>(), ...overrides };
  const view = render(<FacetDropdown {...props} />);
  return { ...view, props, control: screen.getByRole("combobox", { name: "Company" }) };
}

function activeOption(control: HTMLElement) {
  const id = control.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
}

it("keeps the active prefix match when more matching characters are typed", () => {
  vi.spyOn(performance, "now").mockReturnValue(1000);
  const { control, props } = dropdown();
  fireEvent.keyDown(control, { key: "c" });
  expect(activeOption(control)).toHaveTextContent(/^Contoso$/);
  fireEvent.keyDown(control, { key: "o" });
  expect(activeOption(control)).toHaveTextContent(/^Contoso$/);
  fireEvent.keyDown(control, { key: "Enter" });
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith("contoso");
});

it("cycles matching options when the same initial is typed repeatedly", () => {
  vi.spyOn(performance, "now").mockReturnValue(1000);
  const { control, props } = dropdown();
  for (const label of ["Contoso", "Contoso Holdings", "Copper", "Contoso"]) {
    fireEvent.keyDown(control, { key: "c" });
    expect(activeOption(control)).toHaveTextContent(new RegExp(`^${label}$`));
  }
  expect(props.onChange).not.toHaveBeenCalled();
});

it.each([699, 700])("continues a longer prefix and observes the timeout at %i ms", elapsed => {
  const now = vi.spyOn(performance, "now").mockReturnValue(1000);
  const { control } = dropdown();
  for (const key of ["c", "o", "p"]) fireEvent.keyDown(control, { key });
  expect(activeOption(control)).toHaveTextContent(/^Copper$/);
  now.mockReturnValue(1000 + elapsed);
  fireEvent.keyDown(control, { key: "f" });
  expect(activeOption(control)).toHaveTextContent(elapsed < 700 ? /^Copper$/ : /^Fabrikam$/);
});

it.each(["Escape", "Tab", "trigger", "outside", "blur", "selection", "disabled"] as const)(
  "starts a fresh typeahead search after closing through %s", dismissal => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const { control, props, rerender } = dropdown();
    fireEvent.keyDown(control, { key: "c" });
    expect(screen.getByRole("listbox")).toBeVisible();
    if (dismissal === "Escape" || dismissal === "Tab") fireEvent.keyDown(control, { key: dismissal });
    else if (dismissal === "trigger") fireEvent.click(control);
    else if (dismissal === "outside") fireEvent.pointerDown(document.body);
    else if (dismissal === "blur") fireEvent.blur(control, { relatedTarget: document.body });
    else if (dismissal === "selection") fireEvent.keyDown(control, { key: "Enter" });
    else {
      rerender(<FacetDropdown {...props} disabled />);
      rerender(<FacetDropdown {...props} />);
    }
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.keyDown(control, { key: "f" });
    expect(activeOption(control)).toHaveTextContent(/^Fabrikam$/);
    expect(props.onChange).toHaveBeenCalledTimes(dismissal === "selection" ? 1 : 0);
  },
);

it.each(["Enter", " "])("selects exactly once with %j and retains trigger focus", async key => {
  const user = userEvent.setup();
  const { control, props } = dropdown();
  await user.click(control);
  await user.keyboard("{End}");
  await user.keyboard(key === "Enter" ? "{Enter}" : " ");
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith("fabrikam");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(control).toHaveFocus();
});

it("preserves the controlled selection until a keyboard choice is committed", () => {
  const { control, props } = dropdown({ value: "contoso" });
  fireEvent.click(control);
  expect(activeOption(control)).toHaveTextContent(/^Contoso$/);
  fireEvent.keyDown(control, { key: "ArrowUp" });
  fireEvent.keyDown(control, { key: "ArrowUp" });
  expect(activeOption(control)).toHaveTextContent(/^All companies$/);
  fireEvent.keyDown(control, { key: "End" });
  fireEvent.keyDown(control, { key: "ArrowDown" });
  expect(activeOption(control)).toHaveTextContent(/^Fabrikam$/);
  expect(screen.getByRole("option", { name: "Contoso" })).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(control, { key: "Home" });
  fireEvent.keyDown(control, { key: "Escape" });
  expect(control).toHaveTextContent("Contoso");
  expect(props.onChange).not.toHaveBeenCalled();
});

it("ignores modified characters without consuming a keyboard shortcut", () => {
  const { control, props } = dropdown();
  for (const modifier of ["altKey", "ctrlKey", "metaKey"]) {
    expect(fireEvent.keyDown(control, { key: "c", [modifier]: true })).toBe(true);
  }
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(props.onChange).not.toHaveBeenCalled();
});

it("allows pointer hover and selection without dismissing on an inside pointerdown", async () => {
  const user = userEvent.setup();
  const { control, props } = dropdown();
  await user.click(control);
  const option = screen.getByRole("option", { name: "Copper" });
  fireEvent.pointerDown(option);
  expect(screen.getByRole("listbox")).toBeVisible();
  await user.hover(option);
  expect(activeOption(control)).toBe(option);
  await user.click(option);
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith("copper");
  expect(control).toHaveFocus();
});

it("closes on Tab without preventing focus from moving to the next control", async () => {
  const user = userEvent.setup();
  const props = { label: "Company", value: "", options, disabled: false,
    onChange: vi.fn(), controlRef: createRef<HTMLButtonElement>() };
  render(<><FacetDropdown {...props} /><button>Next control</button></>);
  await user.click(screen.getByRole("combobox"));
  await user.tab();
  expect(screen.getByRole("button", { name: "Next control" })).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(props.onChange).not.toHaveBeenCalled();
});

it("keeps a disabled trigger focusable but blocks opening and selection", async () => {
  const user = userEvent.setup();
  const { control, props, rerender } = dropdown();
  await user.click(control);
  rerender(<FacetDropdown {...props} disabled />);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(control).toHaveFocus();
  expect(control).toHaveAttribute("aria-disabled", "true");
  expect(control).not.toBeDisabled();
  await user.click(control);
  await user.keyboard("{ArrowDown}{Enter}c ");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(props.onChange).not.toHaveBeenCalled();
});

it("treats an empty option list as unavailable and recovers when options arrive", () => {
  const { control, props, rerender } = dropdown({ options: [] });
  fireEvent.click(control);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(control).toHaveAttribute("aria-disabled", "true");
  expect(control).not.toHaveAttribute("aria-activedescendant");
  for (const key of ["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End", "c"]) {
    fireEvent.keyDown(control, { key });
  }
  expect(props.onChange).not.toHaveBeenCalled();
  rerender(<FacetDropdown {...props} options={options} />);
  fireEvent.keyDown(control, { key: "End" });
  fireEvent.keyDown(control, { key: "Enter" });
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith("fabrikam");
});

it("withdraws the popup and active descendant if all options are removed", () => {
  const { control, props, rerender } = dropdown();
  fireEvent.keyDown(control, { key: "End" });
  rerender(<FacetDropdown {...props} options={[]} />);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(control).toHaveAttribute("aria-expanded", "false");
  expect(control).not.toHaveAttribute("aria-activedescendant");
  expect(props.onChange).not.toHaveBeenCalled();
});
