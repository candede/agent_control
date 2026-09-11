import type { CopilotPackage } from "./api/client";

type AgentBuiltWithFields = Pick<
  CopilotPackage,
  "authoringTool" | "platform" | "shortDescription"
>;

export function getBuiltWithLabel(agent: AgentBuiltWithFields) {
  const authoritative = typeof agent.authoringTool === "string"
    ? agent.authoringTool
    : typeof agent.platform === "string" ? agent.platform : undefined;

  if (authoritative) return formatBuiltWithValue(authoritative);

  const packageHint = getBuiltUsingValue(agent.shortDescription);
  return packageHint ? `Package hint: ${formatBuiltWithValue(packageHint)}` : undefined;
}

export function formatBuiltWithLabel(agent: AgentBuiltWithFields) {
  return getBuiltWithLabel(agent) ?? "Unknown";
}

export function getBuiltWithFilterValue(agent: AgentBuiltWithFields) {
  return getBuiltWithLabel(agent);
}

function getBuiltUsingValue(description?: string) {
  if (typeof description !== "string") {
    return undefined;
  }

  const match = description?.trim().match(/^built\s+using\s+(.+?)\.?$/i);

  return match?.[1]?.trim();
}

function formatBuiltWithValue(value: string) {
  const normalizedValue = normalizeBuiltWithValue(value);

  if (normalizedValue.includes("copilotstudio")) {
    return "Copilot Studio";
  }

  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function normalizeBuiltWithValue(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
