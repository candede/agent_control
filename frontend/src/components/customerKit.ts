export type CustomerKitFile = { text: string; version: string };

export async function loadCustomerKitFile(path: string, signal: AbortSignal): Promise<CustomerKitFile> {
  const options = { signal, cache: "no-store", credentials: "omit" } as const;
  const response = await fetch("/customer-kit/manifest.json", options);
  if (!response.ok) throw new Error("Customer kit manifest is unavailable.");
  const manifest: unknown = await response.json();
  if (!manifest || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string"
    || !/^[a-f0-9]{64}$/.test(manifest.version) || !("files" in manifest) || !Array.isArray(manifest.files)) {
    throw new Error("Customer kit manifest is invalid.");
  }
  const file: unknown = manifest.files.find((entry: unknown) =>
    entry !== null && typeof entry === "object" && "path" in entry && entry.path === path);
  if (!file || typeof file !== "object" || !("sha256" in file) || typeof file.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(file.sha256) || !("bytes" in file) || typeof file.bytes !== "number"
    || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 262144) {
    throw new Error("Customer kit file metadata is invalid.");
  }
  const content = await fetch(`/customer-kit/adoption-intelligence/${path}`, options);
  if (!content.ok) throw new Error("Customer kit file is unavailable.");
  const bytes = await content.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (bytes.byteLength !== file.bytes || hash !== file.sha256) {
    throw new Error("Customer kit file does not match its manifest.");
  }
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), version: manifest.version };
}
