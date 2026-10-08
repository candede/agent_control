import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { PrincipalPicker } from "./PrincipalPicker";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("explicit directory searches", () => {
  it("does not search for short input and cancels superseded provider reads", async () => {
    let finish!: (value: { value: api.DirectoryPrincipal[] }) => void;
    const search = vi.spyOn(api, "searchDirectoryPrincipals")
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<PrincipalPicker selected={[]} onChange={vi.fn()} />);
    const input = screen.getByRole("searchbox", { name: "Add a user or group" });
    fireEvent.change(input, { target: { value: "A" } });
    expect(search).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Ada" } });
    await waitFor(() => expect(search).toHaveBeenCalledOnce());
    expect(search).toHaveBeenCalledWith("Ada", 40, { signal: expect.any(AbortSignal) });
    fireEvent.change(input, { target: { value: "" } });
    expect(search.mock.calls[0][2]?.signal?.aborted).toBe(true);
    await act(async () => finish({ value: [{
      resourceId: "old-user", resourceType: "user", principalKind: "user", displayName: "Old result",
    }] }));
    expect(screen.queryByText("Old result")).not.toBeInTheDocument();
    expect(screen.getByText("Enter at least two characters.")).toBeVisible();
  });

  it.each(["disabled", "unmounted"])("cancels pending provider reads when the picker becomes %s", async mode => {
    const search = vi.spyOn(api, "searchDirectoryPrincipals").mockImplementation(() => new Promise(() => {}));
    const { rerender, unmount } = render(<PrincipalPicker selected={[]} onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ada" } });
    await waitFor(() => expect(search).toHaveBeenCalledOnce());
    const signal = search.mock.calls[0][2]?.signal;
    if (mode === "disabled") rerender(<PrincipalPicker selected={[]} onChange={vi.fn()} disabled />);
    else unmount();
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText("Searching directory...")).not.toBeInTheDocument();
    if (mode === "disabled") {
      expect(screen.getByRole("status")).toHaveTextContent("Directory search is paused until editing resumes.");
      expect(screen.getByRole("group", { name: "Directory results" })).toHaveAttribute("aria-busy", "false");
    }
  });

  it("surfaces provider failures without automatic retries", async () => {
    const search = vi.spyOn(api, "searchDirectoryPrincipals").mockRejectedValue(new Error("Directory access unavailable"));
    render(<PrincipalPicker selected={[]} onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ada" } });
    expect(await screen.findByText("Directory access unavailable")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Directory access unavailable");
    expect(screen.getByText("Change the search, or clear and re-enter it to try again.")).toBeVisible();
    expect(search).toHaveBeenCalledOnce();
  });

  it("validates the trimmed query limit locally, cancels old work, and recovers without a doomed request", async () => {
    vi.useFakeTimers();
    let completeOld!: (value: { value: api.DirectoryPrincipal[] }) => void;
    const search = vi.spyOn(api, "searchDirectoryPrincipals")
      .mockReturnValueOnce(new Promise(resolve => { completeOld = resolve; }))
      .mockResolvedValue({ value: [] });
    render(<PrincipalPicker selected={[]} onChange={vi.fn()} />);
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: ` ${"a".repeat(120)} ` } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).toHaveBeenCalledExactlyOnceWith("a".repeat(120), 40, { signal: expect.any(AbortSignal) });

    fireEvent.change(input, { target: { value: ` ${"a".repeat(121)} ` } });
    expect(search.mock.calls[0][2]?.signal?.aborted).toBe(true);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Directory searches cannot exceed 120 characters.");
    expect(screen.queryByText("Searching directory...")).not.toBeInTheDocument();
    expect(screen.queryByText(/No matching unselected principals/)).not.toBeInTheDocument();
    await act(async () => {
      completeOld({ value: [{
        resourceId: "old-user", resourceType: "user", principalKind: "user", displayName: "Old result",
      }] });
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(search).toHaveBeenCalledOnce();
    expect(screen.queryByText("Old result")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Ada" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid", "true");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).toHaveBeenCalledTimes(2);
    expect(screen.getByText("No matching unselected principals in these results.")).toBeVisible();
  });

  it.each(["success", "failure"] as const)("retains a completed %s through disabling and equivalent queries", async outcome => {
    vi.useFakeTimers();
    const principal: api.DirectoryPrincipal = {
      resourceId: "current-user", resourceType: "user", principalKind: "user", displayName: "Current result",
    };
    const search = vi.spyOn(api, "searchDirectoryPrincipals");
    if (outcome === "success") search.mockResolvedValue({ value: [principal] });
    else search.mockRejectedValue(new Error("Directory access unavailable"));
    const onChange = vi.fn();
    const { rerender } = render(<PrincipalPicker selected={[]} onChange={onChange} />);
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "Ada" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).toHaveBeenCalledOnce();

    rerender(<PrincipalPicker selected={[]} onChange={onChange} disabled />);
    rerender(<PrincipalPicker selected={[]} onChange={onChange} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { value: " Ada " } });
    expect(screen.queryByText("Searching directory...")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).toHaveBeenCalledOnce();
    expect(screen.getByText(outcome === "success" ? "Current result" : "Directory access unavailable")).toBeVisible();

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByText("Current result")).not.toBeInTheDocument();
    expect(screen.queryByText("Directory access unavailable")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Ada" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("does not cancel or restart a pending search for equivalent trimmed input", async () => {
    vi.useFakeTimers();
    let complete!: (value: { value: api.DirectoryPrincipal[] }) => void;
    const search = vi.spyOn(api, "searchDirectoryPrincipals")
      .mockReturnValue(new Promise(resolve => { complete = resolve; }));
    render(<PrincipalPicker selected={[]} onChange={vi.fn()} />);
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "Ada" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const signal = search.mock.calls[0][2]?.signal;

    fireEvent.change(input, { target: { value: "Ada " } });
    expect(signal?.aborted).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).toHaveBeenCalledOnce();
    await act(async () => complete({ value: [] }));
    expect(screen.getByText("No matching unselected principals in these results.")).toBeVisible();
    expect(screen.queryByText("Searching directory...")).not.toBeInTheDocument();
  });

  it("does not admit a disabled debounce and searches once after Strict Mode re-enablement", async () => {
    vi.useFakeTimers();
    const search = vi.spyOn(api, "searchDirectoryPrincipals").mockResolvedValue({ value: [] });
    const onChange = vi.fn();
    const { rerender } = render(<PrincipalPicker selected={[]} onChange={onChange} />, { reactStrictMode: true });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ada" } });
    rerender(<PrincipalPicker selected={[]} onChange={onChange} disabled />);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).not.toHaveBeenCalled();
    rerender(<PrincipalPicker selected={[]} onChange={onChange} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).toHaveBeenCalledExactlyOnceWith("Ada", 40, { signal: expect.any(AbortSignal) });
    expect(screen.getByText("No matching unselected principals in these results.")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a cancelled failure while the re-enabled picker waits for its new result", async () => {
    let rejectOld!: (failure: Error) => void;
    let complete!: (value: { value: api.DirectoryPrincipal[] }) => void;
    const search = vi.spyOn(api, "searchDirectoryPrincipals")
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOld = reject; }))
      .mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
    const onChange = vi.fn();
    const { rerender } = render(<PrincipalPicker selected={[]} onChange={onChange} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ada" } });
    await waitFor(() => expect(search).toHaveBeenCalledOnce());
    rerender(<PrincipalPicker selected={[]} onChange={onChange} disabled />);
    rerender(<PrincipalPicker selected={[]} onChange={onChange} />);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    await act(async () => rejectOld(new Error("Obsolete failure")));
    expect(screen.queryByText("Obsolete failure")).not.toBeInTheDocument();
    expect(screen.getByText("Searching directory...")).toBeVisible();
    await act(async () => complete({ value: [{
      resourceId: "current-user", resourceType: "user", principalKind: "user", displayName: "Current result",
    }] }));
    expect(screen.getByRole("button", { name: /Current result/ })).toBeEnabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("filters bounded directory results without requerying or duplicating a normalized selected identity", async () => {
    const selected: api.DirectoryPrincipal = {
      resourceId: "USER-A", resourceType: "user", principalKind: "user", displayName: "Selected user",
    };
    const security: api.DirectoryPrincipal = {
      resourceId: "security-group", resourceType: "group", principalKind: "securityGroup", displayName: "Security result",
    };
    const team: api.DirectoryPrincipal = {
      resourceId: "team-group", resourceType: "group", principalKind: "microsoft365Group", displayName: "Team result",
    };
    const search = vi.spyOn(api, "searchDirectoryPrincipals").mockResolvedValue({
      value: [{ ...selected, resourceId: "user-a", displayName: "Duplicate selected identity" }, security, team],
    });
    const onChange = vi.fn();
    render(<PrincipalPicker selected={[selected]} onChange={onChange} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Group" } });
    expect(await screen.findByRole("button", { name: /Security result/ })).toBeVisible();
    expect(screen.queryByText("Duplicate selected identity")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "microsoft365" } });
    expect(screen.queryByRole("button", { name: /Security result/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Team result/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith([selected, team]);
    expect(search).toHaveBeenCalledOnce();
  });

  it("explains bounded local filtering and preserves results through selection changes without another request", async () => {
    vi.useFakeTimers();
    const principals: api.DirectoryPrincipal[] = Array.from({ length: 40 }, (_, index) => ({
      resourceId: `user-${index}`, resourceType: "user", principalKind: "user", displayName: `User ${index}`,
    }));
    const search = vi.spyOn(api, "searchDirectoryPrincipals").mockResolvedValue({ value: principals });
    const onChange = vi.fn();
    const { rerender } = render(<PrincipalPicker selected={[]} onChange={onChange} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "User" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const results = screen.getByRole("group", { name: "Directory results" });
    expect(results).toHaveTextContent("Search returns up to 40 users and groups.");
    expect(results).toHaveTextContent("Type filters apply only to these results; refine your search if a principal is missing.");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "security" } });
    expect(screen.getByText("No matching unselected principals in these results.")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "users" } });
    fireEvent.click(screen.getByRole("button", { name: /^User 0/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith([principals[0]]);
    rerender(<PrincipalPicker selected={[principals[0]]} onChange={onChange} />);
    expect(screen.queryByRole("button", { name: /^User 0/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove User 0" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    rerender(<PrincipalPicker selected={[]} onChange={onChange} />);
    expect(screen.getByRole("button", { name: /^User 0/ })).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"] as const)("ignores a superseded %s after the replacement query settles", async outcome => {
    vi.useFakeTimers();
    let completeOld!: (value: { value: api.DirectoryPrincipal[] }) => void;
    let rejectOld!: (failure: Error) => void;
    const current: api.DirectoryPrincipal = {
      resourceId: "current-user", resourceType: "user", principalKind: "user", displayName: "Current result",
    };
    const search = vi.spyOn(api, "searchDirectoryPrincipals")
      .mockReturnValueOnce(new Promise((resolve, reject) => { completeOld = resolve; rejectOld = reject; }))
      .mockResolvedValue({ value: [current] });
    const onChange = vi.fn();
    render(<PrincipalPicker selected={[]} onChange={onChange} />);
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "Ada" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fireEvent.change(input, { target: { value: "Grace" } });
    expect(search.mock.calls[0][2]?.signal?.aborted).toBe(true);
    expect(screen.getByRole("group", { name: "Directory results" })).toHaveAttribute("aria-busy", "true");
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(search).toHaveBeenCalledTimes(2);
    await act(async () => {
      if (outcome === "success") completeOld({ value: [{ ...current, displayName: "Obsolete result" }] });
      else rejectOld(new Error("Obsolete failure"));
    });
    expect(screen.queryByText("Obsolete result")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Searching directory...")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Directory results" })).toHaveAttribute("aria-busy", "false");
    fireEvent.click(screen.getByRole("button", { name: /Current result/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith([current]);
  });
});
