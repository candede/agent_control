import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./browser", timeout: 20000, workers: 1, retries: 0,
  outputDir: "/evidence/playwright",
  reporter: [["list"], ["json", { outputFile: "/evidence/permission-browser-results.json" }]],
  use: { baseURL: "http://localhost:3001", browserName: "chromium", screenshot: "only-on-failure", trace: "off" },
  projects: [{ name: "desktop", use: { viewport: { width: 1440, height: 1000 } } }, { name: "mobile", use: { viewport: { width: 360, height: 780 } } }],
});