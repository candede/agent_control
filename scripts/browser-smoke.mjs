import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const browser=await chromium.launch({headless:true});
const base=process.env.APP_URL ?? "http://app:3001";
const output=process.env.EVIDENCE_DIR ?? "/evidence";
mkdirSync(output,{recursive:true});
try {
  for (const viewport of [{width:1440,height:1000},{width:360,height:780}]) {
    const context=await browser.newContext({viewport});
    const page=await context.newPage();
    const errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.goto(base,{waitUntil:"networkidle"});
    await page.getByRole("heading",{name:"Agent Control",exact:true}).waitFor();
    assert.equal(await page.getByText("Sign-in is not configured.",{exact:true}).count(),1);
    assert.equal(await page.getByText("Sign in with Entra ID",{exact:true}).getAttribute("href"),null);
    const dimensions=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(dimensions.scroll<=dimensions.width,`Horizontal overflow at ${viewport.width}: ${JSON.stringify(dimensions)}`);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:`${output}/signin-${viewport.width}.png`,fullPage:true});
    await context.close();
  }
  console.log(JSON.stringify({event:"container_browser_smoke",outcome:"passed",viewports:[1440,360]}));
} finally { await browser.close(); }