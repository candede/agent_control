import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["scripts/browser-fixture.browser.ts"], fileParallelism: false, testTimeout: 900000, hookTimeout: 30000 } });