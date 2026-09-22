import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    fileParallelism: false,
    exclude: ["dist/**", "node_modules/**"],
  },
});
