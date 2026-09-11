import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    exclude: ["dist/**", "node_modules/**"],
  },
});
