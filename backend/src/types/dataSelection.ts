export type PublicationRevisions = { graph_packages: string; power_platform: string; users: string };
export type SelectedRead = { id: string; revision: string; expiresAt: string; evaluatedAt: string; validatedAt: string };
export type PublishedSelectedRead = SelectedRead & { publicationRevisions: PublicationRevisions };

export function isPublicationRevisions(value: unknown): value is PublicationRevisions {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 3
    && ["graph_packages", "power_platform", "users"].every(key =>
      typeof (value as Record<string, unknown>)[key] === "string"
      && /^[a-f0-9]{64}$/.test((value as Record<string, string>)[key]));
}
