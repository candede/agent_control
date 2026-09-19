import DOMPurify from "dompurify";
import { formatPackageFacetLabel } from "../../backend/src/types/copilotPackage";
import type { CopilotPackageDetail } from "./api/client";

export type ConnectedServiceReference = {
  value: string;
  source: string;
};

export function getAgentDescription(
  agent: Pick<CopilotPackageDetail, "longDescription" | "shortDescription">,
  additionalDescription?: string,
) {
  return agent.longDescription?.trim() || additionalDescription?.trim() || agent.shortDescription?.trim() || "No description provided.";
}

export function getSanitizedDescriptionHtml(description: string) {
  if (!/<\/?[a-z][\s\S]*>/i.test(description)) return undefined;
  return DOMPurify.sanitize(description, { USE_PROFILES: { html: true } }).trim() || undefined;
}

export function extractConnectedServices(
  elementDetails?: CopilotPackageDetail["elementDetails"],
): ConnectedServiceReference[] {
  const services = new Map<string, ConnectedServiceReference>();
  for (const detail of elementDetails ?? []) {
    for (const element of detail.elements) {
      const source = `${formatPackageFacetLabel(detail.elementType)} ${element.id}`.trim();
      for (const value of extractServiceCandidates(element.definition)) {
        services.set(`${source}:${value}`, { value, source });
      }
    }
  }
  return [...services.values()];
}

function extractServiceCandidates(definition: string) {
  const candidates = new Set<string>();
  for (const match of definition.matchAll(/https?:\/\/([^\s"'<>/]+)[^\s"'<>]*/gi)) {
    candidates.add(match[1]);
  }
  const parsed = parseDefinition(definition);
  const pending: { key?: string; value: unknown }[] = [{ value: parsed }];
  for (let current = pending.pop(); current; current = pending.pop()) {
    const { key, value } = current;
    if (typeof value === "string") {
      if (key && /(api|connector|connection|endpoint|host|name|resource|service|url)/i.test(key)) {
        const candidate = value.trim();
        if (candidate && candidate.length <= 120) candidates.add(candidate);
      }
    } else if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) pending.push({ value: value[index] });
    } else if (value && typeof value === "object") {
      const entries = Object.entries(value);
      for (let index = entries.length - 1; index >= 0; index--) {
        pending.push({ key: entries[index][0], value: entries[index][1] });
      }
    }
  }
  return [...candidates];
}

function parseDefinition(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
