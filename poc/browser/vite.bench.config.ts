// Isolated Vite config for the headless browser verification harnesses
// (viewer-smoke / app-e2e). Kept SEPARATE from the app's vite.config.ts because
// the SharedArrayBuffer path (@ifc-lite processParallel) needs cross-origin
// isolation (COOP/COEP) — headers we do NOT want on the main app.
//
// Run:  npx vite --config poc/browser/vite.bench.config.ts
import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname);
const REPO = path.resolve(__dirname, "../..");

const PLAN =
  process.env.POC_PLAN ??
  "c:/Users/Dannyx/OneDrive/Desktop/IFC Plan de situatie App/Ridicare topo IFC_v0_IFC4X3_ADD2.ifc";
const LARGE =
  process.env.POC_LARGE ??
  "c:/Users/Dannyx/OneDrive/Desktop/SP4 IFC/230515_C3D_BIM_Sibiu_Pitesti-IFC4.ifc";

// Stream the two on-disk sample IFCs to the page (browser can't read disk paths).
function serveSamples(): Plugin {
  const map: Record<string, string> = { "/sample/plan": PLAN, "/sample/large": LARGE };
  return {
    name: "serve-samples",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const p = map[(req.url ?? "").split("?")[0]];
        if (!p) return next();
        if (!fs.existsSync(p)) { res.statusCode = 404; res.end("missing"); return; }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        fs.createReadStream(p).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: ROOT,
  base: "/",
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: { allow: [REPO] }, // allow importing ../../src and node_modules
  },
  plugins: [serveSamples()],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@ifc-lite/parser", "@ifc-lite/geometry", "@ifc-lite/renderer", "@ifc-lite/wasm"] },
});
