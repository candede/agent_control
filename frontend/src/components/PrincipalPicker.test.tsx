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
  });

  it("surfaces provider failures without automatic retries", async () => {
    const search = vi.spyOn(api, "searchDirectoryPrincipals").mockRejectedValue(new Error("Directory access unavailable"));
    render(<PrincipalPicker selected={[]} onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ada" } });
    expect(await screen.findByText("Directory access unavailable")).toBeVisible();
    expect(search).toHaveBeenCalledOnce();
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
    expect(screen.getByText("No matching unselected principals.")).toBeVisible();
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
});
