// Headless runner for the WebGPU ViewerEngine smoke (Phase 3 verification).
// Usage: node poc/browser/run-viewer-smoke.mjs [plan|large]
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../..");
const which = process.argv[2] ?? "plan";
const PORT = 5192;
const URL = `http://localhost:${PORT}/viewer-smoke.html?m=${which}`;
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const vite = spawn(
  "npx",
  ["vite", "--config", "poc/browser/vite.bench.config.ts", "--port", String(PORT), "--strictPort"],
  { cwd: REPO, shell: true, stdio: ["ignore", "pipe", "pipe"] },
);
vite.stdout.on("data", (d) => process.stdout.write(`[vite] ${d}`));
vite.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));

async function waitForServer(url, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("vite did not start");
}

let browser;
try {
  await waitForServer(`http://localhost:${PORT}/`);
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    protocolTimeout: 600000,
    args: [
      "--no-sandbox",
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan,WebGPU",
      "--use-webgpu-adapter=swiftshader",
      "--enable-dawn-features=allow_unsafe_apis",
      "--ignore-gpu-blocklist",
    ],
  });
  const page = await browser.newPage();
  page.on("console", (m) => console.log("[page]", m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(URL, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction("window.__DONE === true", { timeout: 300000 });
  const err = await page.evaluate("window.__ERR || null");
  const result = await page.evaluate("window.__RESULT || null");
  console.log("\n================ VIEWER SMOKE ================");
  if (err) { console.log("ERROR:", err); process.exitCode = 1; }
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error("[run] ERROR:", e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  vite.kill("SIGTERM");
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
}
