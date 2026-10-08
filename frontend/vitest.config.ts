import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import react from "@vitejs/plugin-react";

class AppSessionSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    const sorted = await super.sort(files);
    // The small entrypoints register large case groups; schedule them before shorter files.
    const groups = ["inventory", "commands", "session"];
    const priority = (file: TestSpecification) => {
      const group = file.moduleId.match(/\/App\.(inventory|commands|session)\.test\.tsx$/)?.[1];
      return group ? groups.indexOf(group) : groups.length;
    };
    return sorted.sort((left, right) => priority(left) - priority(right));
  }
}

export default defineConfig({
  plugins: [react()],
  test: {
    silent: "passed-only",
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    mockReset: true,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    pool: "threads",
    isolate: true,
    maxWorkers: 2,
    sequence: { sequencer: AppSessionSequencer },
  },
});