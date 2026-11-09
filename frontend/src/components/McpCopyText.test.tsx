import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { McpCopyText } from "./McpCopyText";

const value = "  Exact instructions\n<script>inert</script> 🧪  ";
const writeText = vi.fn<(value: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
});

function pendingCopy() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

async function clickCopy() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy server instructions" }));
  });
}

it("copies exact text and reports success only after the clipboard accepts it", async () => {
  const pending = pendingCopy();
  writeText.mockReturnValueOnce(pending.promise);
  const { container } = render(<McpCopyText value={value} label="server instructions" />);
  await clickCopy();
  expect(writeText).toHaveBeenCalledExactlyOnceWith(value);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await act(async () => pending.resolve());
  expect(screen.getByRole("status")).toHaveTextContent("server instructions copied.");
  expect(screen.getByRole("button")).toHaveTextContent("Copied");
  expect(container.querySelector("script")).toBeNull();
});

it.each(["rejection", "synchronous error", "missing clipboard"])("reports %s without claiming success", async failure => {
  if (failure === "rejection") writeText.mockRejectedValueOnce(new Error("denied"));
  else if (failure === "synchronous error") writeText.mockImplementationOnce(() => { throw new Error("denied"); });
  else vi.stubGlobal("navigator", {});
  render(<McpCopyText value={value} label="server instructions" />);
  await clickCopy();
  expect(screen.getByRole("alert")).toHaveTextContent("Copy unavailable. Select and copy the text.");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByRole("button")).toHaveTextContent("Copy");
});

it("recovers from clipboard denial on the next attempt", async () => {
  writeText.mockRejectedValueOnce(new Error("denied"));
  render(<McpCopyText value={value} label="server instructions" />);
  await clickCopy();
  expect(screen.getByRole("alert")).toBeInTheDocument();
  await clickCopy();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("server instructions copied.");
});

it.each(["success", "failure"])("ignores an earlier clipboard %s after the latest attempt finishes", async outcome => {
  const pending = pendingCopy();
  writeText.mockReturnValueOnce(pending.promise);
  render(<McpCopyText value={value} label="server instructions" />);
  await clickCopy();
  if (outcome === "success") writeText.mockRejectedValueOnce(new Error("denied"));
  await clickCopy();
  await act(async () => {
    if (outcome === "success") pending.resolve();
    else pending.reject(new Error("denied"));
  });
  if (outcome === "success") {
    expect(screen.getByRole("alert")).toHaveTextContent("Copy unavailable");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  } else {
    expect(screen.getByRole("status")).toHaveTextContent("server instructions copied.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  }
});

it.each(["success", "failure"])("clears previous %s feedback while another copy is pending", async outcome => {
  if (outcome === "failure") writeText.mockRejectedValueOnce(new Error("denied"));
  render(<McpCopyText value={value} label="server instructions" />);
  await clickCopy();
  const pending = pendingCopy();
  writeText.mockReturnValueOnce(pending.promise);
  await clickCopy();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button")).toHaveTextContent("Copy");
  await act(async () => pending.resolve());
  expect(screen.getByRole("status")).toHaveTextContent("server instructions copied.");
});
