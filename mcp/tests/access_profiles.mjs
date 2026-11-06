// Execute the real route registration/policy owner; never copy its role matrix.
import { createApp } from "../../backend/src/app.ts";
import { withAuthority } from "../../backend/src/auth/authorityContext.ts";
import { mcpAccessProfile } from "../../backend/src/services/mcpAccess.ts";
import { mkdirSync, writeFileSync } from "node:fs";

createApp();
const profiles = {};
for (const [name, roles] of Object.entries({
  end_user: [], adoption: ["AgentControl.Viewer"],
  uploader: ["AgentControl.UsageReportUploader"], admin: ["AgentControl.Admin"],
})) {
  profiles[name] = withAuthority({ principal: { roles }, assertCurrent() {} }, mcpAccessProfile);
}
if (process.argv.includes("--write")) {
  mkdirSync("tests/fixtures", { recursive: true });
  writeFileSync("tests/fixtures/access_profiles.json", JSON.stringify(profiles, null, 2) + "\n");
} else console.log(JSON.stringify(profiles));
