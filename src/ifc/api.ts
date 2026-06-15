import { IfcAPI } from "web-ifc";

let apiPromise: Promise<IfcAPI> | null = null;

/** Lazily initialise a single shared web-ifc API for the editor. */
export function getIfcApi(): Promise<IfcAPI> {
  if (!apiPromise) {
    apiPromise = (async () => {
      const api = new IfcAPI();
      // web-ifc.wasm is copied to the site root by vite-plugin-static-copy;
      // BASE_URL keeps this correct at any GitHub Pages path.
      api.SetWasmPath(import.meta.env.BASE_URL);
      await api.Init();
      return api;
    })();
  }
  return apiPromise;
}
