// Write/replace the IfcMapConversion in an exported STEP (.ifc) text so a georef
// computed in the app becomes permanent. @ifc-lite/mutations can update existing
// attributes/property-sets but cannot create new entities, so this post-processes
// the exported STEP text directly:
//   - if an IFCMAPCONVERSION already exists → rewrite its numeric arguments,
//   - else (IFC4 / IFC4x3) → inject IFCPROJECTEDCRS + IFCMAPCONVERSION referencing
//     the model's IfcGeometricRepresentationContext.
// IFC2x3 has no map conversion in the schema, so it is returned unchanged.
import type { GeorefInfo } from "../ifc/editor";
import type { IfcSchema } from "../ifc/store";

// STEP files are ISO-8859-1 (Latin-1). Decoding/encoding 1:1 by char code keeps
// every original byte intact while we splice ASCII numbers/identifiers in.
function latin1Decode(bytes: Uint8Array): string {
  let s = "";
  // Chunk to avoid call-stack limits on String.fromCharCode(...spread).
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return s;
}
function latin1Encode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Format a number as a STEP real literal (always has a decimal point/exponent). */
function real(n: number): string {
  if (!Number.isFinite(n)) return "0.";
  // Up to 12 significant digits, then strip trailing zeros; ensure a dot remains.
  let s = n.toPrecision(12);
  if (s.indexOf("e") === -1 && s.indexOf("E") === -1) {
    if (s.indexOf(".") !== -1) s = s.replace(/0+$/, "").replace(/\.$/, ".0");
    else s += ".";
  }
  return s;
}

/** Split a STEP argument list (no surrounding parens) on top-level commas. */
function splitArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      // STEP escapes a quote by doubling it ('').
      if (ch === "'") {
        if (inner[i + 1] === "'") i++;
        else inStr = false;
      }
      continue;
    }
    if (ch === "'") inStr = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  args.push(inner.slice(start));
  return args;
}

/** Highest #id referenced anywhere (definitions AND references), so a freshly
 *  allocated id can't collide with an id that's only used as a reference. */
function maxExpressId(text: string): number {
  let m = 0;
  const re = /#(\d+)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(text))) {
    const id = Number(hit[1]);
    if (id > m) m = id;
  }
  return m;
}

/** Trig terms for the map conversion's X-axis direction. */
function axis(g: GeorefInfo): { abscissa: number; ordinate: number } {
  const t = (g.rotationDeg * Math.PI) / 180;
  return { abscissa: Math.cos(t), ordinate: Math.sin(t) };
}

export interface WriteResult {
  bytes: Uint8Array;
  /** What happened, for surfacing to the user / logging. */
  mode: "updated" | "injected" | "unsupported";
}

/**
 * Return new STEP bytes with the georef written. `mode` reports whether an
 * existing conversion was updated, a new one injected, or the schema can't hold it.
 */
export function writeMapConversion(bytes: Uint8Array, g: GeorefInfo, schema: IfcSchema): WriteResult {
  if (schema === "IFC2X3") return { bytes, mode: "unsupported" };
  const text = latin1Decode(bytes);
  const { abscissa, ordinate } = axis(g);

  // --- Case 1: an IfcMapConversion already exists → rewrite its numeric args ---
  // IFCMAPCONVERSION(SourceCRS, TargetCRS, Eastings, Northings, OrthogonalHeight,
  //                  XAxisAbscissa, XAxisOrdinate, Scale)
  const mcRe = /(#\d+\s*=\s*IFCMAPCONVERSION\s*\()([\s\S]*?)(\)\s*;)/i;
  const mcHit = mcRe.exec(text);
  if (mcHit) {
    const args = splitArgs(mcHit[2]);
    if (args.length >= 5) {
      args[2] = real(g.eastings);
      args[3] = real(g.northings);
      args[4] = real(g.height);
      // XAxisAbscissa / XAxisOrdinate / Scale are optional in the schema; set all.
      args[5] = real(abscissa);
      args[6] = real(ordinate);
      args[7] = real(g.scale);
      const rebuilt = mcHit[1] + args.join(",") + mcHit[3];
      return { bytes: latin1Encode(text.slice(0, mcHit.index) + rebuilt + text.slice(mcHit.index + mcHit[0].length)), mode: "updated" };
    }
  }

  // --- Case 2: no conversion → inject IfcProjectedCRS + IfcMapConversion ---
  // Find the model's geometric representation context (the SourceCRS). Prefer one
  // whose ContextType is 'Model'; fall back to the first context found.
  let ctxId = 0;
  const ctxRe = /#(\d+)\s*=\s*IFCGEOMETRICREPRESENTATIONCONTEXT\s*\(([\s\S]*?)\)\s*;/gi;
  let ctxHit: RegExpExecArray | null;
  while ((ctxHit = ctxRe.exec(text))) {
    const id = Number(ctxHit[1]);
    if (ctxId === 0) ctxId = id; // first as fallback
    if (/'Model'/i.test(ctxHit[2])) { ctxId = id; break; }
  }
  if (ctxId === 0) return { bytes, mode: "unsupported" }; // nothing valid to anchor to

  // Reuse an existing IfcProjectedCRS if present, else create one for EPSG:3844.
  let crsId = 0;
  const crsHit = /#(\d+)\s*=\s*IFCPROJECTEDCRS\s*\(/i.exec(text);
  const newLines: string[] = [];
  let nextId = maxExpressId(text);
  if (crsHit) {
    crsId = Number(crsHit[1]);
  } else {
    crsId = ++nextId;
    const name = (g.crsName || "EPSG:3844").replace(/'/g, "''");
    // IFCPROJECTEDCRS(Name, Description, GeodeticDatum, VerticalDatum, MapProjection, MapZone, MapUnit)
    newLines.push(`#${crsId}=IFCPROJECTEDCRS('${name}',$,$,$,$,$,$);`);
  }
  const mcId = ++nextId;
  newLines.push(
    `#${mcId}=IFCMAPCONVERSION(#${ctxId},#${crsId},${real(g.eastings)},${real(g.northings)},${real(g.height)},${real(abscissa)},${real(ordinate)},${real(g.scale)});`,
  );

  // Insert before ENDSEC; that closes the DATA section.
  const endRe = /ENDSEC\s*;\s*END-ISO-10303-21\s*;/i;
  const endHit = endRe.exec(text);
  const block = newLines.join("\n") + "\n";
  if (endHit) {
    const out = text.slice(0, endHit.index) + block + text.slice(endHit.index);
    return { bytes: latin1Encode(out), mode: "injected" };
  }
  // Fallback: no recognisable DATA terminator — append (rare/malformed files).
  return { bytes: latin1Encode(text + "\n" + block), mode: "injected" };
}
