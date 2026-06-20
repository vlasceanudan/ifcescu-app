// Draw ANCPI cadastral parcels in the 3D scene and make them interactive:
//   - snap to parcel corners (for the georef alignment + measurements),
//   - hover/select a parcel to read its number + area,
//   - show short, readable labels (the parcel number) on hover/selection, or all
//     at once via a toggle (474 labels at once is unreadable).
// Parcels come in Stereo 70; we map each ring point back through the current
// georef into model coords, then into the renderer's Y-up world frame, and
// project to screen each frame (same overlay approach as the measure/align tools).
import type { ViewerEngine } from "./engine";
import type { GeorefInfo } from "../ifc/editor";
import type { Parcel } from "../geo/ancpi";
import { ovc } from "./overlayColors";

interface V3 {
  x: number;
  y: number;
  z: number;
}

/** One ring vertex: renderer-world position (for drawing) + its Stereo 70 source. */
interface Vert {
  world: V3;
  e: number;
  n: number;
}

interface ParcelGeom {
  ref: string;
  label: string;
  area: number | null;
  rings: Vert[][];
  labelWorld: V3; // outer-ring centroid (renderer world)
}

/** Selected-parcel summary handed back to the UI. */
export interface ParcelInfo {
  ref: string;
  label: string;
  area: number | null;
}

const NS = "http://www.w3.org/2000/svg";
const SNAP_PX = 16; // screen-space pick radius for parcel corners

/** Inverse of modelToStereo70 (XY only): Stereo 70 → model plane coords. */
function stereoToModelXY(g: GeorefInfo | null, e: number, n: number): { x: number; y: number } {
  if (!g) return { x: e, y: n }; // "real" coordinates: identity
  const t = (g.rotationDeg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  const scale = g.scale || 1;
  const dE = (e - g.eastings) / scale;
  const dN = (n - g.northings) / scale;
  return { x: dE * c + dN * s, y: -dE * s + dN * c };
}

export class ParcelLayer {
  private parcels: ParcelGeom[] = [];
  private armedPick = false;
  private showAll = false;
  private hoverCorner: V3 | null = null; // snap marker (corner-pick mode)
  private hoverParcel = -1; // hovered parcel index (select mode)
  private selParcel = -1; // selected parcel index
  private svg: SVGSVGElement;
  private labels: HTMLDivElement;
  private raf = 0;
  private alive = true;

  constructor(private engine: ViewerEngine, private host: HTMLElement) {
    this.svg = document.createElementNS(NS, "svg");
    this.svg.setAttribute("class", "parcel-overlay");
    Object.assign(this.svg.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "4" });
    this.labels = document.createElement("div");
    Object.assign(this.labels.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: "4" });
    host.appendChild(this.svg);
    host.appendChild(this.labels);
    const tick = () => {
      if (!this.alive) return;
      this.redraw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Recompute the renderer-world ring geometry from parcels + the current georef. */
  setData(parcels: Parcel[], georef: GeorefInfo | null): void {
    const rtc = this.engine.rtcOffset;
    const mb = this.engine.modelBounds();
    const groundY = mb ? mb.min[1] : 0; // draw at the model's ground level
    const toWorld = (e: number, n: number): V3 => {
      const m = stereoToModelXY(georef, e, n);
      return { x: m.x - rtc.x, y: groundY, z: -(m.y - rtc.y) };
    };
    const out: ParcelGeom[] = [];
    for (const p of parcels) {
      const rings: Vert[][] = [];
      for (const ring of p.rings) {
        const verts = ring.map(([e, n]) => ({ world: toWorld(e, n), e, n }));
        if (verts.length >= 2) rings.push(verts);
      }
      if (!rings.length) continue;
      const outer = rings[0];
      let cx = 0, cy = 0, cz = 0;
      for (const v of outer) { cx += v.world.x; cy += v.world.y; cz += v.world.z; }
      out.push({ ref: p.ref, label: p.label, area: p.area, rings, labelWorld: { x: cx / outer.length, y: cy / outer.length, z: cz / outer.length } });
    }
    this.parcels = out;
    this.hoverParcel = -1;
    this.selParcel = -1;
  }

  setShowAllLabels(on: boolean): void {
    this.showAll = on;
  }

  // --- corner-pick mode (georef alignment) --------------------------------
  setArmed(on: boolean): void {
    this.armedPick = on;
    if (!on) this.hoverCorner = null;
  }
  armed(): boolean {
    return this.armedPick;
  }
  pickCorner(clientX: number, clientY: number): { e: number; n: number } | null {
    const hit = this.nearestCorner(clientX, clientY);
    return hit ? { e: hit.e, n: hit.n } : null;
  }
  /** Nearest parcel corner as a renderer-world point (for the measure tool). */
  snapWorld(clientX: number, clientY: number): { point: V3; dist: number } | null {
    const cam = this.engine.renderer.getCamera();
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    const r = this.host.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    let best: V3 | null = null;
    let bestD = SNAP_PX;
    for (const p of this.parcels) {
      for (const ring of p.rings) {
        for (const v of ring) {
          const s = cam.projectToScreen(v.world, w, h);
          if (!s) continue;
          const d = Math.hypot(s.x - px, s.y - py);
          if (d < bestD) { bestD = d; best = v.world; }
        }
      }
    }
    return best ? { point: best, dist: bestD } : null;
  }

  // --- hover / selection --------------------------------------------------
  /** Update hover state (a corner snap when armed, else the parcel under the cursor). */
  onHover(clientX: number, clientY: number): void {
    if (this.armedPick) {
      const hit = this.nearestCorner(clientX, clientY);
      this.hoverCorner = hit ? hit.world : null;
      return;
    }
    this.hoverParcel = this.parcelAt(clientX, clientY);
  }
  /** Select the parcel under the cursor; returns its info (or null if none). */
  selectAt(clientX: number, clientY: number): ParcelInfo | null {
    const i = this.parcelAt(clientX, clientY);
    this.selParcel = i;
    if (i < 0) return null;
    const p = this.parcels[i];
    return { ref: p.ref, label: p.label, area: p.area };
  }
  clearSelection(): void {
    this.selParcel = -1;
  }

  private nearestCorner(clientX: number, clientY: number): Vert | null {
    const cam = this.engine.renderer.getCamera();
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    const r = this.host.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    let best: Vert | null = null;
    let bestD = SNAP_PX;
    for (const p of this.parcels) {
      for (const ring of p.rings) {
        for (const v of ring) {
          const s = cam.projectToScreen(v.world, w, h);
          if (!s) continue;
          const d = Math.hypot(s.x - px, s.y - py);
          if (d < bestD) { bestD = d; best = v; }
        }
      }
    }
    return best;
  }

  /** Index of the parcel whose outer ring contains the cursor (screen space). */
  private parcelAt(clientX: number, clientY: number): number {
    const cam = this.engine.renderer.getCamera();
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    const r = this.host.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    for (let i = 0; i < this.parcels.length; i++) {
      const outer = this.parcels[i].rings[0];
      const poly: { x: number; y: number }[] = [];
      for (const v of outer) {
        const s = cam.projectToScreen(v.world, w, h);
        if (s) poly.push(s);
      }
      if (poly.length >= 3 && pointInPoly(px, py, poly)) return i;
    }
    return -1;
  }

  clear(): void {
    this.parcels = [];
    this.hoverCorner = null;
    this.hoverParcel = -1;
    this.selParcel = -1;
  }

  dispose(): void {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.svg.remove();
    this.labels.remove();
  }

  private redraw(): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    this.labels.replaceChildren();
    if (!this.parcels.length) return;
    const cam = this.engine.renderer.getCamera();
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    const project = (p: V3) => cam.projectToScreen(p, w, h);

    for (let i = 0; i < this.parcels.length; i++) {
      const p = this.parcels[i];
      const selected = i === this.selParcel;
      const hovered = i === this.hoverParcel;
      for (const ring of p.rings) {
        // Project every vertex; some may be behind the camera (null) for large
        // parcels seen up close. Draw from the valid ones instead of dropping the
        // whole parcel — a fully-visible ring gets a filled polygon, a partly
        // off-screen one gets an open outline (no fill) so it still shows.
        const pts: string[] = [];
        let anyNull = false;
        for (const v of ring) {
          const s = project(v.world);
          if (!s) { anyNull = true; continue; }
          pts.push(`${s.x.toFixed(1)},${s.y.toFixed(1)}`);
        }
        if (pts.length < 2) continue;
        const el = document.createElementNS(NS, anyNull ? "polyline" : "polygon");
        el.setAttribute("points", pts.join(" "));
        el.setAttribute("fill", anyNull ? "none" : selected ? ovc.accentFill(0.18) : hovered ? ovc.accentFill(0.10) : "none");
        el.setAttribute("stroke", selected || hovered ? ovc.accent() : ovc.muted());
        el.setAttribute("stroke-width", selected || hovered ? "2.2" : "1.2");
        el.setAttribute("stroke-opacity", selected || hovered ? "1" : "0.7");
        this.svg.appendChild(el);

        if (this.armedPick) {
          for (const v of ring) {
            const s = project(v.world);
            if (!s) continue;
            const dot = document.createElementNS(NS, "circle");
            dot.setAttribute("cx", String(s.x));
            dot.setAttribute("cy", String(s.y));
            dot.setAttribute("r", "3");
            dot.setAttribute("fill", ovc.accent());
            dot.setAttribute("stroke", "rgba(0,0,0,0.5)");
            dot.setAttribute("stroke-width", "1");
            this.svg.appendChild(dot);
          }
        }
      }
      // Label only when useful: hovered, selected, or the show-all toggle is on.
      if (p.label && (this.showAll || selected || hovered)) {
        const s = project(p.labelWorld);
        if (s) this.label(p.label, s.x, s.y, selected);
      }
    }

    if (this.armedPick && this.hoverCorner) {
      const s = project(this.hoverCorner);
      if (s) {
        const r = 9;
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("x", String(s.x - r));
        rect.setAttribute("y", String(s.y - r));
        rect.setAttribute("width", String(r * 2));
        rect.setAttribute("height", String(r * 2));
        rect.setAttribute("fill", "none");
        rect.setAttribute("stroke", ovc.accent());
        rect.setAttribute("stroke-width", "2.5");
        this.svg.appendChild(rect);
      }
    }
  }

  private label(text: string, x: number, y: number, selected: boolean): void {
    const d = document.createElement("div");
    d.textContent = text;
    Object.assign(d.style, {
      position: "absolute",
      left: `${x}px`,
      top: `${y}px`,
      transform: "translate(-50%,-50%)",
      background: selected ? ovc.accentFill(0.92) : ovc.chip,
      color: "#fff",
      font: "11px system-ui, sans-serif",
      fontWeight: "600",
      padding: "1px 6px",
      borderRadius: "4px",
      whiteSpace: "nowrap",
      pointerEvents: "none",
    });
    this.labels.appendChild(d);
  }
}

/** Even-odd point-in-polygon test on screen coords. */
function pointInPoly(px: number, py: number, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
