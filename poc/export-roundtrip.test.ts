// Pasul C — round-trip export: poate @ifc-lite reproduce garanția non-destructivă
// a aplicației (liniile neatinse rămân identice) + păstrarea preciziei numerelor mari?
// Răspunsul decide: renunțăm complet la web-ifc, SAU păstrăm exportul actual (hibrid).
import { describe, it, expect } from "vitest";
import { IfcParser } from "@ifc-lite/parser";
import { exportToStep, StepExporter } from "@ifc-lite/export";
import { MutablePropertyView, StoreEditor } from "@ifc-lite/mutations";
import { PLAN_SAMPLE, hasPlan, readArrayBuffer, readBytes } from "./samples";

/** Minimal STEP DATA-section record splitter (mirrors editor.ts splitRecords). */
function recordsMap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const ds = text.indexOf("DATA;");
  const es = ds >= 0 ? text.indexOf("ENDSEC;", ds) : -1;
  if (ds < 0 || es < 0) return map;
  const body = text.slice(ds + 5, es);
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /\s/.test(body[i])) i++;
    if (i >= n || body[i] !== "#") { i++; continue; }
    const start = i;
    let inStr = false;
    for (; i < n; i++) {
      const c = body[i];
      if (inStr) { if (c === "'") { if (body[i + 1] === "'") i++; else inStr = false; } }
      else if (c === "'") inStr = true;
      else if (c === ";") { i++; break; }
    }
    const rec = body.slice(start, i).trim();
    const m = /^#(\d+)=/.exec(rec);
    if (m) map.set(Number(m[1]), rec.replace(/\s+/g, "")); // whitespace-insensitive compare
  }
  return map;
}

function detectSchema(bytes: Uint8Array): "IFC2X3" | "IFC4" | "IFC4X3" {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 8192));
  const m = head.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
  const s = (m?.[1] ?? "").toUpperCase();
  if (s.startsWith("IFC2X3")) return "IFC2X3";
  if (s.startsWith("IFC4X3") || s.startsWith("IFC4_3")) return "IFC4X3";
  return "IFC4";
}

const MALFORMED_REAL = /E[+-]?\d+\./i; // web-ifc 0.0.39 artefact, e.g. "1.71646E+09."

describe.runIf(hasPlan)("export round-trip (@ifc-lite)", () => {
  it("pure re-export: byte-stability of untouched lines + big-number precision", async () => {
    const bytes = readBytes(PLAN_SAMPLE);
    const schema = detectSchema(bytes);
    const store = await new IfcParser().parseColumnar(readArrayBuffer(PLAN_SAMPLE));
    const out = exportToStep(store, { schema, includeGeometry: true });

    const orig = recordsMap(new TextDecoder("latin1").decode(bytes));
    const exp = recordsMap(out);
    let identical = 0, differ = 0, missing = 0;
    const diffSamples: string[] = [];
    for (const [id, text] of orig) {
      if (!exp.has(id)) { missing++; continue; }
      if (exp.get(id) === text) identical++;
      else {
        differ++;
        if (diffSamples.length < 4) diffSamples.push(`#${id}\n  orig: ${text}\n  exp : ${exp.get(id)}`);
      }
    }
    console.log(`\n[export] schema=${schema}  orig records=${orig.size}  exported records=${exp.size}`);
    console.log(`[export] identical=${identical}  differ=${differ}  missing(dropped)=${missing}`);
    console.log(`[export] sample diffs:\n${diffSamples.join("\n")}`);

    // Precision: the Stereo 70 easting must survive verbatim (15 sig figs).
    const FULL = "787661.492898342";
    console.log(`[export] contains full-precision easting (${FULL}):`, out.includes(FULL));
    expect(out.includes(FULL), "full-precision Stereo 70 easting preserved").toBe(true);
    // No web-ifc-style malformed reals.
    expect(MALFORMED_REAL.test(out), "no malformed E+NN. reals").toBe(false);

    console.log(`[export] byte-stable untouched ratio: ${((identical / orig.size) * 100).toFixed(1)}%`);
  }, 120_000);

  it("with a Name mutation: edit applies, precision + other lines preserved", async () => {
    const bytes = readBytes(PLAN_SAMPLE);
    const schema = detectSchema(bytes);
    const store = await new IfcParser().parseColumnar(readArrayBuffer(PLAN_SAMPLE));

    const projIds = store.entityIndex.byType.get("IFCPROJECT") ?? [];
    expect(projIds.length, "model has an IfcProject").toBeGreaterThan(0);

    const view = new MutablePropertyView(null, "0");
    const editor = new StoreEditor(store as any, view);
    editor.setAttribute(projIds[0], "Name", "POC-RENAMED");

    const result = new StepExporter(store, view).export({ schema, includeGeometry: true, applyMutations: true });
    const out = new TextDecoder("latin1").decode(result.content);

    console.log(`\n[export+mut] stats:`, JSON.stringify(result.stats));
    console.log(`[export+mut] contains 'POC-RENAMED':`, out.includes("POC-RENAMED"));
    expect(out.includes("POC-RENAMED"), "mutation applied").toBe(true);
    expect(out.includes("787661.492898342"), "precision still preserved after mutation").toBe(true);
    expect(MALFORMED_REAL.test(out), "no malformed reals after mutation").toBe(false);
  }, 120_000);
});
