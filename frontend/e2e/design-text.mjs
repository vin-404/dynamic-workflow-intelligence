// Visible-text scan for the design rework: on every stage, report visible
// snake_case / SCREAMING_CASE identifiers, raw ISO timestamps, API paths and
// formulas (outside open disclosures) - the §8 checklist, mechanically.
//   node e2e/design-text.mjs [base] [stages,comma]
import { chromium } from "playwright";
const [baseArg, stagesArg] = process.argv.slice(2);
const BASE = (baseArg ?? "http://localhost:3000").replace(/\/+$/, "");
const P = "00000000-0000-0000-0000-000000000001";
const STAGES = stagesArg ? stagesArg.split(",") : ["build","live","bottlenecks","risk","requirements","whatif","optimize","history","workspace","landing"];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let total = 0;
for (const stage of STAGES) {
  const url = stage === "landing" ? `${BASE}/` : stage === "workspace" ? `${BASE}/workspace` : `${BASE}/workspace/${P}/${stage}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(stage === "bottlenecks" || stage === "risk" ? 3000 : 1500);
  const text = await page.evaluate(() => document.body.innerText);
  const hits = [];
  for (const m of text.matchAll(/\b[a-z]+(?:_[a-z0-9]+)+\b/g)) hits.push(`snake: ${m[0]}`);
  for (const m of text.matchAll(/\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/g)) hits.push(`SCREAMING: ${m[0]}`);
  for (const m of text.matchAll(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/g)) hits.push(`timestamp: ${m[0]}`);
  for (const m of text.matchAll(/(?:GET|POST|DELETE|PUT|PATCH)?\s?\/api\/[\w/{}.-]+/g)) hits.push(`api path: ${m[0].trim()}`);
  for (const m of text.matchAll(/\b(?:risk|impact)\s*=\s*[^\n]{4,60}/g)) hits.push(`formula: ${m[0]}`);
  const uniq = [...new Set(hits)];
  total += uniq.length;
  console.log(`${stage}: ${uniq.length} hits`);
  for (const h of uniq) console.log("   " + h);
}
await browser.close();
process.exit(total ? 1 : 0);
