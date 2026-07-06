export function parseBulkRefSearch(query: string) {
  const normalized = query
    .trim()
    .toLowerCase()
    .replace(/^ref\s+/, "");
  return /^[0-9a-f]{8}$/.test(normalized) ? normalized : undefined;
}
