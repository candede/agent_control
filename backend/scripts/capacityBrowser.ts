import assert from "node:assert/strict";
import { chromium,expect,type Page,type Request } from "@playwright/test";
import { capacityBrowserLaunchOptions,capacityBrowserOrigin } from "./capacityBrowserEnvironment.js";

async function browserPlatform(page: Page) {
  const value = await page.evaluate(() => {
    const uuid = typeof globalThis.crypto?.randomUUID==="function" ? crypto.randomUUID() : "";
    return { secureContext: globalThis.isSecureContext,randomUuidAvailable: typeof globalThis.crypto?.randomUUID==="function",
      uuidV4: /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(uuid),origin: location.origin };
  });
  assert.equal(value.secureContext,true);
  assert.equal(value.randomUuidAvailable,true);
  assert.equal(value.uuidV4,true);
  assert.equal(value.origin,capacityBrowserOrigin);
  return value;
}

export async function capacityBrowser(cookie: string, signal: AbortSignal, platformOnly = false) {
  assert.equal(process.env.AGENT_CONTROL_ISOLATED_TESTS,"1");
  signal.throwIfAborted();
  const browser = await chromium.launch(capacityBrowserLaunchOptions());
  const abort = () => { void browser.close(); };
  signal.addEventListener("abort",abort,{ once: true });
  const errors: string[] = [], samples: unknown[] = [];
  const network: Array<{ method: string;path: string;status?: number;failure?: string }> = [];
  const requests = new WeakMap<Request,(typeof network)[number]>();
  let droppedNetwork = 0,step = "launch",page: Page | undefined;
  let lists = 0,details = 0,maximumListBytes = 0,maximumDetailBytes = 0;
  let webPlatform: { secureContext: boolean;randomUuidAvailable: boolean;uuidV4: boolean;origin: string } | undefined;
  const pending = new Set<Promise<void>>();
  try {
    const context = await browser.newContext({ viewport: { width: 1440,height: 1000 } });
    const separator = cookie.indexOf("=");
    await context.addCookies([{ name: cookie.slice(0,separator),value: cookie.slice(separator+1),url: capacityBrowserOrigin }]);
    await context.route("**/*",route => {
      const url = new URL(route.request().url());
      return url.origin===capacityBrowserOrigin ? route.continue() : route.abort("blockedbyclient");
    });
    page = await context.newPage();
    page.setDefaultTimeout(20_000);
    if (platformOnly) {
      const response = await page.goto(`${capacityBrowserOrigin}/api/me`,{ waitUntil: "domcontentloaded",timeout: 20_000 });
      assert.equal(response?.status(),200);
      webPlatform = await browserPlatform(page);
      return { webPlatform,scope: "Native Chromium secure-context API bootstrap only; not the required 100k UI qualification." };
    }
    page.on("pageerror",error => { if (errors.length<16) errors.push(String(error).slice(0,1024)); });
    page.on("request",request => {
      const url = new URL(request.url()),row = { method: request.method().slice(0,16),path: (url.origin+url.pathname).slice(0,1024) };
      if (network.length>=64) { network.shift();droppedNetwork++; }
      network.push(row);requests.set(request,row);
    });
    page.on("requestfailed",request => {
      const row = requests.get(request);
      if (row) row.failure = request.failure()?.errorText.slice(0,512);
    });
    page.on("response",response => {
      const row = requests.get(response.request());
      if (row) row.status = response.status();
      const path = new URL(response.url()).pathname;
      if (path!=="/api/agent-inventory" && !/^\/api\/agent-inventory\/[^/]+\/detail$/.test(path)) return;
      if (pending.size>=4) { if (errors.length<16) errors.push("capacity_browser_response_queue"); return; }
      const work = (async () => {
        assert.equal(response.status(),200);
        const body = await response.body(),value = JSON.parse(body.toString("utf8"));
        if (path==="/api/agent-inventory") {
          lists++; maximumListBytes = Math.max(maximumListBytes,body.length);
          assert.ok(body.length<=1_048_576); assert.ok(value.counts.total>=100_000);
          assert.ok(value.value.length<=100);
        } else { details++; maximumDetailBytes = Math.max(maximumDetailBytes,body.length); assert.ok(body.length<=524288); }
      })().catch(error => { if (errors.length<16) errors.push(String(error)); }).finally(() => { pending.delete(work); });
      pending.add(work);
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    step = "initial-inventory-response";
    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname==="/api/agent-inventory"),
      (async () => {
        await page!.goto(`${capacityBrowserOrigin}/agents`,{ waitUntil: "domcontentloaded",timeout: 20_000 });
        webPlatform = await browserPlatform(page!);
      })(),
    ]);
    await Promise.all(pending);
    assert.deepEqual(errors,[]);
    const next = page.getByRole("button",{ name: "Next",exact: true });
    await next.waitFor({ state: "visible" });
    await page.waitForTimeout(2100);
    await Promise.all(pending);
    assert.ok(lists>0 && lists<=3,"initial navigation must not auto-drain the inventory");
    const sample = async (position: number) => {
      const rows = await page!.locator("table tbody tr").count();
      const metrics = await cdp.send("Performance.getMetrics");
      assert.ok(rows>0 && rows<=100);
      samples.push({ position,rows,heapUsed: metrics.metrics.find(value => value.name==="JSHeapUsedSize")?.value ?? null });
    };
    await sample(0);
    for (let position=1;position<=6;position++) {
      step = `next-page-${position}`;
      await expect(next).toBeEnabled({ timeout: 20_000 });
      const loaded = page.waitForResponse(response => new URL(response.url()).pathname==="/api/agent-inventory");
      await next.click(); await loaded; await Promise.all(pending); await sample(position);
    }
    const previous = page.getByRole("button",{ name: "Previous",exact: true });
    step = "previous-page";
    assert.equal(await previous.isEnabled(),true);
    await previous.click();
    await page.waitForTimeout(2100); await Promise.all(pending); await sample(5);
    const idleLists = lists;
    await page.waitForTimeout(5100); await Promise.all(pending);
    assert.equal(lists,idleLists,"idle UI must not traverse more cursors");
    step = "detail";
    const detailed = page.waitForResponse(response => /^\/api\/agent-inventory\/[^/]+\/detail$/.test(new URL(response.url()).pathname));
    await page.locator("table tbody tr .agent-name-button").first().click();
    await detailed; await Promise.all(pending);
    await page.getByRole("dialog").waitFor({ state: "visible" });
    assert.ok(details>0);
    assert.deepEqual(errors,[]);
    return { lists,details,maximumListBytes,maximumDetailBytes,samples,errors,webPlatform,
      scope: "Real Chromium, compiled UI and authenticated 100k-plus API; bounded DOM/navigation. Cache eviction and terminal export polling additionally require their dedicated browser contracts." };
  } catch (error) {
    const current = page ? new URL(page.url()) : undefined;
    const title = await page?.title().catch(() => null) ?? null;
    const diagnostic = { step,url: current ? (current.origin+current.pathname).slice(0,1024) : null,
      title: title?.slice(0,256) ?? null,
      text: (await page?.locator("body").innerText({ timeout: 1000 }).catch(() => "") ?? "").slice(0,4096),
      network,droppedNetwork,errors,lists,details,maximumListBytes,maximumDetailBytes,webPlatform };
    process.stdout.write("CAPACITY_BROWSER_DIAGNOSTIC "+JSON.stringify(diagnostic)+"\n");
    const failure = error instanceof Error ? error : new Error(String(error));
    Object.defineProperty(failure,"capacityBrowserDiagnostic",{ value: diagnostic });
    throw failure;
  } finally {
    signal.removeEventListener("abort",abort);
    await browser.close();
    await Promise.allSettled(pending);
  }
}
