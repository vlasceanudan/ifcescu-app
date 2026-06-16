// End-to-end smoke of the REAL app (npm run dev): upload an IFC, walk the
// Editare / Vizualizare 3D / Glob tabs, screenshot each, report console errors.
// Usage: node poc/browser/run-app-e2e.mjs [plan|large]
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../..");
const OUT = __dirname;
const which = process.argv[2] ?? "plan";
const PORT = 5174;
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SAMPLE = which === "large"
  ? (process.env.POC_LARGE ?? "C:/Users/Dannyx/OneDrive/Desktop/SP4 IFC/230515_C3D_BIM_Sibiu_Pitesti-IFC4.ifc")
  : (process.env.POC_PLAN ?? "C:/Users/Dannyx/OneDrive/Desktop/IFC Plan de situatie App/Ridicare topo IFC_v0_IFC4X3_ADD2.ifc");

const dev = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: REPO, shell: true, stdio: ["ignore", "pipe", "pipe"] });
dev.stdout.on("data", (d) => process.stdout.write(`[vite] ${d}`));
dev.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitServer(url, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return; } catch {}
    await wait(300);
  }
  throw new Error("vite did not start");
}
async function clickTab(page, label) {
  await page.evaluate((lbl) => {
    const b = [...document.querySelectorAll("button.tab")].find((x) => x.textContent.includes(lbl));
    if (b) b.click();
  }, label);
}

const errors = [];
let browser;
try {
  await waitServer(`http://localhost:${PORT}/`);
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    protocolTimeout: 600000,
    args: ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-webgpu-adapter=swiftshader", "--enable-dawn-features=allow_unsafe_apis", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on("console", (m) => { if (m.type() === "error") { errors.push(m.text()); console.log("[page:err]", m.text()); } });
  page.on("pageerror", (e) => { errors.push(e.message); console.log("[pageerror]", e.message); });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load", timeout: 60000 });
  console.log("[e2e] uploading", SAMPLE);
  const input = await page.waitForSelector('[data-testid="ifc-input"]', { timeout: 20000 });
  await input.uploadFile(SAMPLE);

  // Edit tab appears once loaded.
  await page.waitForFunction(() => document.body.innerText.includes("Vizualizare 3D"), { timeout: 120000 });
  await wait(500);
  await page.screenshot({ path: path.join(OUT, "e2e-1-edit.png") });
  console.log("[e2e] edit tab OK");

  // 3D viewer
  await clickTab(page, "Vizualizare 3D");
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-testid="viewer-status"]');
    return s && (s.textContent.includes("Model încărcat") || s.textContent.includes("Eroare"));
  }, { timeout: 120000 });
  const viewerStatus = await page.evaluate(() => document.querySelector('[data-testid="viewer-status"]')?.textContent);
  await wait(1500);
  // Location card (real-coordinate model with zero MapConversion offset should still show the map).
  const locInfo = await page.evaluate(() => ({
    hasLocatie: document.body.innerText.includes("Locație"),
    hasMap: !!document.querySelector('iframe[src*="openstreetmap"]'),
  }));
  console.log("[e2e] location card:", JSON.stringify(locInfo));
  // Click the centre of the viewer to select an element → exercises pick + lime outline.
  const rect = await page.evaluate(() => {
    const h = document.querySelector(".viewer-host");
    const r = h.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(rect.x, rect.y);
  await wait(1000);
  const selName = await page.evaluate(() => document.querySelector(".sel-name")?.textContent ?? null);
  const outlineLen = await page.evaluate(() => document.querySelector("svg path[stroke='#bcf124']")?.getAttribute("d")?.length ?? 0);
  await page.screenshot({ path: path.join(OUT, "e2e-2-viewer.png") });
  console.log("[e2e] viewer status:", viewerStatus, "| selected:", selName, "| outline d-len:", outlineLen);

  // Section: enable a horizontal cut at 50% and screenshot (rendered by the GPU).
  const secInfo = await page.evaluate(async () => {
    const e = window.__engine;
    // Snap probe: centre (face) + the geometry vertex nearest screen-centre.
    const cv = document.querySelector("canvas");
    const r = cv.getBoundingClientRect();
    const cam = e.renderer.getCamera();
    const centre = e.snap(r.x + r.width / 2, r.y + r.height / 2);
    // Find an interior vertex projecting closest to centre and snap there.
    const id = e.allIDs[0];
    const pos = e.geom.get(id)[0].pos;
    let bx = 0, by = 0, bd = 1e9;
    for (let i = 0; i < pos.length; i += 3) {
      const s = cam.projectToScreen({ x: pos[i], y: pos[i + 1], z: pos[i + 2] }, r.width, r.height);
      if (!s) continue;
      const d = Math.hypot(s.x - r.width / 2, s.y - r.height / 2);
      if (d < bd) { bd = d; bx = s.x; by = s.y; }
    }
    const vSnap = e.snap(r.x + bx, r.y + by);
    // Toggle vertex snap OFF → aiming at the same vertex must no longer return "vertex".
    e.snapOptions = { vertex: false, midpoint: false, edge: false, face: true };
    const vSnapOff = e.snap(r.x + bx, r.y + by);
    e.snapOptions = { vertex: true, midpoint: true, edge: true, face: true };
    return {
      centreType: centre?.type ?? null,
      vertexSnapType: vSnap?.type ?? null,
      vertexSnapWhenOff: vSnapOff?.type ?? null,
    };
  });
  console.log("[e2e] snap probe:", JSON.stringify(secInfo));

  // Measure-glyph probe: enter Lungime mode, hover the model, check the overlay.
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Măsurare"))?.click());
  await wait(150);
  await page.evaluate(() => [...document.querySelectorAll(".vmenu-item")].find((b) => b.textContent.includes("Lungime"))?.click());
  await wait(150);
  const mc = await page.evaluate(() => {
    const r = document.querySelector("canvas").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(mc.x - 8, mc.y - 8);
  await page.mouse.move(mc.x, mc.y);
  await wait(400);
  const glyph = await page.evaluate(() => {
    const ov = document.querySelector(".measure-overlay");
    return {
      overlayExists: !!ov,
      childCount: ov?.childElementCount ?? -1,
      mode: window.__engine ? null : null,
      svgRect: ov ? [Math.round(ov.getBoundingClientRect().width), Math.round(ov.getBoundingClientRect().height)] : null,
    };
  });
  console.log("[e2e] measure glyph probe:", JSON.stringify(glyph));
  // Make a 2-point length measurement and screenshot to see glyph + line + label.
  await page.mouse.click(mc.x - 120, mc.y + 40);
  await page.mouse.move(mc.x + 140, mc.y - 30);
  await wait(200);
  await page.mouse.click(mc.x + 140, mc.y - 30);
  await page.mouse.move(mc.x + 60, mc.y + 10);
  await wait(300);
  await page.screenshot({ path: path.join(OUT, "e2e-5-measure.png") });
  // reset to selection mode
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Măsurare"))?.click());
  await page.evaluate(() => [...document.querySelectorAll(".vmenu-item")].find((b) => b.textContent.includes("Lungime"))?.click());
  // Section via double-click on a face.
  const cc2 = await page.evaluate(() => {
    const r = document.querySelector("canvas").getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const faceN = await page.evaluate((p) => {
    const r = window.__engine.raycast(p.x, p.y);
    const n = r?.intersection?.normal;
    return n ? [+n.x.toFixed(3), +n.y.toFixed(3), +n.z.toFixed(3)] : null;
  }, cc2);
  // Sanity: a bare double-click WITHOUT arming must NOT create a section.
  await page.mouse.click(cc2.x, cc2.y, { clickCount: 2 });
  await wait(200);
  const beforeArm = await page.evaluate(() => !!window.__engine.hasSection());
  // Arm the section tool, THEN double-click a face → section is created.
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Secțiune"))?.click());
  await wait(120);
  await page.evaluate(() => [...document.querySelectorAll(".vmenu-item")].find((b) => b.textContent.includes("Plan de secțiune"))?.click());
  await wait(120);
  const armedNoPlane = await page.evaluate(() => !!window.__engine.hasSection());
  await page.mouse.click(cc2.x, cc2.y, { clickCount: 2 });
  await wait(700);
  const secState = await page.evaluate(() => {
    const sec = window.__engine.sec;
    return {
      sliderPos: document.querySelector("input[type=range]")?.value ?? null,
      planeNormal: sec ? sec.normal.map((v) => +v.toFixed(3)) : null,
    };
  });
  // Drag the in-viewer handle and confirm the section position changes.
  const posBefore = await page.evaluate(() => window.__engine.sec?.pos ?? null);
  const hb = await page.evaluate(() => {
    const h = document.querySelector(".section-handle");
    if (!h || h.style.display === "none") return null;
    const r = h.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (hb) {
    await page.mouse.move(hb.x, hb.y);
    await page.mouse.down();
    await page.mouse.move(hb.x + 30, hb.y + 80, { steps: 6 });
    await page.mouse.up();
    await wait(200);
  }
  const posAfter = await page.evaluate(() => window.__engine.sec?.pos ?? null);
  await page.screenshot({ path: path.join(OUT, "e2e-4-section.png") });
  console.log("[e2e] beforeArm:", beforeArm, "| armedNoPlane:", armedNoPlane, "| planeNormal:", JSON.stringify(secState.planeNormal), "| handleFound:", !!hb, "| posBefore:", posBefore, "posAfter:", posAfter);

  // Section must survive entering measurement mode (no reset).
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Măsurare"))?.click());
  await wait(120);
  await page.evaluate(() => [...document.querySelectorAll(".vmenu-item")].find((b) => b.textContent.includes("Lungime"))?.click());
  await wait(250);
  const secSurvives = await page.evaluate(() => !!window.__engine.hasSection());
  console.log("[e2e] section survives entering measure:", secSurvives);

  // Globe
  await clickTab(page, "Glob 3D");
  await wait(6000);
  const globeText = await page.evaluate(() => document.querySelector(".globe-card")?.textContent ?? "");
  await page.screenshot({ path: path.join(OUT, "e2e-3-globe.png") });
  console.log("[e2e] globe card:", globeText.slice(0, 120));

  console.log("\n================ E2E RESULT ================");
  console.log(JSON.stringify({ viewerStatus, globeText: globeText.slice(0, 80), errorCount: errors.length }, null, 2));
} catch (e) {
  console.error("[e2e] ERROR:", e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  dev.kill("SIGTERM");
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
}
