// Custom measurement tool for the web-ifc-viewer scene.
//
// web-ifc-viewer's built-in `dimensions` only does linear measures with no
// snapping. This implements length, point and area measurement with AutoCAD-style
// object snapping (endpoint / midpoint / section-intersection / on-edge), drawn
// into the viewer's three.js scene with HTML labels and a screen-space snap glyph.

import * as THREE from "three";
import type { GeorefInfo } from "../ifc/editor";

export type MeasureMode = "none" | "length" | "point" | "area";
type SnapType = "end" | "mid" | "int" | "edge" | "free";

const SNAP_PX = 16;
const DOT_PX = 3.5; // measurement point radius in screen pixels (constant size)
const MAGENTA = 0xe6007e;
const TEAL = 0x00a0af;
const SNAP_COLOR = "#16e04b";

const SNAP_LABEL: Record<SnapType, string> = {
  end: "Capăt",
  mid: "Mijloc",
  int: "Intersecție",
  edge: "Pe muchie",
  free: "",
};

interface LabelRef {
  el: HTMLDivElement;
  world: THREE.Vector3;
}
interface Measurement {
  objects: THREE.Object3D[];
  labels: LabelRef[];
}
interface Snap {
  p: THREE.Vector3;
  type: SnapType;
  prio: number;
}

export class MeasureTool {
  mode: MeasureMode = "none";

  /** When set, the Point tool also reports projected (Stereo 70) coordinates. */
  private georef: GeorefInfo | null = null;

  /**
   * Scene-space translation applied to the model at load to keep it near the
   * origin (anti-jitter). Added back to picked points so reported coordinates
   * are in the original IFC frame. Zero when the model wasn't recentred.
   */
  private modelOffset = new THREE.Vector3();

  private group = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private labelLayer: HTMLDivElement;
  private snapEl: HTMLDivElement;
  private snapWorld: THREE.Vector3 | null = null;
  private snapTypeShown: SnapType | null = null;
  private rafId = 0;

  private pendingPts: THREE.Vector3[] = [];
  private pendingObjs: THREE.Object3D[] = [];
  private previewLine: THREE.Line | null = null;
  private previewLabel: LabelRef | null = null;

  private measurements: Measurement[] = [];

  constructor(
    private viewer: any,
    private host: HTMLElement,
  ) {
    const scene: THREE.Scene = viewer.context.getScene();
    scene.add(this.group);

    this.labelLayer = document.createElement("div");
    Object.assign(this.labelLayer.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      overflow: "hidden",
      zIndex: "6",
    } as CSSStyleDeclaration);
    this.host.appendChild(this.labelLayer);

    this.snapEl = document.createElement("div");
    this.snapEl.setAttribute("data-snap", "1");
    Object.assign(this.snapEl.style, {
      position: "absolute",
      transform: "translate(-50%, -50%)",
      pointerEvents: "none",
      display: "none",
      filter: "drop-shadow(0 0 1.5px rgba(0,0,0,.85))",
    } as CSSStyleDeclaration);
    this.labelLayer.appendChild(this.snapEl);

    this.loop();
  }

  // --- public API ---------------------------------------------------------
  setMode(mode: MeasureMode) {
    this.cancelPending();
    this.mode = mode;
    this.hideSnap();
  }

  setGeoref(georef: GeorefInfo | null) {
    this.georef = georef;
  }

  /** Tell the tool how far the model geometry was shifted from its IFC origin. */
  setModelOffset(offset: THREE.Vector3) {
    this.modelOffset.copy(offset);
  }

  clearAll() {
    this.cancelPending();
    for (const m of this.measurements) {
      for (const o of m.objects) this.disposeObject(o);
      for (const l of m.labels) l.el.remove();
    }
    this.measurements = [];
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    this.clearAll();
    this.group.removeFromParent();
    this.labelLayer.remove();
  }

  onMove(ev: MouseEvent) {
    if (this.mode === "none") return;
    const hit = this.intersect(ev);
    if (!hit) {
      this.hideSnap();
      this.updatePreview(null);
      return;
    }
    const snap = this.snap(hit, ev);
    this.setSnap(snap.type, snap.p);
    this.updatePreview(snap.p);
  }

  /** Returns true if the click was consumed by the measurement tool. */
  onClick(ev: MouseEvent): boolean {
    if (this.mode === "none") return false;
    const hit = this.intersect(ev);
    if (!hit) return true;
    const p = this.snap(hit, ev).p.clone();

    if (this.mode === "point") {
      this.measurements.push({
        objects: [this.dot(p, TEAL)],
        labels: [this.makeLabel(this.fmtPoint(p), p)],
      });
      return true;
    }

    this.pendingPts.push(p);
    this.pendingObjs.push(this.dot(p, TEAL));
    if (this.mode === "length" && this.pendingPts.length === 2) this.finishLength();
    return true;
  }

  onDblClick(): boolean {
    if (this.mode === "area" && this.pendingPts.length >= 3) {
      this.finishArea();
      return true;
    }
    return false;
  }

  // --- finalisation -------------------------------------------------------
  private finishLength() {
    const [a, b] = this.pendingPts;
    const label = this.makeLabel(`${a.distanceTo(b).toFixed(2)} m`, a.clone().add(b).multiplyScalar(0.5));
    this.measurements.push({ objects: [...this.pendingObjs, this.line([a, b])], labels: [label] });
    this.resetPending(true);
  }

  private finishArea() {
    const pts = this.pendingPts.slice();
    const loop = this.line([...pts, pts[0]]);
    const centroid = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const label = this.makeLabel(`${polygonArea(pts).toFixed(2)} m²`, centroid);
    this.measurements.push({ objects: [...this.pendingObjs, loop], labels: [label] });
    this.resetPending(true);
  }

  // --- snapping -----------------------------------------------------------
  private snap(hit: THREE.Intersection, ev: MouseEvent): Snap {
    const surface = hit.point.clone();
    const face = hit.face;
    const mesh = hit.object as THREE.Mesh;
    if (!face) return { p: surface, type: "free", prio: 9 };

    const pos = (mesh.geometry as THREE.BufferGeometry).attributes.position as THREE.BufferAttribute;
    const vtx = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const A = vtx(face.a), B = vtx(face.b), C = vtx(face.c);
    const planes = this.clipPlanes();
    const visible = (p: THREE.Vector3) => planes.every((P) => P.distanceToPoint(p) >= -1e-3);

    const cands: Snap[] = [];
    // Endpoints (vertices).
    for (const v of [A, B, C]) if (visible(v)) cands.push({ p: v, type: "end", prio: 0 });
    // Section cut: where each clipping plane crosses this triangle.
    for (const P of planes) {
      const seg = triPlaneIntersection(A, B, C, P);
      for (const sp of seg) cands.push({ p: sp, type: "int", prio: 1 });
      if (seg.length === 2)
        cands.push({ p: seg[0].clone().add(seg[1]).multiplyScalar(0.5), type: "mid", prio: 2 });
    }
    // Edge midpoints.
    for (const [u, v] of [[A, B], [B, C], [C, A]] as const) {
      const m = u.clone().add(v).multiplyScalar(0.5);
      if (visible(m)) cands.push({ p: m, type: "mid", prio: 2 });
    }
    // Nearest point on each edge.
    for (const [u, v] of [[A, B], [B, C], [C, A]] as const) {
      const np = closestOnSegment(surface, u, v);
      if (visible(np)) cands.push({ p: np, type: "edge", prio: 3 });
    }

    const r = this.rect();
    const cursor = new THREE.Vector2(ev.clientX - r.left, ev.clientY - r.top);
    let best: Snap | null = null;
    let bestScore = Infinity;
    for (const c of cands) {
      const d = this.toPx(c.p).distanceTo(cursor);
      if (d > SNAP_PX) continue;
      const score = c.prio * 1000 + d; // priority first, then proximity
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best ?? { p: surface, type: "free", prio: 9 };
  }

  private setSnap(type: SnapType, world: THREE.Vector3) {
    this.snapWorld = world;
    if (type !== this.snapTypeShown) {
      this.snapTypeShown = type;
      this.snapEl.innerHTML = snapGlyph(type);
    }
    this.snapEl.style.display = "block";
  }

  private hideSnap() {
    this.snapWorld = null;
    this.snapTypeShown = null;
    this.snapEl.style.display = "none";
  }

  // --- preview ------------------------------------------------------------
  private updatePreview(cursor: THREE.Vector3 | null) {
    if (this.previewLine) {
      this.disposeObject(this.previewLine);
      this.previewLine = null;
    }
    if (this.previewLabel) {
      this.previewLabel.el.remove();
      this.previewLabel = null;
    }
    if (!cursor) return;
    const anchor =
      this.mode === "length" && this.pendingPts.length === 1
        ? this.pendingPts[0]
        : this.mode === "area" && this.pendingPts.length >= 1
          ? this.pendingPts[this.pendingPts.length - 1]
          : null;
    if (!anchor) return;
    this.previewLine = this.line([anchor, cursor]);
    if (this.mode === "length")
      this.previewLabel = this.makeLabel(
        `${anchor.distanceTo(cursor).toFixed(2)} m`,
        anchor.clone().add(cursor).multiplyScalar(0.5),
      );
  }

  // --- three.js / projection helpers --------------------------------------
  private get camera(): THREE.Camera {
    return this.viewer.context.getCamera();
  }
  private rect(): DOMRect {
    return this.host.getBoundingClientRect();
  }
  private clipPlanes(): THREE.Plane[] {
    try {
      return (this.viewer.context.getClippingPlanes?.() as THREE.Plane[]) ?? [];
    } catch {
      return [];
    }
  }

  /** Scale all point markers to a constant on-screen size (AutoCAD-like). */
  private sizeDots() {
    const cam = this.camera;
    const h = this.rect().height || 1;
    for (const o of this.group.children) {
      const mesh = o as THREE.Mesh;
      if (!(mesh as any).isMesh) continue;
      let s: number;
      if ((cam as any).isOrthographicCamera) {
        const oc = cam as THREE.OrthographicCamera;
        s = ((oc.top - oc.bottom) / oc.zoom / h) * DOT_PX;
      } else {
        const pc = cam as THREE.PerspectiveCamera;
        const dist = pc.position.distanceTo(mesh.position);
        s = ((2 * Math.tan(((pc.fov ?? 50) * Math.PI) / 180 / 2)) / h) * dist * DOT_PX;
      }
      mesh.scale.setScalar(s || 0.001);
    }
  }

  private intersect(ev: MouseEvent): THREE.Intersection | null {
    const r = this.rect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - r.left) / r.width) * 2 - 1,
      -((ev.clientY - r.top) / r.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    (this.raycaster as any).firstHitOnly = false;
    const meshes = this.viewer.context.items.pickableIfcModels as THREE.Mesh[];
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    const planes = this.clipPlanes();
    if (!planes.length) return hits[0];
    for (const h of hits) if (planes.every((p) => p.distanceToPoint(h.point) >= -1e-4)) return h;
    return null;
  }

  private toPx(world: THREE.Vector3): THREE.Vector2 {
    const r = this.rect();
    const v = world.clone().project(this.camera);
    return new THREE.Vector2((v.x * 0.5 + 0.5) * r.width, (-v.y * 0.5 + 0.5) * r.height);
  }

  private fmtPoint(p: THREE.Vector3): string {
    // Undo the anti-jitter recenter so we read the original scene position, then
    // convert back to IFC coordinates. web-ifc-viewer renders IFC (Z-up) geometry
    // as three.js (Y-up): the scene vector is (ifcX, ifcZ, -ifcY), so X is East,
    // Y is North and Z is the height.
    const sx = p.x + this.modelOffset.x;
    const sy = p.y + this.modelOffset.y;
    const sz = p.z + this.modelOffset.z;
    const ifcX = sx;
    const ifcY = -sz;
    const ifcZ = sy;
    const local = `X ${ifcX.toFixed(2)}  Y ${ifcY.toFixed(2)}  Z ${ifcZ.toFixed(2)}`;
    const g = this.georef;
    if (!g) return local;
    // IfcMapConversion forward transform: model (x,y,z) → projected (E,N,H).
    const t = (g.rotationDeg * Math.PI) / 180;
    const ca = Math.cos(t), sa = Math.sin(t);
    const E = g.eastings + g.scale * (ifcX * ca - ifcY * sa);
    const N = g.northings + g.scale * (ifcX * sa + ifcY * ca);
    const H = g.height + ifcZ;
    return `${local}\nE ${E.toFixed(2)}  N ${N.toFixed(2)}  H ${H.toFixed(2)}`;
  }

  private dot(p: THREE.Vector3, color: number): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 16),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    m.scale.setScalar(0.001); // real size set each frame by sizeDots()
    m.position.copy(p);
    m.renderOrder = 999;
    this.group.add(m);
    return m;
  }

  private line(points: THREE.Vector3[]): THREE.Line {
    const l = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: MAGENTA, depthTest: false }),
    );
    l.renderOrder = 999;
    this.group.add(l);
    return l;
  }

  // --- labels -------------------------------------------------------------
  private makeLabel(text: string, world: THREE.Vector3): LabelRef {
    const el = document.createElement("div");
    el.textContent = text;
    Object.assign(el.style, {
      position: "absolute",
      transform: "translate(-50%, -50%)",
      background: "rgba(255,255,255,.95)",
      color: "#222",
      border: "1px solid #00a0af",
      borderRadius: "4px",
      padding: "2px 7px",
      font: "600 13px system-ui, sans-serif",
      whiteSpace: "pre",
      textAlign: "center",
    } as CSSStyleDeclaration);
    this.labelLayer.appendChild(el);
    return { el, world };
  }

  private allLabels(): LabelRef[] {
    const out: LabelRef[] = [];
    for (const m of this.measurements) out.push(...m.labels);
    if (this.previewLabel) out.push(this.previewLabel);
    return out;
  }

  private loop = () => {
    const r = this.rect();
    const place = (el: HTMLDivElement, world: THREE.Vector3) => {
      const v = world.clone().project(this.camera);
      if (v.z > 1) {
        el.style.display = "none";
        return;
      }
      el.style.display = "block";
      el.style.left = `${(v.x * 0.5 + 0.5) * r.width}px`;
      el.style.top = `${(-v.y * 0.5 + 0.5) * r.height}px`;
    };
    for (const { el, world } of this.allLabels()) place(el, world);
    if (this.snapWorld) place(this.snapEl, this.snapWorld);
    this.sizeDots();
    this.rafId = requestAnimationFrame(this.loop);
  };

  // --- cleanup ------------------------------------------------------------
  private resetPending(keepObjs: boolean) {
    if (!keepObjs) for (const o of this.pendingObjs) this.disposeObject(o);
    this.pendingObjs = [];
    this.pendingPts = [];
    if (this.previewLine) {
      this.disposeObject(this.previewLine);
      this.previewLine = null;
    }
    if (this.previewLabel) {
      this.previewLabel.el.remove();
      this.previewLabel = null;
    }
  }
  private cancelPending() {
    this.resetPending(false);
  }
  private disposeObject(o: THREE.Object3D) {
    o.removeFromParent();
    const any = o as any;
    any.geometry?.dispose?.();
    any.material?.dispose?.();
  }
}

/** AutoCAD-style snap glyph (constant screen size) + type label. */
function snapGlyph(type: SnapType): string {
  const s = `stroke="${SNAP_COLOR}" stroke-width="2" fill="none"`;
  const shapes: Record<SnapType, string> = {
    end: `<rect x="3" y="3" width="12" height="12" ${s}/>`,
    mid: `<polygon points="9,3 16,15 2,15" ${s}/>`,
    int: `<path d="M4 4 L14 14 M14 4 L4 14" ${s}/>`,
    edge: `<polygon points="9,2 16,9 9,16 2,9" ${s}/>`,
    free: `<circle cx="9" cy="9" r="2.5" fill="${SNAP_COLOR}"/>`,
  };
  const label =
    type === "free"
      ? ""
      : `<div style="position:absolute;left:14px;top:-2px;background:rgba(0,0,0,.72);color:#fff;
           font:600 12px system-ui;padding:1px 6px;border-radius:3px;white-space:nowrap">${SNAP_LABEL[type]}</div>`;
  return `<svg width="18" height="18" viewBox="0 0 18 18" style="display:block">${shapes[type]}</svg>${label}`;
}

function closestOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
  return a.clone().add(ab.multiplyScalar(t));
}

/** Points where a plane crosses a triangle's edges (0 or 2 points). */
function triPlaneIntersection(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  plane: THREE.Plane,
): THREE.Vector3[] {
  const tri = [a, b, c];
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < 3; i++) {
    const u = tri[i], v = tri[(i + 1) % 3];
    const du = plane.distanceToPoint(u), dv = plane.distanceToPoint(v);
    if (du < 0 !== dv < 0 && du !== dv) out.push(u.clone().lerp(v, du / (du - dv)));
  }
  return out;
}

/** Area of a (near-planar) 3D polygon via the Newell/cross-product method. */
function polygonArea(pts: THREE.Vector3[]): number {
  const normal = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  }
  return normal.length() / 2;
}
