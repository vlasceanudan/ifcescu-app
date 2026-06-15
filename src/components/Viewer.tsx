import { type ReactNode, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { IfcViewerAPI } from "web-ifc-viewer";
import { Color, Box3, Sphere, Vector3, Group, Raycaster, Vector2, EdgesGeometry } from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial";
import type { Theme } from "../hooks/useTheme";
import type { GeorefInfo } from "../ifc/editor";
import { resolveModelSchema } from "../ifc/api";
import { MeasureTool, type MeasureMode } from "../viewer/measure";
import { IfcTree, type TreeNode } from "./IfcTree";
import { PropAccordion, type PropGroup } from "./PropsPanel";

interface Props {
  bytes: Uint8Array;
  fileName: string;
  theme: Theme;
  georef: GeorefInfo | null;
}

const VIEWER_BG: Record<Theme, string> = { light: "#eef0f4", dark: "#15161a" };
const SELECT_COLOR = 0xbcf124; // selection outline (lime), not magenta
const SELECT_WIDTH = 3; // outline thickness in pixels (fat lines)

/** Grouped toolbar dropdown (Trimble-style): closes on click-outside / Escape. */
function Dropdown({ label, icon, active, children }: { label: string; icon: string; active?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="vgroup" ref={ref}>
      <button className={"vbtn" + (active ? " active" : "")} onClick={() => setOpen((o) => !o)}>
        <span className="ic">{icon}</span>
        <span>{label}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="vmenu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Viewer({ bytes, fileName, theme, georef }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<any>(null);
  const measureRef = useRef<MeasureTool | null>(null);
  const georefRef = useRef<GeorefInfo | null>(georef);
  const selGroupRef = useRef<Group | null>(null);
  const stateRef = useRef<{ modelID: number; allIDs: number[] }>({ modelID: -1, allIDs: [] });
  const visibleRef = useRef<Set<number>>(new Set());
  const selectedRef = useRef<Set<number>>(new Set());
  const sectionRef = useRef(false);
  const ray = useRef(new Raycaster());

  const [status, setStatus] = useState("Se inițializează vizualizatorul…");
  const [measureMode, setMeasureMode] = useState<MeasureMode>("none");
  const [section, setSection] = useState(false);
  const [propGroups, setPropGroups] = useState<PropGroup[] | null>(null);
  const [propsKey, setPropsKey] = useState(0);
  const [propsWidth, setPropsWidth] = useState(340);
  const [treeWidth, setTreeWidth] = useState(300);
  const [tree, setTree] = useState<TreeNode | null>(null);

  // Element leaves are grouped under their IFC class (collapsed), with the
  // spatial containers expanded.
  const displayTree = useMemo(() => (tree ? groupByClass(tree, { n: 0 }) : tree), [tree]);
  const [visibleIds, setVisibleIds] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    const host = hostRef.current;
    if (!host || viewerRef.current) return;
    let disposed = false;

    const viewer = new IfcViewerAPI({ container: host, backgroundColor: new Color(VIEWER_BG[theme]) });
    viewerRef.current = viewer;
    (window as any).__viewer = viewer;
    viewer.IFC.setWasmPath(import.meta.env.BASE_URL);

    // When the viewer container resizes (panel drag / window), the canvas +
    // postproduction overlay stretch via CSS (smooth, no flicker); the renderer
    // is resized crisply only AFTER resizing settles (debounced) to avoid the
    // per-frame composer re-size that caused flicker during a drag.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      setSelResolution();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          viewerRef.current?.context?.updateAspect?.();
        } catch {
          /* ignore */
        }
      }, 150);
    });
    ro.observe(host);

    (async () => {
      try {
        setStatus("Se încarcă modelul IFC…");
        const file = new File([bytes as unknown as BlobPart], fileName || "model.ifc");
        const model = await viewer.IFC.loadIfc(file, true);
        if (disposed) return;

        // Same web-ifc 0.0.39 IFC4X3 schema-mapping bug as the editor: without
        // this, the spatial tree, properties and selection (all GetLine-based)
        // fail for IFC4X3 files. Geometry already loaded via the WASM parser.
        try {
          resolveModelSchema(viewer.IFC.loader.ifcManager.ifcAPI, model.modelID, bytes);
        } catch {
          /* viewer may bundle a different web-ifc build */
        }

        const allIDs = Array.from(new Set<number>(Array.from(model.geometry.attributes.expressID.array as ArrayLike<number>)));
        stateRef.current = { modelID: model.modelID, allIDs };
        visibleRef.current = new Set(allIDs);
        setVisibleIds(new Set(allIDs));
        installDisplaySubset(viewer, model, allIDs);

        const sel = new Group();
        viewer.context.getScene().add(sel);
        selGroupRef.current = sel;

        measureRef.current = new MeasureTool(viewer, host);
        measureRef.current.setGeoref(georefRef.current);
        setStatus("Model încărcat • orbit: stânga • pan: dreapta • zoom: scroll • Esc: anulează");
        wireEvents(host, viewer);

        // Build the spatial-structure tree (names included).
        try {
          const struct = await viewer.IFC.getSpatialStructure(model.modelID, true);
          const allSet = new Set(allIDs);
          setTree(toTreeNode(struct, allSet));
        } catch {
          /* tree optional */
        }
      } catch (e: any) {
        if (!disposed) setStatus("Eroare la încărcarea modelului: " + (e?.message ?? e));
      }
    })();

    return () => {
      disposed = true;
      try {
        measureRef.current?.dispose();
        viewer.dispose();
      } catch {
        /* ignore */
      }
      clearTimeout(resizeTimer);
      ro.disconnect();
      measureRef.current = null;
      viewerRef.current = null;
      delete (window as any).__viewer;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update the viewer background when the app theme changes.
  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    try {
      v.context.getScene().background = new Color(VIEWER_BG[theme]);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // Keep the measurement tool's projected-coordinate reference in sync.
  useEffect(() => {
    georefRef.current = georef;
    measureRef.current?.setGeoref(georef);
  }, [georef]);

  // Keyboard shortcuts: Esc cancels the active command; H hides the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        measureRef.current?.setMode("none");
        setMeasureMode("none");
        if (sectionRef.current) {
          sectionRef.current = false;
          setSection(false);
        }
        setStatus("Comandă anulată (Esc).");
        return;
      }
      if ((e.key === "h" || e.key === "H") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (selectedRef.current.size) {
          hideIds([...selectedRef.current]);
          setStatus("Element(e) ascuns(e) (H). Folosiți Vizibilitate → Afișează tot.");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function wireEvents(host: HTMLElement, viewer: any) {
    host.onclick = (ev: MouseEvent) => {
      const measure = measureRef.current;
      if (measure && measure.mode !== "none") {
        measure.onClick(ev);
        return;
      }
      if (sectionRef.current) return;
      const hit = raycastVisible(viewer, ev);
      if (hit) {
        const id = readExpressId(hit);
        if (id != null) {
          selectIds([id], id);
          return;
        }
      }
      clearSelection();
    };

    host.ondblclick = () => {
      const measure = measureRef.current;
      if (measure && measure.mode === "area") {
        measure.onDblClick();
        return;
      }
      if (sectionRef.current) viewer.clipper.createPlane();
    };

    // Measurement hover only — NO selection/preselection highlight on move.
    host.onmousemove = (ev: MouseEvent) => {
      const measure = measureRef.current;
      if (measure && measure.mode !== "none") measure.onMove(ev);
    };
  }

  const raycastVisible = (viewer: any, ev: MouseEvent) => {
    const host = hostRef.current!;
    const r = host.getBoundingClientRect();
    const ndc = new Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.current.setFromCamera(ndc, viewer.context.getCamera());
    (ray.current as any).firstHitOnly = false;
    const hits = ray.current.intersectObjects(viewer.context.items.pickableIfcModels, false);
    const planes = viewer.context.getClippingPlanes?.() ?? [];
    for (const h of hits) if (planes.every((p: any) => p.distanceToPoint(h.point) >= -1e-4)) return h;
    return null;
  };

  const readExpressId = (hit: any): number | null => {
    const attr = hit.object?.geometry?.attributes?.expressID;
    const face = hit.face;
    if (!attr || !face) return null;
    return attr.getX(face.a);
  };

  // Update fat-line outline materials' resolution to the current canvas size.
  const setSelResolution = () => {
    const host = hostRef.current;
    const sel = selGroupRef.current;
    if (!host || !sel) return;
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    sel.traverse((o: any) => o.material?.resolution?.set(w, h));
  };

  // --- selection (outline only) ------------------------------------------
  const selectIds = (ids: number[], expressID?: number) => {
    const viewer = viewerRef.current;
    const sel = selGroupRef.current;
    if (!viewer || !sel) return;
    clearOutline(sel);
    if (ids.length) {
      const manager = viewer.IFC.loader.ifcManager;
      const scene = viewer.context.getScene();
      const sub = manager.createSubset({ modelID: stateRef.current.modelID, ids, applyBVH: false, scene, removePrevious: true, customID: "__seloutline" });
      if (sub) {
        sub.updateMatrixWorld(true);
        const edges = new EdgesGeometry(sub.geometry, 30);
        edges.applyMatrix4(sub.matrixWorld);
        const geom = new LineSegmentsGeometry().fromEdgesGeometry(edges);
        const mat = new LineMaterial({ color: SELECT_COLOR, linewidth: SELECT_WIDTH, depthTest: false });
        const line = new LineSegments2(geom, mat);
        line.renderOrder = 998;
        sel.add(line);
        sub.removeFromParent(); // keep only the outline, not the fill
        setSelResolution();
      }
    }
    selectedRef.current = new Set(ids);
    setSelectedIds(new Set(ids));
    const propId = expressID ?? (ids.length === 1 ? ids[0] : undefined);
    if (propId != null) showProperties(viewer, stateRef.current.modelID, propId);
    else setPropGroups(null);
  };

  const clearSelection = () => {
    if (selGroupRef.current) clearOutline(selGroupRef.current);
    selectedRef.current = new Set();
    setSelectedIds(new Set());
    setPropGroups(null);
  };

  async function showProperties(viewer: any, modelID: number, id: number) {
    try {
      // recursive=true expands each property set's properties/quantities.
      const p = await viewer.IFC.getProperties(modelID, id, true, true);
      const v = (x: any) => (x && x.value != null ? String(x.value) : "");
      const qval = (it: any) =>
        it.NominalValue ?? it.LengthValue ?? it.AreaValue ?? it.VolumeValue ?? it.CountValue ?? it.WeightValue ?? it.Value;

      const groups: PropGroup[] = [];
      // Attributes group.
      const attrs = [
        { k: "Tip IFC", v: typeof p.type === "string" ? p.type : "" },
        { k: "Nume", v: v(p.Name) },
        { k: "GlobalId", v: v(p.GlobalId) },
        { k: "Descriere", v: v(p.Description) },
      ].filter((r) => r.v.length);
      if (attrs.length) groups.push({ name: "Atribute", rows: attrs });

      // One group per property/quantity set.
      for (const set of p.psets ?? []) {
        const rows = (set.HasProperties ?? set.Quantities ?? [])
          .map((it: any) => ({ k: v(it.Name), v: v(qval(it)) }))
          .filter((r: PropGroup["rows"][number]) => r.k.length);
        if (rows.length) groups.push({ name: v(set.Name) || "PropertySet", rows });
      }

      setPropGroups(groups);
      setPropsKey((k) => k + 1);
    } catch {
      /* ignore */
    }
  }

  const startPropsResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) =>
      setPropsWidth(Math.min(640, Math.max(260, window.innerWidth - ev.clientX - 16)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // --- visibility (display subset) ---------------------------------------
  const setDisplay = (ids: Set<number>) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const manager = viewer.IFC.loader.ifcManager;
    const scene = viewer.context.getScene();
    const subset = manager.createSubset({ modelID: stateRef.current.modelID, ids: [...ids], applyBVH: true, scene, removePrevious: true, customID: "display" });
    viewer.context.items.ifcModels = [subset];
    viewer.context.items.pickableIfcModels = [subset];
    try {
      if ((viewer.context.getClippingPlanes?.() ?? []).length) viewer.clipper.updateMaterials();
    } catch {
      /* ignore */
    }
  };

  const applyVisible = (next: Set<number>) => {
    visibleRef.current = next;
    setVisibleIds(next);
    setDisplay(next);
    clearSelection();
  };
  const hideIds = (ids: number[]) => {
    const next = new Set(visibleRef.current);
    for (const id of ids) next.delete(id);
    applyVisible(next);
  };
  const showIds = (ids: number[]) => {
    const next = new Set(visibleRef.current);
    for (const id of ids) next.add(id);
    applyVisible(next);
  };
  const isolateIds = (ids: number[]) => applyVisible(new Set(ids));
  const showAll = () => applyVisible(new Set(stateRef.current.allIDs));

  // --- tools --------------------------------------------------------------
  const chooseMeasure = (mode: MeasureMode) => {
    const next = measureMode === mode ? "none" : mode;
    setMeasureMode(next);
    measureRef.current?.setMode(next);
    if (next !== "none" && section) {
      setSection(false);
      sectionRef.current = false;
    }
    setStatus(
      next === "length"
        ? "Lungime: click pe 2 puncte"
        : next === "point"
          ? "Punct: click pentru coordonate"
          : next === "area"
            ? "Arie: click pe vârfuri, dublu-click pentru a închide"
            : "Măsurare dezactivată",
    );
  };

  const toggleSection = () => {
    const v = viewerRef.current;
    if (!v) return;
    const on = !section;
    setSection(on);
    sectionRef.current = on;
    if (on) {
      v.clipper.active = true;
      if (measureMode !== "none") {
        setMeasureMode("none");
        measureRef.current?.setMode("none");
      }
    }
    setStatus(on ? "Secțiune: dublu-click pe model pentru un plan" : "Editare secțiune oprită (secțiunea rămâne activă)");
  };

  const modelBounds = () => {
    const v = viewerRef.current;
    const cc = v?.context?.ifcCamera?.cameraControls;
    const meshes = v?.context?.items?.pickableIfcModels as any[];
    if (!cc || !meshes?.length) return null;
    const box = new Box3();
    for (const m of meshes) box.expandByObject(m);
    if (box.isEmpty()) return null;
    return { cc, box, sphere: box.getBoundingSphere(new Sphere()), center: box.getCenter(new Vector3()) };
  };

  // Fit to the model keeping the current direction.
  const resetView = () => {
    try {
      const b = modelBounds();
      if (b) b.cc.fitToSphere(b.sphere, true);
    } catch {
      /* ignore */
    }
  };

  // Standard orthographic-style named views (Y-up scene).
  const VIEW_DIR: Record<string, [number, number, number]> = {
    axon: [1, 1, 1],
    top: [0, 1, 0.0001],
    bottom: [0, -1, 0.0001],
    front: [0, 0, 1],
    back: [0, 0, -1],
    right: [1, 0, 0],
    left: [-1, 0, 0],
  };
  const applyView = (name: keyof typeof VIEW_DIR) => {
    try {
      const b = modelBounds();
      if (!b) return;
      const dir = new Vector3(...VIEW_DIR[name]).normalize();
      const pos = b.center.clone().add(dir.multiplyScalar(b.sphere.radius * 3));
      b.cc.setLookAt(pos.x, pos.y, pos.z, b.center.x, b.center.y, b.center.z, false);
      b.cc.fitToSphere(b.sphere, true);
    } catch {
      /* ignore */
    }
  };

  const startTreeResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => setTreeWidth(Math.min(560, Math.max(200, ev.clientX - 12)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const selArr = () => [...selectedIds];

  return (
    <div className="viewer-wrap">
      <aside className="ifctree-panel" style={{ width: treeWidth }}>
        <div className="ifctree-head">Structură IFC</div>
        {displayTree ? (
          <IfcTree
            root={displayTree}
            visibleIds={visibleIds}
            selectedIds={selectedIds}
            onSelect={(ids, expressID) => selectIds(ids, expressID)}
            onToggleVisible={(ids, visible) => (visible ? showIds(ids) : hideIds(ids))}
          />
        ) : (
          <div className="ifctree-empty">Se încarcă structura…</div>
        )}
        <div className="tree-resize" onMouseDown={startTreeResize} title="Trageți pentru redimensionare" />
      </aside>

      <div className="viewer-main">
        <div className="vtoolbar">
          <Dropdown label="Măsurare" icon="📐" active={measureMode !== "none"}>
            <button className={"vmenu-item" + (measureMode === "length" ? " active" : "")} onClick={() => chooseMeasure("length")}>
              <span className="ic">📏</span> Lungime
            </button>
            <button className={"vmenu-item" + (measureMode === "point" ? " active" : "")} onClick={() => chooseMeasure("point")}>
              <span className="ic">📍</span> Punct
            </button>
            <button className={"vmenu-item" + (measureMode === "area" ? " active" : "")} onClick={() => chooseMeasure("area")}>
              <span className="ic">▱</span> Arie
            </button>
            <div className="vmenu-sep" />
            <button className="vmenu-item danger" onClick={() => measureRef.current?.clearAll()}>
              <span className="ic">🗑</span> Șterge măsurătorile
            </button>
          </Dropdown>

          <span className="vsep" />

          <Dropdown label="Secțiune" icon="✂️" active={section}>
            <button className={"vmenu-item" + (section ? " active" : "")} onClick={toggleSection}>
              <span className="ic">✂️</span> Plan de secțiune
            </button>
            <div className="vmenu-sep" />
            <button className="vmenu-item danger" onClick={() => viewerRef.current?.clipper.deleteAllPlanes()}>
              <span className="ic">🗑</span> Șterge secțiunile
            </button>
          </Dropdown>

          <span className="vsep" />

          <Dropdown label="Vizibilitate" icon="👁">
            <button className="vmenu-item" onClick={() => hideIds(selArr())}>
              <span className="ic">🙈</span> Ascunde selecția
            </button>
            <button className="vmenu-item" onClick={() => isolateIds(selArr())}>
              <span className="ic">🎯</span> Izolează selecția
            </button>
            <button className="vmenu-item" onClick={showAll}>
              <span className="ic">👁</span> Afișează tot
            </button>
          </Dropdown>

          <span className="vsep" />

          <Dropdown label="Vederi" icon="🎥">
            <button className="vmenu-item" onClick={() => applyView("axon")}>
              <span className="ic">🧊</span> Axonometric
            </button>
            <button className="vmenu-item" onClick={() => applyView("top")}>
              <span className="ic">⬇️</span> De sus
            </button>
            <button className="vmenu-item" onClick={() => applyView("front")}>
              <span className="ic">⬛</span> Față
            </button>
            <button className="vmenu-item" onClick={() => applyView("left")}>
              <span className="ic">◀️</span> Stânga
            </button>
            <button className="vmenu-item" onClick={() => applyView("back")}>
              <span className="ic">⬜</span> Spate
            </button>
            <button className="vmenu-item" onClick={() => applyView("right")}>
              <span className="ic">▶️</span> Dreapta
            </button>
            <button className="vmenu-item" onClick={() => applyView("bottom")}>
              <span className="ic">⬆️</span> De jos
            </button>
            <div className="vmenu-sep" />
            <button className="vmenu-item" onClick={resetView}>
              <span className="ic">⤢</span> Încadrează tot
            </button>
          </Dropdown>
        </div>

        <div className="viewer-host" ref={hostRef}>
          <div data-testid="viewer-status" className="viewer-status">
            {status}
          </div>
        </div>
      </div>

      {/* Always docked so selecting/deselecting doesn't resize the viewer (no bounce). */}
      <aside className="props-panel" style={{ width: propsWidth }}>
        <div className="props-resize" onMouseDown={startPropsResize} title="Trageți pentru redimensionare" />
        <div className="props-head">
          <span>Proprietăți element</span>
          {propGroups && (
            <span className="props-close" onClick={clearSelection} title="Deselectează">
              ×
            </span>
          )}
        </div>
        <div className="props-body">
          {propGroups ? (
            <PropAccordion key={propsKey} groups={propGroups} />
          ) : (
            <div className="props-empty">
              Selectați un element în viewer sau în arbore pentru a-i vedea proprietățile.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function clearOutline(group: Group) {
  for (const c of [...group.children]) {
    group.remove(c);
    const any = c as any;
    any.geometry?.dispose?.();
    any.material?.dispose?.();
  }
}

// Spatial containers form the structural backbone and are never grouped; every
// other (element) child of a container is grouped under its IFC class.
const SPATIAL_TYPES = new Set([
  "IFCPROJECT",
  "IFCSITE",
  "IFCBUILDING",
  "IFCBUILDINGSTOREY",
  "IFCSPACE",
]);

/**
 * Rewrite the spatial tree so that the element children of each container are
 * grouped into synthetic "class group" nodes (e.g. "Pile (120)"). Spatial
 * containers stay expanded by default; the class groups start collapsed so a
 * storey with hundreds of identical elements reads as a short class list.
 */
function groupByClass(node: TreeNode, ctr: { n: number }): TreeNode {
  const children = node.children.map((c) => groupByClass(c, ctr));
  const containers: TreeNode[] = [];
  const elements: TreeNode[] = [];
  for (const c of children) (SPATIAL_TYPES.has(c.type) ? containers : elements).push(c);

  const groups: TreeNode[] = [];
  if (elements.length) {
    const byType = new Map<string, TreeNode[]>();
    for (const e of elements) {
      const arr = byType.get(e.type);
      if (arr) arr.push(e);
      else byType.set(e.type, [e]);
    }
    for (const [type, items] of byType) {
      const ids: number[] = [];
      for (const it of items) ids.push(...it.ids);
      groups.push({ expressID: --ctr.n, type, name: "", ids, children: items, count: items.length, defaultOpen: false });
    }
    groups.sort((a, b) => a.type.localeCompare(b.type));
  }

  return { ...node, children: [...containers, ...groups], defaultOpen: true };
}

function toTreeNode(node: any, allSet: Set<number>): TreeNode {
  const children = (node.children ?? []).map((c: any) => toTreeNode(c, allSet));
  const ids: number[] = [];
  if (allSet.has(node.expressID)) ids.push(node.expressID);
  for (const c of children) ids.push(...c.ids);
  return {
    expressID: node.expressID,
    type: node.type,
    name: node.Name?.value ?? node.LongName?.value ?? "",
    ids,
    children,
  };
}

function installDisplaySubset(viewer: any, model: any, allIDs: number[]) {
  const subset = viewer.IFC.loader.ifcManager.createSubset({
    modelID: model.modelID,
    ids: allIDs,
    applyBVH: true,
    scene: model.parent,
    removePrevious: true,
    customID: "display",
  });
  const items = viewer.context.items;
  items.pickableIfcModels = items.pickableIfcModels.filter((m: any) => m !== model);
  items.ifcModels = items.ifcModels.filter((m: any) => m !== model);
  model.removeFromParent();
  items.ifcModels.push(subset);
  items.pickableIfcModels.push(subset);
}
