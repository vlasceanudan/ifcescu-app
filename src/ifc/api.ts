import { IfcAPI, SchemaNames } from "web-ifc";

let apiPromise: Promise<IfcAPI> | null = null;

/** Read the FILE_SCHEMA name from a STEP file's header (scans the first 8 KB). */
function readFileSchema(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 8192));
  const m = head.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * web-ifc 0.0.39 only recognises the exact schema header strings "IFC2X3",
 * "IFC4_3" and "IFC4". Real IFC4X3 files declare FILE_SCHEMA(('IFC4X3')) (or
 * _ADD1/_ADD2/_TC1 …), which web-ifc fails to map, leaving the model schema
 * unresolved — GetModelSchema() returns undefined and every GetLine() then
 * throws "Cannot read properties of undefined". The WASM parser itself reads
 * IFC4X3 fine (FromRawLineData index 2 IS the IFC4X3 table), so we just point
 * the JS-side schema map at the right index after OpenModel.
 *
 * Call this immediately after OpenModel on any IfcAPI instance. No-op when the
 * schema is already resolved (IFC2X3 / IFC4) or the internal field is absent.
 */
export function resolveModelSchema(api: IfcAPI, modelID: number, bytes: Uint8Array): void {
  if (api.GetModelSchema(modelID)) return; // already recognised
  const h = readFileSchema(bytes) ?? "";
  const internal =
    /^IFC2X3/.test(h) ? "IFC2X3" :
    /^IFC4X3|^IFC4_3|^IFC4\.3/.test(h) ? "IFC4_3" :
    /^IFC4/.test(h) ? "IFC4" : null;
  const idx = internal ? SchemaNames.indexOf(internal) : -1;
  const list = (api as unknown as { modelSchemaList?: number[] }).modelSchemaList;
  if (idx > 0 && Array.isArray(list)) list[modelID] = idx;
}

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
