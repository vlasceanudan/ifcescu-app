// Headless WASM bootstrap for @ifc-lite/geometry.
//
// @ifc-lite/geometry's GeometryProcessor.init() calls the wasm-bindgen
// `__wbg_init()` with no args, which defaults to `fetch(new URL('ifc-lite_bg.wasm',
// import.meta.url))` — that fails in Node (no fetch of file:// wasm). Both
// `__wbg_init` and `initSync` guard on `if (wasm !== undefined) return wasm;`, so
// pre-initializing the SHARED (hoisted, non-nested) @ifc-lite/wasm module with the
// local .wasm bytes makes the later no-arg init() a no-op. This lets the geometry
// engine run headless in vitest/Node — no browser page needed for the bench.
import fs from "node:fs";
import { createRequire } from "node:module";
import initWasm from "@ifc-lite/wasm";

let done = false;

export async function ensureIfcLiteWasm(): Promise<void> {
  if (done) return;
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("@ifc-lite/wasm/ifc-lite_bg.wasm");
  const bytes = fs.readFileSync(wasmPath);
  await initWasm({ module_or_path: bytes });
  done = true;
}
