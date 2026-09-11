// Screenshot every stage at two viewports against the seeded project, as the guest.
//   node e2e/.shots-design.mjs <outdir> [base] [stages,comma]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const [outDir, baseArg, stagesArg] = process.argv.slice(2);
const BASE = (baseArg ?? "http://localhost:3000").replace(/\/+$/, "");
const P = "00000000-0000-0000-0000-000000000001";
const STAGES = stagesArg ? stagesArg.split(",") : ["build","live","bottlenecks","risk","requirements","whatif","optimize","history"];
const SIZES = [[1280, 800], [1536, 864]];
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
for (const [w, h] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const stage of STAGES) {
    const url = stage === "landing" ? `${BASE}/` : stage === "workspace" ? `${BASE}/workspace` : `${BASE}/workspace/${P}/${stage}`;
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
      await page.waitForTimeout(stage === "bottlenecks" || stage === "risk" ? 2500 : 1200);
      await page.screenshot({ path: `${outDir}/${stage}-${w}.png`, fullPage: false });
      await page.screenshot({ path: `${outDir}/${stage}-${w}-full.png`, fullPage: true });
      console.log(`shot ${stage} @${w}`);
    } catch (e) { console.log(`FAILED ${stage} @${w}: ${e.message}`); }
  }
  if (errors.length) console.log(`page errors @${w}:`, errors);
  await ctx.close();
}
await browser.close();
