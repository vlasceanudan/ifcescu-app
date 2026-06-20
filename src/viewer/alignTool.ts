// Cadastral alignment tool: capture two model points (A, B) by snapping in the
// 3D viewer, to pair with two ANCPI parcel corners for georeferencing. Mirrors
// MeasureTool's overlay approach — an SVG layer projected each frame via
// camera.projectToScreen — but only ever holds two labelled points.
import type { ViewerEngine, SnapType } from "./engine";
import type { GeorefInfo } from "../ifc/editor";
import { coordDecimals } from "../settings/format";
import { ovc } from "./overlayColors";

export type AlignSlot = "A" | "B";

interface V3 {
  x: number;
  y: number;
  z: number;
}

const NS = "http://www.w3.org/2000/svg";

/** IFC model point → Stereo 70 (Est, Nord). Identity when no georef (for labels). */
function modelToEN(g: GeorefInfo | null, p: V3): { e: number; n: number } {
  if (!g) return { e: p.x, n: p.y };
  const t = (g.rotationDeg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return { e: g.eastings + g.scale * (p.x * c - p.y * s), n: g.northings + g.scale * (p.x * s + p.y * c) };
}

export class AlignTool {
  private georef: GeorefInfo | null = null;
  private slot: AlignSlot | null = null; // which point the next click fills
  /** Captured points in renderer-world frame (for projection/drawing). */
  private worldPts: { A: V3 | null; B: V3 | null } = { A: null, B: null };
  private hover: V3 | null = null;
  private hoverType: SnapType = "face";
  private svg: SVGSVGElement;
  private labels: HTMLDivElement;
  private raf = 0;
  private alive = true;

  constructor(
    private engine: ViewerEngine,
    private host: HTMLElement,
    /** Called with the captured point in raw IFC coords when a slot is filled. */
    private onCapture: (slot: AlignSlot, ifcPoint: V3) => void,
  ) {
    this.svg = document.createElementNS(NS, "svg");
    this.svg.setAttribute("class", "align-overlay");
    Object.assign(this.svg.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "5" });
    this.labels = document.createElement("div");
    Object.assign(this.labels.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: "6" });
    host.appendChild(this.svg);
    host.appendChild(this.labels);
    const tick = () => {
      if (!this.alive) return;
      this.redraw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  setGeoref(g: GeorefInfo | null): void {
    this.georef = g;
  }

  /** Arm the tool so the next viewer click captures into `slot`. */
  arm(slot: AlignSlot): void {
    this.slot = slot;
  }
  disarm(): void {
    this.slot = null;
    this.hover = null;
  }
  armed(): boolean {
    return this.slot != null;
  }

  private hit(ev: MouseEvent): V3 | null {
    const s = this.engine.snap(ev.clientX, ev.clientY);
    if (!s) return null;
    this.hoverType = s.type;
    return { x: s.point.x, y: s.point.y, z: s.point.z };
  }

  onClick(ev: MouseEvent): void {
    if (!this.slot) return;
    const p = this.hit(ev);
    if (!p) return;
    const slot = this.slot;
    this.worldPts[slot] = p;
    this.slot = null;
    this.hover = null;
    this.onCapture(slot, this.engine.worldToIfc(p));
  }

  onMove(ev: MouseEvent): void {
    if (!this.slot) return;
    this.hover = this.hit(ev);
  }

  clear(): void {
    this.worldPts = { A: null, B: null };
    this.slot = null;
    this.hover = null;
  }

  dispose(): void {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.svg.remove();
    this.labels.remove();
  }

  // --- rendering ----------------------------------------------------------
  private project(p: V3): { x: number; y: number } | null {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    return this.engine.renderer.getCamera().projectToScreen(p, w, h);
  }

  private redraw(): void {
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);
    this.labels.replaceChildren();

    const draw = (slot: AlignSlot, color: string) => {
      const wp = this.worldPts[slot];
      if (!wp) return;
      const c = this.project(wp);
      if (!c) return;
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", String(c.x));
      dot.setAttribute("cy", String(c.y));
      dot.setAttribute("r", "5");
      dot.setAttribute("fill", "#fff");
      dot.setAttribute("stroke", color);
      dot.setAttribute("stroke-width", "2.5");
      this.svg.appendChild(dot);
      const en = modelToEN(this.georef, this.engine.worldToIfc(wp));
      const dp = coordDecimals();
      const txt = this.georef ? `${slot}  E ${en.e.toFixed(dp)}  N ${en.n.toFixed(dp)}` : slot;
      this.label(txt, c.x, c.y, color);
    };
    draw("A", ovc.accent());
    draw("B", ovc.teal());

    // Snap marker at the cursor while armed.
    if (this.slot && this.hover) {
      const c = this.project(this.hover);
      if (c) {
        const col = this.hoverType === "vertex" ? "#bcf124"
          : this.hoverType === "midpoint" ? "#ff9d00"
            : this.hoverType === "edge" ? "#00d0ff" : "#ffd400";
        const r = 9;
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("x", String(c.x - r));
        rect.setAttribute("y", String(c.y - r));
        rect.setAttribute("width", String(r * 2));
        rect.setAttribute("height", String(r * 2));
        if (this.hoverType === "edge") rect.setAttribute("transform", `rotate(45 ${c.x} ${c.y})`);
        rect.setAttribute("fill", "none");
        rect.setAttribute("stroke", col);
        rect.setAttribute("stroke-width", "2.5");
        this.svg.appendChild(rect);
      }
    }
  }

  private label(text: string, x: number, y: number, color: string): void {
    const d = document.createElement("div");
    d.textContent = text;
    Object.assign(d.style, {
      position: "absolute",
      left: `${x}px`,
      top: `${y}px`,
      transform: "translate(-50%,-150%)",
      background: "rgba(20,20,24,0.85)",
      color: "#fff",
      borderLeft: `3px solid ${color}`,
      font: "12px system-ui, sans-serif",
      padding: "2px 6px",
      borderRadius: "4px",
      whiteSpace: "pre",
    });
    this.labels.appendChild(d);
  }
}
