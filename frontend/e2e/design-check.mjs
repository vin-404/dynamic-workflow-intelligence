// Graph legibility check for the design rework: at a given viewport, every
// task bar's label must be fully visible (no truncation) and no two bar
// footprints may intersect. Prints one line per problem; exits 1 if any.
//   node e2e/design-check.mjs [base] [width] [height] [stage]
import { chromium } from "playwright";
const [baseArg, w = "1280", h = "800", stage = "bottlenecks"] = process.argv.slice(2);
const BASE = (baseArg ?? "http://localhost:3000").replace(/\/+$/, "");
const P = "00000000-0000-0000-0000-000000000001";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
await page.goto(`${BASE}/workspace/${P}/${stage}`, { waitUntil: "networkidle", timeout: 120000 });
await page.locator(".ft-node-hit").first().waitFor({ timeout: 60000 });
await page.waitForTimeout(800);
const result = await page.evaluate(() => {
  const hits = [...document.querySelectorAll(".ft-node-hit")];
  const boxes = hits.map((el) => {
    const r = el.getBoundingClientRect();
    const truncated = [...el.querySelectorAll("span")].some((s) => s.classList.contains("truncate") && s.scrollWidth > s.clientWidth + 1);
    const text = el.getAttribute("aria-label");
    const visibleName = el.innerText.replace(/\s+/g, " ").trim();
    return { key: el.dataset.task, x: r.left, y: r.top, w: r.width, h: r.height, truncated, text, visibleName };
  });
  const problems = [];
  for (const b of boxes) {
    if (b.truncated) problems.push(`truncated: ${b.key} "${b.text}" shows "${b.visibleName}"`);
    if (!b.visibleName.includes(b.text.split(" ").slice(1).join(" "))) problems.push(`name not drawn: ${b.key} -> "${b.visibleName}"`);
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const overlap = a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
    if (overlap) problems.push(`overlap: ${a.key} and ${b.key}`);
  }
  const controls = document.querySelector(".react-flow__controls")?.getBoundingClientRect();
  if (controls) for (const b of boxes) {
    const hit = b.x < controls.right && controls.left < b.x + b.w && b.y < controls.bottom && controls.top < b.y + b.h;
    if (hit) problems.push(`under the zoom controls: ${b.key}`);
  }
  const graph = document.querySelector('[data-graph="workflow"] .flowtrace-graph')?.getBoundingClientRect();
  return { count: boxes.length, problems, graphWidth: graph?.width, graphHeight: graph?.height, graphRight: graph ? graph.right : null };
});
console.log(`${stage} @${w}x${h}: ${result.count} bars, graph ${Math.round(result.graphWidth)}x${Math.round(result.graphHeight)} (right edge ${Math.round(result.graphRight)})`);
for (const p of result.problems) console.log("  PROBLEM " + p);
if (result.problems.length === 0) console.log("  OK: every name drawn, nothing truncated, no overlaps");
await browser.close();
process.exit(result.problems.length ? 1 : 0);
