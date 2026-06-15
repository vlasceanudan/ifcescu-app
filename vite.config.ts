import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";

// base: "./" keeps every asset URL relative, so the built site works at any
// GitHub Pages path (user.github.io/<repo>/) without rebuilding.
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    // Serve the web-ifc WASM from the site root (both the editor and the
    // viewer call SetWasmPath(import.meta.env.BASE_URL)).
    viteStaticCopy({
      targets: [
        { src: "node_modules/web-ifc/web-ifc.wasm", dest: "." },
        { src: "node_modules/web-ifc/web-ifc-mt.wasm", dest: "." },
      ],
    }),
  ],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["web-ifc"] },
  // web-ifc maps IFC type codes to deserializers via Function.name, so the
  // minifier must NOT rename functions or GetLine throws
  // "c9[t][e.typecode] is not a function".
  esbuild: { keepNames: true },
});
