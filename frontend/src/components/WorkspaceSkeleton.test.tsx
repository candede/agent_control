import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceSkeleton } from "./WorkspaceSkeleton";

describe("WorkspaceSkeleton", () => {
  it.each(["agents", "users", "audit"] as const)("shows a non-interactive %s layout with an accessible loading status", view => {
    const { container } = render(<WorkspaceSkeleton view={view} />);
    expect(screen.getByRole("region", { name: `Loading ${view}` })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent(`Loading ${view === "audit" ? "audit events" : view}...`);
    expect(container.querySelectorAll(".workspace-skeleton-metric")).toHaveLength(4);
    expect(container.querySelectorAll(".workspace-skeleton-row")).toHaveLength(9);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reuses the table placeholders without duplicating an existing header or non-paid user summary", () => {
    const { container } = render(<WorkspaceSkeleton view="users" contentOnly showSummary={false} />);
    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelector(".workspace-skeleton-summary")).toBeNull();
    expect(container.querySelector(".workspace-skeleton-context")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Loading users...");
  });
});
