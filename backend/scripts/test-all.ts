import { runSoftwareChecks } from "./softwareChecks.js";

try {
  await runSoftwareChecks();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}