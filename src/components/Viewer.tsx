import { type ReactNode, type CSSProperties, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import type { IfcDataStore } from "@ifc-lite/parser";
import type { Theme } from "../hooks/useTheme";
import type { GeorefInfo } from "../ifc/editor";
import { detectSchema } from "../ifc/store";
import { ViewerEngine } from "../viewer/engine";
import { buildTree, buildClassTree, buildMaterialTree, getSelectionProps, gatherFileInfo } from "../viewer/model";
import { MeasureTool, type MeasureMode } from "../viewer/measure";
import { IfcTree, type TreeNode } from "./IfcTree";
import { PropAccordion, FileInfoPanel, type PropGroup, type FileInfo } from "./PropsPanel";
import { BcfPanel } from "./BcfPanel";
import { IdsPanel } from "./IdsPanel";
import { DataTablePanel } from "./DataTablePanel";
import type { PivotConfig } from "../viewer/pivot";
import type { IDSValidationReport } from "../ifc/ids";
import { createBCFFromIDSReport, addTopicToProject, type BCFProject } from "../ifc/bcf";

// Non-conforming IDS elements are painted this red in the 3D view.
const IDS_FAIL_COLOR: [number, number, number, number] = [0.85, 0.13, 0.13, 1];

interface Props {
  bytes: Uint8Array;
  fileName: string;
  theme: Theme;
  georef: GeorefInfo | null;
  favorites: Set<string>;
  onToggleFavorite: (key: string) => void;
  /** Shared BCF project (lifted to App so it survives tab switches / new imports). */
  bcfProject?: BCFProject | null;
  onBcfProject?: (p: BCFProject) => void;
  /** IDS validation report (docked IDS panel lives inside the 3D viewer). */
  idsReport?: IDSValidationReport | null;
  onIdsReport?: (r: IDSValidationReport | null) => void;
}

const VIEWER_BG: Record<Theme, [number, number, number, number]> = {
  light: [0.933, 0.941, 0.957, 1],
  dark: [0.082, 0.086, 0.102, 1],
};
const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator && !!(navigator as any).gpu;

const sectionCtlStyle: CSSProperties = {
  position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 6,
  display: "flex", alignItems: "center", gap: 14, padding: "8px 14px",
  background: "rgba(20,20,24,0.86)", color: "#fff", borderRadius: 8,
  boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
};

/** Grouped toolbar dropdown (closes on click-outside / Escape). */
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
      {open && <div className="vmenu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

export function Viewer({ bytes, fileName, theme, georef, favorites, onToggleFavorite, bcfProject, onBcfProject, idsReport, onIdsReport }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ViewerEngine | null>(null);
  const measureRef = useRef<MeasureTool | null>(null);
  const storeRef = useRef<IfcDataStore | null>(null);
  const georefRef = useRef<GeorefInfo | null>(georef);

  const allIDsRef = useRef<number[]>([]);
  const hiddenRef = useRef<Set<number>>(new Set());
  const isolatedRef = useRef<Set<number> | null>(null);
  const selectedRef = useRef<Set<number>>(new Set());
  const lastHiddenRef = useRef<number[]>([]);
  const sectionRef = useRef(false);

  // Status is tracked (drives nothing visible now — the overlay was removed) but
  // kept so the existing setStatus call sites stay valid.
  const [, setStatus] = useState("Se inițializează vizualizatorul…");
  const [measureMode, setMeasureMode] = useState<MeasureMode>("none");
  const [snapOpts, setSnapOpts] = useState({ vertex: true, midpoint: true, edge: true, face: true });
  const toggleSnap = (k: "vertex" | "midpoint" | "edge" | "face") =>
    setSnapOpts((s) => {
      const next = { ...s, [k]: !s[k] };
      if (engineRef.current) engineRef.current.snapOptions = next;
      return next;
    });
  const [section, setSection] = useState(false);
  const [secPos, setSecPos] = useState(50);
  const [secFlip, setSecFlip] = useState(false);
  const [propGroups, setPropGroups] = useState<PropGroup[] | null>(null);
  const [propsKey, setPropsKey] = useState(0);
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [selHeader, setSelHeader] = useState<{ name: string; type: string } | null>(null);
  const [propsWidth, setPropsWidth] = useState(340);
  const [treeWidth, setTreeWidth] = useState(300);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [classRoots, setClassRoots] = useState<TreeNode[] | null>(null);
  const [materialRoots, setMaterialRoots] = useState<TreeNode[] | null>(null);
  // Active left-panel view: spatial hierarchy, grouped by IFC class, or by material.
  const [treeView, setTreeView] = useState<"spatial" | "class" | "material">("spatial");
  const [visibleIds, setVisibleIds] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [ready, setReady] = useState(false);
  // The right dock hosts EITHER the IDS panel or the BCF panel (toolbar toggles).
  const [dock, setDock] = useState<"none" | "ids" | "bcf">("none");
  // Bottom data-table (pivot). Independent of the right dock so they can coexist;
  // the config persists while the panel is toggled off/on.
  const [tableOpen, setTableOpen] = useState(false);
  const [pivotConfig, setPivotConfig] = useState<PivotConfig>({
    groupBy: ["class"],
    values: [], // start with just the built-in "Număr" column; add value columns via ⚙
    showTotals: true,
  });

  // Spatial view keeps the per-container class subgrouping; Class/Material views
  // are flat groupings built once at load. Only the active tree is rendered.
  const spatialTree = useMemo(() => (tree ? groupByClass(tree, { n: 0 }) : tree), [tree]);
  // Active forest: Spatial wraps the single project node in an array; Class/Material
  // are already forests of group nodes (no project wrapper).
  const activeRoots =
    treeView === "class" ? classRoots
      : treeView === "material" ? materialRoots
        : spatialTree ? [spatialTree] : null;

  useEffect(() => {
    if (!hasWebGPU) return;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas || engineRef.current) return;
    let disposed = false;

    const engine = new ViewerEngine(canvas);
    engineRef.current = engine;
    (window as any).__engine = engine;
    engine.setState({ clearColor: VIEWER_BG[theme] });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => engineRef.current?.resize(), 100);
    });
    ro.observe(host);

    (async () => {
      try {
        await engine.init();
        engine.resize();
        if (disposed) return;
        setStatus("Se încarcă modelul IFC…");
        const { store, allIDs } = await engine.load(bytes);
        if (disposed) return;
        storeRef.current = store;
        allIDsRef.current = allIDs;
        setVisibleIds(new Set(allIDs));

        measureRef.current = new MeasureTool(engine, host);
        measureRef.current.setGeoref(georefRef.current);
        engine.onSectionMove = (pos) => setSecPos(pos); // keep the slider in sync with the drag handle
        wireEvents(host);

        const idset = new Set(allIDs);
        setTree(buildTree(store, idset));
        setClassRoots(buildClassTree(store, idset));
        setMaterialRoots(buildMaterialTree(store, idset));
        // Model centroid in IFC absolute coords (handles real-coordinate models
        // whose IfcMapConversion has a zero Eastings/Northings offset).
        const mb = engine.modelBounds();
        const centroid = mb
          ? engine.worldToIfc({ x: (mb.min[0] + mb.max[0]) / 2, y: (mb.min[1] + mb.max[1]) / 2, z: (mb.min[2] + mb.max[2]) / 2 })
          : { x: engine.rtcOffset.x, y: engine.rtcOffset.y, z: engine.rtcOffset.z };
        setFileInfo(
          gatherFileInfo(store, allIDs.length, bytes.length, fileName, detectSchema(bytes), georefRef.current, centroid),
        );
        setStatus("Model încărcat • orbit: stânga • pan: dreapta/mijloc • zoom: scroll • Esc: anulează");
        setReady(true);
      } catch (e: any) {
        if (!disposed) setStatus("Eroare la încărcarea modelului: " + (e?.message ?? e));
      }
    })();

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      ro.disconnect();
      measureRef.current?.dispose();
      engine.dispose();
      measureRef.current = null;
      engineRef.current = null;
      delete (window as any).__engine;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setState({ clearColor: VIEWER_BG[theme] });
  }, [theme]);

  useEffect(() => {
    georefRef.current = georef;
    measureRef.current?.setGeoref(georef);
  }, [georef]);

  // Turning the section tool OFF removes the plane. Turning it ON only ARMS the
  // tool — the plane is created when the user double-clicks a face.
  useEffect(() => {
    if (!section) engineRef.current?.clearSection();
  }, [section]);

  // Keyboard: Esc cancels; H hide/restore selection; Z zoom extents; F frame selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        chooseMeasure("none");
        if (sectionRef.current) toggleSection();
        setStatus("Comandă anulată (Esc).");
      } else if (e.key === "h" || e.key === "H") {
        toggleHideSelection();
      } else if (e.key === "z" || e.key === "Z") {
        engineRef.current?.fit();
      } else if (e.key === "f" || e.key === "F") {
        if (selectedRef.current.size) engineRef.current?.zoomToSelection(selectedRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Paint non-conforming IDS elements red in the 3D view (and clear when the
  // report is dropped). Driven by the same report the docked IDS panel shows.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !ready) return;
    if (!idsReport) {
      eng.clearColorOverrides();
      return;
    }
    const failing = new Set<number>();
    for (const spec of idsReport.specificationResults)
      for (const e of spec.entityResults) if (!e.passed) failing.add(e.expressId);
    eng.setColorOverrides(failing, IDS_FAIL_COLOR);
  }, [idsReport, ready]);

  // IDS → BCF: one topic per failing entity, merged into the shared project,
  // then flip the dock to BCF so the new topics are visible.
  const exportIdsToBcf = (report: IDSValidationReport) => {
    const generated = createBCFFromIDSReport(
      {
        title: report.document.info.title || "IDS",
        description: report.document.info.description,
        specificationResults: report.specificationResults,
      },
      { projectName: report.document.info.title || fileName, version: "2.1" },
    );
    if (bcfProject) {
      for (const t of generated.topics.values()) addTopicToProject(bcfProject, t);
      onBcfProject?.({ ...bcfProject });
    } else {
      onBcfProject?.(generated);
    }
    setDock("bcf");
  };

  function wireEvents(host: HTMLElement) {
    host.onclick = async (ev: MouseEvent) => {
      const measure = measureRef.current;
      if (measure && measure.mode !== "none") return measure.onClick(ev);
      if (sectionRef.current) return;
      const engine = engineRef.current;
      if (!engine) return;
      const hit = await engine.pick(ev.clientX, ev.clientY);
      if (hit && hit.expressId != null) selectIds([hit.expressId], hit.expressId);
      else clearSelection();
    };
    host.ondblclick = (ev: MouseEvent) => {
      const measure = measureRef.current;
      if (measure && measure.mode === "area") return measure.onDblClick();
      if (measure && measure.mode !== "none") return;
      // Only when the section tool is armed: double-click a face → create the cut there.
      if (sectionRef.current) sectionFromFace(ev);
    };
    host.onmousemove = (ev: MouseEvent) => {
      const measure = measureRef.current;
      if (measure && measure.mode !== "none") measure.onMove(ev);
    };
  }

  // --- selection ----------------------------------------------------------
  const selectIds = (ids: number[], expressID?: number) => {
    if (ids.length) lastHiddenRef.current = [];
    selectedRef.current = new Set(ids);
    setSelectedIds(new Set(ids));
    engineRef.current?.setSelectionOutline(ids);
    const propId = expressID ?? (ids.length === 1 ? ids[0] : undefined);
    const store = storeRef.current;
    if (propId != null && store) {
      const { header, groups } = getSelectionProps(store, propId);
      setSelHeader(header);
      setPropGroups(groups);
      setPropsKey((k) => k + 1);
    } else {
      setPropGroups(null);
      setSelHeader(null);
    }
  };

  const clearSelection = () => {
    selectedRef.current = new Set();
    setSelectedIds(new Set());
    engineRef.current?.setSelectionOutline([]);
    setPropGroups(null);
    setSelHeader(null);
  };

  // --- visibility ---------------------------------------------------------
  const applyVisibility = () => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.setState({ hiddenIds: new Set(hiddenRef.current), isolatedIds: isolatedRef.current ? new Set(isolatedRef.current) : null });
    const all = allIDsRef.current;
    const iso = isolatedRef.current;
    const next = new Set<number>(iso ? [...iso] : all);
    for (const id of hiddenRef.current) next.delete(id);
    setVisibleIds(next);
  };
  const hideIds = (ids: number[]) => {
    for (const id of ids) hiddenRef.current.add(id);
    applyVisibility();
    clearSelection();
  };
  const showIds = (ids: number[]) => {
    for (const id of ids) hiddenRef.current.delete(id);
    applyVisibility();
  };
  const isolateIds = (ids: number[]) => {
    isolatedRef.current = new Set(ids);
    hiddenRef.current.clear();
    applyVisibility();
    clearSelection();
  };
  const showAll = () => {
    isolatedRef.current = null;
    hiddenRef.current.clear();
    applyVisibility();
  };
  const hideSelection = () => {
    const ids = [...selectedRef.current];
    if (!ids.length) return;
    lastHiddenRef.current = ids;
    hideIds(ids);
  };
  const toggleHideSelection = () => {
    if (selectedRef.current.size) {
      hideSelection();
      setStatus("Element(e) ascuns(e) (H). Apăsați H din nou pentru a le reafișa.");
    } else if (lastHiddenRef.current.length) {
      showIds(lastHiddenRef.current);
      lastHiddenRef.current = [];
      setStatus("Element(e) reafișat(e) (H).");
    }
  };

  // --- tools --------------------------------------------------------------
  const chooseMeasure = (mode: MeasureMode) => {
    const next = measureMode === mode ? "none" : mode;
    setMeasureMode(next);
    measureRef.current?.setMode(next);
    // Measurement and an active section coexist — do NOT reset the section here.
    setStatus(
      next === "length" ? "Lungime: click pe 2 puncte"
        : next === "point" ? "Punct: click pentru coordonate"
          : next === "area" ? "Arie: click pe vârfuri, dublu-click pentru a închide"
            : "Măsurare dezactivată",
    );
  };

  const toggleSection = () => {
    const on = !sectionRef.current;
    sectionRef.current = on;
    setSection(on);
    setStatus(on ? "Secțiune: dublu-click pe o față pentru a crea planul" : "Secțiune dezactivată");
  };

  // Double-click a face → section plane aligned to that face (normal = face
  // normal), through the hit point. Visible + movable afterwards via the slider.
  const sectionFromFace = (ev: MouseEvent) => {
    const eng = engineRef.current;
    if (!eng) return;
    const r = eng.raycast(ev.clientX, ev.clientY);
    if (!r) return;
    const n = r.intersection.normal;
    const p = r.intersection.point;
    const pos = eng.orientSection([n.x, n.y, n.z], [p.x, p.y, p.z]);
    sectionRef.current = true;
    setSection(true);
    setSecPos(pos);
    setSecFlip(false);
    setStatus("Secțiune creată din față • mută cu slider-ul • „Inversează” pentru cealaltă parte");
  };

  const clearSections = () => {
    sectionRef.current = false;
    setSection(false);
  };

  const startPropsResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    // Width is measured from the panel's right edge (which stays fixed as the
    // panel grows leftward), NOT the window edge — otherwise an open IDS/BCF
    // dock sitting to the right throws the math off by its width.
    const right = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect().right;
    const onMove = (ev: MouseEvent) => setPropsWidth(Math.min(640, Math.max(260, right - ev.clientX)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
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

  if (!hasWebGPU) {
    return (
      <div className="viewer-wrap">
        <div className="viewer-main">
          <div className="alert error" style={{ margin: 24 }}>
            ⚠️ Vizualizatorul 3D necesită <b>WebGPU</b>, care nu este disponibil în acest browser.
            Folosiți Chrome/Edge recent (sau Safari 18+). Editarea datelor și exportul funcționează în continuare.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer-wrap">
      <aside className="ifctree-panel" style={{ width: treeWidth }}>
        <div className="tree-tabs">
          <button className={"tree-tab" + (treeView === "spatial" ? " active" : "")} onClick={() => setTreeView("spatial")}>Spațial</button>
          <button className={"tree-tab" + (treeView === "class" ? " active" : "")} onClick={() => setTreeView("class")}>Clase</button>
          <button className={"tree-tab" + (treeView === "material" ? " active" : "")} onClick={() => setTreeView("material")}>Materiale</button>
        </div>
        {activeRoots ? (
          <IfcTree
            key={treeView}
            roots={activeRoots}
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
            <button className={"vmenu-item" + (measureMode === "length" ? " active" : "")} onClick={() => chooseMeasure("length")}><span className="ic">📏</span> Lungime</button>
            <button className={"vmenu-item" + (measureMode === "point" ? " active" : "")} onClick={() => chooseMeasure("point")}><span className="ic">📍</span> Punct</button>
            <button className={"vmenu-item" + (measureMode === "area" ? " active" : "")} onClick={() => chooseMeasure("area")}><span className="ic">▱</span> Arie</button>
            <div className="vmenu-sep" />
            <div onClick={(e) => e.stopPropagation()} style={{ padding: "4px 12px", fontSize: 12 }}>
              <div style={{ opacity: 0.7, margin: "2px 0 4px" }}>Snap la:</div>
              {([["vertex", "Vârf"], ["midpoint", "Mijloc"], ["edge", "Muchie"], ["face", "Față"]] as const).map(([k, lbl]) => (
                <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", cursor: "pointer" }}>
                  <input type="checkbox" checked={snapOpts[k]} onChange={() => toggleSnap(k)} /> {lbl}
                </label>
              ))}
            </div>
            <div className="vmenu-sep" />
            <button className="vmenu-item danger" onClick={() => measureRef.current?.clearAll()}><span className="ic">🗑</span> Șterge măsurătorile</button>
          </Dropdown>

          <span className="vsep" />

          <Dropdown label="Secțiune" icon="✂️" active={section}>
            <button className={"vmenu-item" + (section ? " active" : "")} onClick={toggleSection}><span className="ic">✂️</span> Plan de secțiune</button>
            <div className="vmenu-sep" />
            <button className="vmenu-item danger" onClick={clearSections}><span className="ic">🗑</span> Șterge secțiunile</button>
          </Dropdown>

          <span className="vsep" />

          <Dropdown label="Vizibilitate" icon="👁">
            <button className="vmenu-item" onClick={() => hideIds(selArr())}><span className="ic">🙈</span> Ascunde selecția</button>
            <button className="vmenu-item" onClick={() => isolateIds(selArr())}><span className="ic">🎯</span> Izolează selecția</button>
            <button className="vmenu-item" onClick={showAll}><span className="ic">👁</span> Afișează tot</button>
          </Dropdown>

          <span className="vsep" />

          <Dropdown label="Vederi" icon="🎥">
            <button className="vmenu-item" onClick={() => engineRef.current?.fit()}><span className="ic">🧊</span> Axonometric</button>
            <button className="vmenu-item" onClick={() => engineRef.current?.setPresetView("top")}><span className="ic">⬇️</span> De sus</button>
            <button className="vmenu-item" onClick={() => engineRef.current?.setPresetView("front")}><span className="ic">⬛</span> Față</button>
            <button className="vmenu-item" onClick={() => engineRef.current?.setPresetView("left")}><span className="ic">◀️</span> Stânga</button>
            <button className="vmenu-item" onClick={() => engineRef.current?.setPresetView("back")}><span className="ic">⬜</span> Spate</button>
            <button className="vmenu-item" onClick={() => engineRef.current?.setPresetView("right")}><span className="ic">▶️</span> Dreapta</button>
            <button className="vmenu-item" onClick={() => engineRef.current?.setPresetView("bottom")}><span className="ic">⬆️</span> De jos</button>
            <div className="vmenu-sep" />
            <button className="vmenu-item" onClick={() => engineRef.current?.fit()}><span className="ic">⤢</span> Încadrează tot</button>
          </Dropdown>

          <span className="vsep" />

          <button className={"vbtn" + (dock === "ids" ? " active" : "")} onClick={() => setDock((d) => (d === "ids" ? "none" : "ids"))}>
            <span className="ic">📋</span>
            <span>IDS</span>
          </button>

          <button className={"vbtn" + (dock === "bcf" ? " active" : "")} onClick={() => setDock((d) => (d === "bcf" ? "none" : "bcf"))}>
            <span className="ic">💬</span>
            <span>BCF</span>
          </button>

          <button className={"vbtn" + (tableOpen ? " active" : "")} onClick={() => setTableOpen((o) => !o)}>
            <span className="ic">📊</span>
            <span>Tabel</span>
          </button>
        </div>

        <div className="viewer-host" ref={hostRef} style={{ position: "relative" }}>
          <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
          {section && (
            <div className="section-ctl" style={sectionCtlStyle}>
              <span style={{ fontSize: 12, opacity: 0.85 }}>Dublu-click pe o față pentru a crea secțiunea</span>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12 }}>Poziție</span>
                <input
                  type="range" min={0} max={100} value={secPos}
                  onChange={(e) => { const v = Number(e.target.value); setSecPos(v); engineRef.current?.sectionSetPos(v); }}
                  style={{ width: 160 }}
                />
                <span style={{ fontSize: 12, width: 32 }}>{secPos}%</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox" checked={secFlip}
                  onChange={(e) => { setSecFlip(e.target.checked); engineRef.current?.sectionSetFlipped(e.target.checked); }}
                /> Inversează
              </label>
            </div>
          )}
        </div>

        {tableOpen && ready && storeRef.current && (
          <DataTablePanel
            store={storeRef.current}
            allIDs={allIDsRef.current}
            fileName={fileName}
            config={pivotConfig}
            onConfigChange={setPivotConfig}
            onSelectRows={(ids) => selectIds(ids)}
            onClose={() => setTableOpen(false)}
          />
        )}
      </div>

      <aside className="props-panel" style={{ width: propsWidth }}>
        <div className="props-resize" onMouseDown={startPropsResize} title="Trageți pentru redimensionare" />
        <div className="props-head">
          <span>{propGroups ? "Proprietăți element" : "Informații model"}</span>
          {propGroups && <span className="props-close" onClick={clearSelection} title="Deselectează">×</span>}
        </div>
        <div className="props-body">
          {propGroups ? (
            <>
              {selHeader && (
                <div className="sel-header">
                  <div className="sel-title">
                    <div className="sel-name" title={selHeader.name}>{selHeader.name || "(fără nume)"}</div>
                    {selHeader.type && <div className="sel-type">{selHeader.type}</div>}
                  </div>
                  <div className="sel-actions">
                    <button className="sel-btn" title="Încadrează pe element" onClick={() => engineRef.current?.zoomToSelection(selectedRef.current)}>
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                      </svg>
                    </button>
                    <button className="sel-btn" title="Ascunde elementul" onClick={hideSelection}>
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.6" /><path d="M3 3l18 18" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
              <PropAccordion key={propsKey} groups={propGroups} favorites={favorites} onToggleFavorite={onToggleFavorite} />
            </>
          ) : fileInfo ? (
            <FileInfoPanel info={fileInfo} />
          ) : (
            <div className="props-empty">Selectați un element în viewer sau în arbore pentru a-i vedea proprietățile.</div>
          )}
        </div>
      </aside>

      {dock === "ids" && onIdsReport && (
        <IdsPanel
          bytes={bytes}
          fileName={fileName}
          report={idsReport ?? null}
          onReport={onIdsReport}
          onSelectEntity={(id) => {
            selectIds([id], id);
            engineRef.current?.zoomToSelection(new Set([id]));
          }}
          onExportBcf={exportIdsToBcf}
          onClose={() => setDock("none")}
        />
      )}

      {dock === "bcf" && (
        <BcfPanel
          engine={engineRef.current}
          store={storeRef.current}
          fileName={fileName}
          selectedIds={[...selectedIds]}
          onApplySelection={(ids) => selectIds(ids, ids.length === 1 ? ids[0] : undefined)}
          bcfProject={bcfProject ?? null}
          onBcfProject={(p) => onBcfProject?.(p)}
          onClose={() => setDock("none")}
        />
      )}
    </div>
  );
}

// Spatial containers are never grouped; element children are grouped by IFC class.
const SPATIAL_TYPES = new Set(["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCSPACE"]);

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
