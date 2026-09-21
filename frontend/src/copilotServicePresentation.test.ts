import { describe, expect, it } from "vitest";
import { isCopilotServiceActive } from "./api/client";
import { copilotServicePresentation } from "./copilotServicePresentation";

describe("Copilot paid-feature presentation", () => {
  it.each([
    ["enabled", "Active", "", false, true],
    ["warning", "Active (grace period)", "attention", true, true],
    ["disabled", "Not enabled", "attention", true, false],
    ["suspended", "Suspended", "attention", true, false],
    ["locked_out", "Locked out", "attention", true, false],
    ["unknown", "Unverified", "unknown", true, false],
    ["partially_enabled", "Partially active", "attention", true, true],
  ] as const)("labels %s consistently without confusing active paid features with attention", (state, label, tone, needsAttention, active) => {
    expect(copilotServicePresentation(state)).toEqual({ label, tone, needsAttention });
    expect(isCopilotServiceActive(state)).toBe(active);
  });

  it.each([null, undefined])("keeps an unverified paid-feature state explicit (%s)", state => {
    expect(copilotServicePresentation(state)).toEqual({ label: "Unverified", tone: "unknown", needsAttention: true });
  });
});
