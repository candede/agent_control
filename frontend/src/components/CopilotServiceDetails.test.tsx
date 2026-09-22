import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { copilotUsageFixture } from "../test/copilotUsageFixture";
import { CopilotServiceDetails } from "./CopilotServiceDetails";

describe("paid-feature evidence details", () => {
  it("recognizes verified disabled users with no assigned paid services", () => {
    render(<CopilotServiceDetails servicePlans={[]} copilotServiceState="disabled" current />);
    expect(screen.getByText("No paid Copilot services are assigned.")).toBeVisible();
    expect(screen.queryByText(/unverified|evidence not reported|Run Users Sync/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Paid feature states" })).not.toBeInTheDocument();
  });

  it("does not infer no paid services from unknown assignments", () => {
    render(<CopilotServiceDetails servicePlans={[]} copilotServiceState="unknown" current />);
    expect(screen.getByText(/Paid-feature evidence not reported.*Run Users Sync/)).toBeVisible();
    expect(screen.queryByText(/No paid Copilot services are assigned/)).not.toBeInTheDocument();
  });

  it("qualifies an old no-services observation without calling that evidence missing", () => {
    render(<CopilotServiceDetails servicePlans={[]} copilotServiceState="disabled" current={false} />);
    expect(screen.getByText("Last saved: no paid Copilot services were assigned.")).toBeVisible();
    expect(screen.getByText(/Current paid-feature status is unverified until Users Sync/)).toBeVisible();
    expect(screen.queryByText(/Paid-feature evidence not reported/)).not.toBeInTheDocument();
  });

  it("keeps assigned but disabled service evidence distinct from no assigned services", () => {
    const plan = { ...copilotUsageFixture.users[0].servicePlans[0], state: "disabled" as const };
    render(<CopilotServiceDetails servicePlans={[plan]} copilotServiceState="disabled" current />);
    expect(screen.getByRole("list", { name: "Paid feature states" })).toHaveTextContent("Not enabled");
    expect(screen.queryByText(/No paid Copilot services are assigned/)).not.toBeInTheDocument();
  });
});
