import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { SESSION_SECRET: "synthetic-vitest-session-secret-not-for-runtime" },
    silent: "passed-only",
    fileParallelism: false,
    exclude: ["dist/**", "node_modules/**"],
  },
});
