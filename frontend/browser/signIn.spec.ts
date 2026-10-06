import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const usernameStorageKey = "agent-control:signin-username:v1";
const rememberedAuthorizationUrl = "https://login.microsoftonline.com/example/oauth2/v2.0/authorize?state=remember-test";

async function mockRememberedSignIn(page: Page) {
  const usernames: string[] = [];
  await page.route("https://login.microsoftonline.com/**", route => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><html lang=\"en\"><title>Mock Microsoft sign-in</title><body>Microsoft sign-in test destination</body></html>",
  }));
  await page.route("**/api/**", route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/status") return route.fulfill({ json: { authConfigured: true } });
    if (url.pathname === "/api/me") return route.fulfill({
      status: 401, json: { code: "unauthorized", detail: "Sign-in required." },
    });
    if (url.pathname === "/api/auth/login" && request.method() === "POST") {
      const { username } = request.postDataJSON();
      usernames.push(username);
      if (username === "user@unknown.example") return route.fulfill({
        status: 400, json: { code: "tenant_not_configured", detail: "Your organization is not configured for sign-in." },
      });
      return route.fulfill({ json: { authorizationUrl: rememberedAuthorizationUrl } });
    }
    throw new Error(`Unexpected sign-in request: ${request.method()} ${url.pathname}`);
  });
  return usernames;
}

test("username sign-in validates, recovers from an unknown domain and navigates to Microsoft without a tenant chooser", async ({ page }) => {
  const authorizationUrl = "https://login.microsoftonline.com/example/oauth2/v2.0/authorize?state=test-state";
  const loginRequests: Array<{ username: string; returnTo: string }> = [];
  const unexpectedRequests: string[] = [];
  let finishLogin!: () => void;
  const pendingLogin = new Promise<void>(resolve => { finishLogin = resolve; });
  await page.route("https://login.microsoftonline.com/**", route => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><html lang=\"en\"><title>Mock Microsoft sign-in</title><body>Microsoft sign-in test destination</body></html>",
  }));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/status") return route.fulfill({ json: {
      authConfigured: true, callback: `${url.origin}/api/auth/callback`,
    } });
    if (url.pathname === "/api/me") return route.fulfill({
      status: 401, json: { code: "unauthorized", detail: "Sign-in required." },
    });
    if (url.pathname === "/api/auth/login" && request.method() === "POST") {
      const input = request.postDataJSON();
      loginRequests.push(input);
      expect(request.headers()["content-type"]).toBe("application/json");
      expect(request.headers()["origin"]).toBe(url.origin);
      if (input.username === "user@unknown.example") return route.fulfill({
        status: 400,
        json: { code: "tenant_not_configured", detail: "Your organization is not configured for sign-in." },
      });
      await pendingLogin;
      return route.fulfill({ json: { authorizationUrl } });
    }
    unexpectedRequests.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 500, json: { code: "unexpected_test_request" } });
  });

  await page.goto("/users?view=activity&q=Alice&authorization=cancelled&returnTo=%2F%2Fexternal.example");
  const input = page.getByRole("textbox", { name: "Work or school username" });
  const button = page.getByRole("button", { name: "Sign in with Entra ID" });
  await expect(input).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Microsoft permission setup was cancelled or denied.");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Sign in/ })).toHaveCount(0);
  expect(loginRequests).toEqual([]);
  await button.click();
  await expect(page.getByRole("alert")).toContainText("Enter your work or school username");
  await expect(input).toBeFocused();
  await input.fill("user@unknown.example");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Your organization is not configured for sign-in.");
  await expect(input).toHaveValue("user@unknown.example");
  await expect(button).toBeEnabled();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await input.fill("user@example.com");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Preparing sign-in..." })).toBeDisabled();
  await expect(input).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Remember my email on this browser" })).toBeDisabled();
  await expect(page.getByRole("form", { name: "Sign in" })).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Preparing Microsoft sign-in...")).toBeVisible();
  expect(loginRequests).toEqual([
    { username: "user@unknown.example", returnTo: "/users?view=activity&q=Alice" },
    { username: "user@example.com", returnTo: "/users?view=activity&q=Alice" },
  ]);
  finishLogin();
  await expect(page).toHaveURL(authorizationUrl);
  await expect(page).toHaveTitle("Mock Microsoft sign-in");
  expect(unexpectedRequests).toEqual([]);
});

test("remembers accepted emails across visits, supports account changes, and retains the shared-device opt-out", async ({ page }) => {
  const usernames = await mockRememberedSignIn(page);
  await page.goto("/agents");
  const input = page.getByRole("textbox", { name: "Work or school username" });
  const remember = page.getByRole("checkbox", { name: "Remember my email on this browser" });
  await expect(input).toHaveValue("");
  await expect(remember).toBeChecked();
  await input.fill("Admin+ops@Example.com");
  await input.press("Enter");
  await expect(page).toHaveURL(rememberedAuthorizationUrl);
  await page.goto("/agents");
  await expect(input).toHaveValue("Admin+ops@Example.com");
  await page.reload();
  await expect(input).toHaveValue("Admin+ops@Example.com");
  expect(usernames).toEqual(["Admin+ops@Example.com"]);
  await input.fill("user@unknown.example");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Your organization is not configured for sign-in.");
  await page.reload();
  await expect(input).toHaveValue("Admin+ops@Example.com");
  await input.fill("second@example.com");
  await input.press("Enter");
  await expect(page).toHaveURL(rememberedAuthorizationUrl);
  await page.goto("/agents");
  await expect(input).toHaveValue("second@example.com");
  await remember.uncheck();
  expect(await page.evaluate(key => localStorage.getItem(key), usernameStorageKey)).toBe("");
  await page.reload();
  await expect(input).toHaveValue("");
  await expect(remember).not.toBeChecked();
  await input.fill("private@example.com");
  await input.press("Enter");
  await expect(page).toHaveURL(rememberedAuthorizationUrl);
  await page.goto("/agents");
  await expect(input).toHaveValue("");
  await expect(remember).not.toBeChecked();
  await remember.check();
  await input.fill("third@example.com");
  await input.press("Enter");
  await expect(page).toHaveURL(rememberedAuthorizationUrl);
  await page.goto("/agents");
  await expect(input).toHaveValue("third@example.com");
  expect(usernames).toEqual([
    "Admin+ops@Example.com", "user@unknown.example", "second@example.com", "private@example.com", "third@example.com",
  ]);
});

test("a failed email write reports the failure but does not block Microsoft sign-in", async ({ page }) => {
  await mockRememberedSignIn(page);
  await page.addInitScript(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("Storage full", "QuotaExceededError");
      original.call(this, name, value);
    };
  }, usernameStorageKey);
  const warnings: string[] = [];
  page.on("console", message => { if (message.type() === "warning") warnings.push(message.text()); });
  await page.goto("/agents");
  const input = page.getByRole("textbox", { name: "Work or school username" });
  await input.fill("reader@example.com");
  await input.press("Enter");
  await expect(page).toHaveURL(rememberedAuthorizationUrl);
  expect(warnings).toContainEqual(expect.stringContaining("Your browser could not update the remembered email."));
  await page.goto("/agents");
  await expect(input).toHaveValue("");
});

test("the login layout is accessible, keyboard operable, and fits its viewport", async ({ page }, testInfo) => {
  await mockRememberedSignIn(page);
  await page.goto("/agents");
  const input = page.getByRole("textbox", { name: "Work or school username" });
  const remember = page.getByRole("checkbox", { name: "Remember my email on this browser" });
  const button = page.getByRole("button", { name: "Sign in with Entra ID" });
  await expect(input).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(input).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(remember).toBeFocused();
  await page.keyboard.press("Space");
  await expect(remember).not.toBeChecked();
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  const inputBox = await input.boundingBox();
  const buttonBox = await button.boundingBox();
  expect(inputBox?.height).toBeGreaterThanOrEqual(48);
  expect(buttonBox?.height).toBeGreaterThanOrEqual(48);
  expect(buttonBox?.width).toBe(inputBox?.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("sign-in.png"), fullPage: true });
});

test("unconfigured sign-in remains disabled on desktop and mobile", async ({ page }) => {
  const unexpectedRequests: string[] = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/status") return route.fulfill({ json: {
      authConfigured: false,
      callback: `${url.origin}/api/auth/callback`,
      setup: "Ask your administrator to configure Microsoft sign-in.",
    } });
    if (url.pathname === "/api/me") return route.fulfill({ json: { user: null } });
    unexpectedRequests.push(url.pathname);
    return route.fulfill({ status: 500, json: { code: "unexpected_test_request" } });
  });
  await page.goto("/agents");
  await expect(page.getByText("Sign-in is not configured.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Work or school username" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sign in with Entra ID" })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(unexpectedRequests).toEqual([]);
});
