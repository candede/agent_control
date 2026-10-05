import { it } from "vitest";

it("serves bounded selected inventory reads and durable exports under the existing cache-load budgets", async () => {
  await import("./cache-load.js");
}, 30_000);
