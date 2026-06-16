import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";

// base: "./" keeps every asset URL relative, so the built site works at any
// GitHub Pages path (user.github.io/<repo>/) without rebuilding.
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    // Copies Cesium's static assets (Workers/Assets/Widgets/ThirdParty) into the
    // build and sets window.CESIUM_BASE_URL so the globe view (GlobeViewer) works.
    cesium(),
  ],
  worker: { format: "es" },
  // @ifc-lite ships its own wasm + workers via `new URL(..., import.meta.url)`.
  // Excluding the packages from dep-optimization lets Vite resolve those URLs
  // (otherwise the bundled deps lose the worker/wasm asset references).
  optimizeDeps: {
    exclude: ["@ifc-lite/parser", "@ifc-lite/geometry", "@ifc-lite/renderer", "@ifc-lite/wasm"],
  },
});
