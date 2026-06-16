// Shared sample-file resolution for the @ifc-lite POC.
// Both models are confirmed to carry an IfcMapConversion (georef parity needs it).
// Override with POC_PLAN / POC_LARGE env vars if you move the files.
import fs from "node:fs";

export const PLAN_SAMPLE =
  process.env.POC_PLAN ??
  "c:/Users/Dannyx/OneDrive/Desktop/IFC Plan de situatie App/Ridicare topo IFC_v0_IFC4X3_ADD2.ifc";

export const LARGE_SAMPLE =
  process.env.POC_LARGE ??
  "c:/Users/Dannyx/OneDrive/Desktop/SP4 IFC/230515_C3D_BIM_Sibiu_Pitesti-IFC4.ifc";

export const hasPlan = fs.existsSync(PLAN_SAMPLE);
export const hasLarge = fs.existsSync(LARGE_SAMPLE);

/** Read a file as a standalone ArrayBuffer (no Buffer view offset surprises). */
export function readArrayBuffer(path: string): ArrayBuffer {
  const buf = fs.readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Read a file as a Uint8Array (what @ifc-lite geometry + web-ifc want). */
export function readBytes(path: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path));
}
