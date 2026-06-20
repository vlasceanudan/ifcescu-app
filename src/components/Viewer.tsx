import { type ReactNode, type CSSProperties, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import type { IfcDataStore } from "@ifc-lite/parser";
import type { Theme } from "../hooks/useTheme";
import type { GeorefInfo } from "../ifc/editor";
import { detectSchema, type IfcSchema } from "../ifc/store";
import { IfcEditor, type SelectionDetail } from "../ifc/editor";
import { EditPanel } from "./EditPanel";
import { ViewerEngine } from "../viewer/engine";
import { buildTree, buildClassTree, buildMaterialTree, getSelectionProps, gatherFileInfo, offsetTree, modelRootNode } from "../viewer/model";
import { MeasureTool, type MeasureMode } from "../viewer/measure";
import { AlignTool, type AlignSlot } from "../viewer/alignTool";
import { ParcelLayer, type ParcelInfo } from "../viewer/parcelLayer";
import { modelToStereo70, inRomania } from "../geo/placement";
import type { Parcel } from "../geo/ancpi";
import { IfcTree, defaultNodeOpen, type TreeNode } from "./IfcTree";
import { PropAccordion, FileInfoPanel, type PropGroup, type FileInfo } from "./PropsPanel";
import { useI18n } from "../i18n/react";
import { useSettings } from "../settings/react";
import { t, type I18nKey } from "../i18n";
import { BcfPanel } from "./BcfPanel";
import { IdsPanel } from "./IdsPanel";
import { DataTablePanel } from "./DataTablePanel";
import { ModelsPanel } from "./ModelsPanel";
import { GeorefPanel } from "./GeorefPanel";
import { NavCube } from "./NavCube";
import { ViewBar } from "./ViewBar";
import type { PivotConfig, PivotModel, Rgba } from "../viewer/pivot";
import type { IDSValidationReport } from "../ifc/ids";
import { createBCFFromIDSReport, addTopicToProject, type BCFProject } from "../ifc/bcf";

// Non-conforming IDS elements are painted this red in the 3D view.
const IDS_FAIL_COLOR: [number, number, number, number] = [0.85, 0.13, 0.13, 1];

interface Props {
  /** The primary model's editor (owned by App so edits survive tab switches). */
  editor: IfcEditor;
  /** Report the primary IFC's change count up to App (drives the download button). */
  onChangeCount: (n: number) => void;
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
  /** Federated models (primary first). The 3D viewer aggregates all of them;
   *  Editare/Glob/IDS/BCF stay on the primary (`bytes`/`fileName`/`georef`). */
  models: ViewerModelInput[];
  onAddModel: (file: File) => void;
  onRemoveModel: (id: string) => void;
  /** Push a georef computed by the cadastral alignment tool up to App (live placement). */
  onGeorefChange?: (g: GeorefInfo) => void;
  /** ANCPI parcels (lifted to App so the globe tab can draw them too). */
  parcels: Parcel[];
  onParcelsChange: (parcels: Parcel[]) => void;
}

interface IfcPoint {
  x: number;
  y: number;
  z: number;
}

export interface ViewerModelInput {
  id: string;
  bytes: Uint8Array;
  fileName: string;
  georef: GeorefInfo | null;
  primary: boolean;
}

const VIEWER_BG: Record<Theme, [number, number, number, number]> = {
  light: [0.933, 0.941, 0.957, 1],
  dark: [0.039, 0.055, 0.102, 1], // deep navy, matches the dark UI (#0a0e1a)
};
const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator && !!(navigator as any).gpu;

/** "#rrggbb" → renderer clearColor [r,g,b,a] in 0..1. */
function hexToRgba(hex: string): [number, number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.93, 0.94, 0.96, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

const sectionCtlStyle: CSSProperties = {
  position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 6,
  display: "flex", alignItems: "center", gap: 14, padding: "8px 14px",
  background: "rgba(20,20,24,0.86)", color: "#fff", borderRadius: 8,
  boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
};

/** Grouped toolbar dropdown (closes on click-outside / Escape). */
function Dropdown({ label, icon, active, children }: { label: string; icon: ReactNode; active?: boolean; children: ReactNode }) {
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

/** Small inline icons for the preset-view menu (arrows + an iso cube). */
function ViewIcon({ kind }: { kind: "iso" | "up" | "down" | "left" | "right" | "front" | "back" }) {
  const a = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (kind) {
    case "up": return <svg {...a}><path d="M12 19V5M6 11l6-6 6 6" /></svg>;
    case "down": return <svg {...a}><path d="M12 5v14M6 13l6 6 6-6" /></svg>;
    case "left": return <svg {...a}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>;
    case "right": return <svg {...a}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
    case "front": return <svg {...a}><rect x="5" y="5" width="14" height="14" rx="1.5" fill="currentColor" stroke="none" /></svg>;
    case "back": return <svg {...a}><rect x="5" y="5" width="14" height="14" rx="1.5" /></svg>;
    case "iso": return <svg {...a}><path d="M12 2l8 4.6v9.2L12 22l-8-4.6V6.6z" /><path d="M12 11.3l8-4.6M12 11.3v10.4M12 11.3L4 6.7" /></svg>;
  }
}

/** Line icons for the toolbar (replace the colored emoji to match the app style). */
function ToolIcon({ kind }: { kind: "section" | "ids" | "bcf" | "table" | "point" | "views" | "measure" | "distance" | "cadastre" }) {
  const a = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (kind) {
    case "measure": return <svg {...a}><path d="M15.3 2.3 2.3 15.3l6.4 6.4L21.7 8.7z" /><path d="M7 7l1.6 1.6M10 4l1.6 1.6M4 10l1.6 1.6M13 13l1.6 1.6" /></svg>;
    case "distance": return <svg {...a}><path d="M3 12h18" /><path d="M6 8l-3 4 3 4M18 8l3 4-3 4" /></svg>;
    case "cadastre": return <svg {...a}><path d="M9 4 3 7v13l6-3 6 3 6-3V4l-6 3z" /><path d="M9 4v13M15 7v13" /></svg>;
    case "views": return <svg {...a}><path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" /></svg>;
    case "section": return <svg {...a}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12" /></svg>;
    case "ids": return <svg {...a}><path d="M9 3h6v3H9zM7 4.5H5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V5.5a1 1 0 0 0-1-1h-2" /><path d="M8.5 13.5l2.2 2.2 4.3-4.6" /></svg>;
    case "bcf": return <svg {...a}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
    case "table": return <svg {...a}><rect x="3" y="4" width="18" height="16" rx="1.5" /><path d="M3 9.5h18M3 15h18M9 4v16" /></svg>;
    case "point": return <svg {...a}><path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="2.6" /></svg>;
  }
}

/** Line icons for the "Vizibilitate" menu (match the rest of the app's SVG style). */
function VisIcon({ kind }: { kind: "hide" | "isolate" | "frame" | "show" }) {
  const a = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (kind) {
    case "hide": return <svg {...a}><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.6" /><path d="M3 3l18 18" /></svg>;
    case "isolate": return <svg {...a}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" /></svg>;
    case "frame": return <svg {...a}><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>;
    case "show": return <svg {...a}><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.6" /></svg>;
  }
}

export function Viewer({ editor, onChangeCount, bytes, fileName, theme, georef, favorites, onToggleFavorite, bcfProject, onBcfProject, idsReport, onIdsReport, models, onAddModel, onRemoveModel, onGeorefChange, parcels, onParcelsChange }: Props) {
  const { t, lang } = useI18n();
  const { settings } = useSettings();
  const cadastreEnabled = settings.experimental.cadastre;
  const hostRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ViewerEngine | null>(null);
  const measureRef = useRef<MeasureTool | null>(null);
  const alignToolRef = useRef<AlignTool | null>(null);
  const parcelLayerRef = useRef<ParcelLayer | null>(null);
  const storeRef = useRef<IfcDataStore | null>(null);
  const georefRef = useRef<GeorefInfo | null>(georef);
  // Primary model centroid in raw IFC coords — the basis for auto-centring the
  // cadastral search on the model (mapped to Stereo 70 via the current georef).
  const modelCentroidRef = useRef<IfcPoint | null>(null);

  const allIDsRef = useRef<number[]>([]);
  const hiddenRef = useRef<Set<number>>(new Set());
  const isolatedRef = useRef<Set<number> | null>(null);
  const selectedRef = useRef<Set<number>>(new Set());
  const lastHiddenRef = useRef<number[]>([]);
  const sectionRef = useRef(false);

  // Federation: per-model store registry (keyed by model id) + which models are
  // loaded in the engine + per-model visibility (hidden global ids and ids set).
  const modelStoresRef = useRef<Map<string, { store: IfcDataStore; offset: number; localIDs: number[]; globalIDs: number[]; fileName: string; schema: IfcSchema }>>(new Map());
  const loadedModelIdsRef = useRef<Set<string>>(new Set());
  const hiddenModelsRef = useRef<Set<string>>(new Set());
  const modelHiddenRef = useRef<Set<number>>(new Set());
  // The owning model + local id of the (single) current selection, for editing.
  const editTargetRef = useRef<{ modelId: string; localId: number } | null>(null);

  // Status is tracked (drives nothing visible now — the overlay was removed) but
  // kept so the existing setStatus call sites stay valid.
  const [, setStatus] = useState("Se inițializează vizualizatorul…");
  const [measureMode, setMeasureMode] = useState<MeasureMode>("none");
  const [snapOpts, setSnapOpts] = useState({ ...settings.viewer.snap });
  const toggleSnap = (k: "vertex" | "midpoint" | "edge" | "face") =>
    setSnapOpts((s) => {
      const next = { ...s, [k]: !s[k] };
      if (engineRef.current) engineRef.current.snapOptions = next;
      return next;
    });
  const [section, setSection] = useState(false);
  const [secPos, setSecPos] = useState(50);
  const [secFlip, setSecFlip] = useState(false);
  const [secSize, setSecSize] = useState(18); // section indicator size (% of half-diagonal)
  const [propGroups, setPropGroups] = useState<PropGroup[] | null>(null);
  const [propsKey, setPropsKey] = useState(0);
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [selHeader, setSelHeader] = useState<{ name: string; type: string } | null>(null);
  // In-3D editing: edit mode on/off + the structured snapshot the EditPanel renders.
  const [editing, setEditing] = useState(false);
  // Holds the latest edit-toggle logic so the empty-deps keydown handler always
  // sees current state/closures (mirrors the toolbar Edit button's behavior).
  const toggleEditRef = useRef<() => void>(() => {});
  const [editDetail, setEditDetail] = useState<SelectionDetail | null>(null);
  // Only the primary model is editable; its id (federation offset 0).
  const primaryId = useMemo(() => models.find((m) => m.primary)?.id ?? models[0]?.id, [models]);
  const [propsWidth, setPropsWidth] = useState(340);
  const [treeWidth, setTreeWidth] = useState(300);
  // Vertical size of the "Modele" panel. null = auto (CSS-capped at 40%); once the
  // user drags the divider it becomes a fixed pixel height.
  const [modelsHeight, setModelsHeight] = useState<number | null>(null);
  // Per-model forests (one MODEL root per model). Built by rebuildForests().
  const [spatialRoots, setSpatialRoots] = useState<TreeNode[] | null>(null);
  const [classRoots, setClassRoots] = useState<TreeNode[] | null>(null);
  const [materialRoots, setMaterialRoots] = useState<TreeNode[] | null>(null);
  // Active left-panel view: spatial hierarchy, grouped by IFC class, or by material.
  const [treeView, setTreeView] = useState<"spatial" | "class" | "material">("spatial");
  // Tree expansion is owned here (one open-id set per view) so it survives switching
  // between Spațial/Clase/Materiale tabs — IfcTree no longer remounts/loses state.
  const [expandedByView, setExpandedByView] = useState<Record<"spatial" | "class" | "material", Set<number>>>({
    spatial: new Set(),
    class: new Set(),
    material: new Set(),
  });
  // Models list shown in the "Modele" panel; bumped version re-memoizes pivot input.
  const [modelList, setModelList] = useState<{ id: string; fileName: string; primary: boolean; visible: boolean; schema: string }[]>([]);
  const [busyAdd, setBusyAdd] = useState(false);
  const [modelsVersion, setModelsVersion] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [visibleIds, setVisibleIds] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [ready, setReady] = useState(false);
  // The right dock hosts the IDS, BCF or cadastral georeferencing panel (toolbar toggles).
  const [dock, setDock] = useState<"none" | "ids" | "bcf" | "geo">("none");
  // Cadastral alignment: which model point the align tool is capturing, and the
  // two captured model points (raw IFC coords) paired with parcel corners.
  const [armedSlot, setArmedSlot] = useState<AlignSlot | null>(null);
  const [modelPtA, setModelPtA] = useState<IfcPoint | null>(null);
  const [modelPtB, setModelPtB] = useState<IfcPoint | null>(null);
  // Parcel-corner targets (Stereo 70), picked by snapping in the 3D scene or on
  // the 2D map. armedCornerRef mirrors the state for the (stale-closure) handlers.
  const [targetA, setTargetA] = useState<{ e: number; n: number } | null>(null);
  const [targetB, setTargetB] = useState<{ e: number; n: number } | null>(null);
  const [armedCorner, setArmedCorner] = useState<AlignSlot | null>(null);
  const armedCornerRef = useRef<AlignSlot | null>(null);
  // Selected parcel (info shown in the panel) + the "show all numbers" toggle.
  const [selectedParcel, setSelectedParcel] = useState<ParcelInfo | null>(null);
  const [showAllLabels, setShowAllLabels] = useState(false);
  // Model-info panel is open by default on load; it can be closed (×) or toggled
  // from the toolbar. A selection still takes over the right panel with props.
  const [showInfo, setShowInfo] = useState(true);
  // Per-element colors from the data-table "color by group" toggle (null = off).
  // Takes priority over the IDS red-paint when both could apply.
  const [groupColorMap, setGroupColorMap] = useState<Map<number, Rgba> | null>(null);
  // Bottom data-table (pivot). Independent of the right dock so they can coexist;
  // the config persists while the panel is toggled off/on.
  const [tableOpen, setTableOpen] = useState(false);
  const [pivotConfig, setPivotConfig] = useState<PivotConfig>({
    // Default grouping = Model → IFC class. "model" is auto-ignored when only one
    // model is loaded (it's not in the discovered fields then), so it falls back
    // to grouping by class alone.
    groupBy: ["model", "class"],
    values: [], // start with just the built-in "Număr" column; add value columns via ⚙
    showTotals: true,
  });

  // Each view is a forest of per-model MODEL roots (built in rebuildForests).
  const activeRoots = treeView === "class" ? classRoots : treeView === "material" ? materialRoots : spatialRoots;
  const expanded = expandedByView[treeView];

  const toggleNode = (id: number) =>
    setExpandedByView((m) => {
      const next = new Set(m[treeView]);
      next.has(id) ? next.delete(id) : next.add(id);
      return { ...m, [treeView]: next };
    });
  const collapseAllTree = () => setExpandedByView((m) => ({ ...m, [treeView]: new Set<number>() }));
  const expandAllTree = () => setExpandedByView((m) => ({ ...m, [treeView]: collectAllIds(activeRoots ?? []) }));

  // Pivot input: all loaded models' stores (memoized on the loaded-set version).
  const pivotModels = useMemo<PivotModel[]>(
    () => [...modelStoresRef.current.entries()].map(([id, r]) => ({ id, fileName: r.fileName, store: r.store, localIDs: r.localIDs, offset: r.offset })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelsVersion],
  );

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

    // Resize on the next animation frame (not a 100ms timeout): opening/closing a
    // dock or the props panel changes the viewer width, and a slow resize leaves
    // the WebGPU canvas stretched for a moment. rAF coalesces bursts (e.g. while
    // dragging a divider) without the visible lag.
    let resizeRaf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => engineRef.current?.resize());
    });
    ro.observe(host);

    (async () => {
      try {
        await engine.init();
        engine.resize();
        if (disposed) return;
        setStatus("Se încarcă modelul IFC…");
        // Load the PRIMARY model; federated extras are added by the diff effect.
        const primary = models.find((m) => m.primary) ?? models[0];
        const { store, offset, localIDs, globalIDs } = await engine.addModel(primary.id, primary.bytes, primary.fileName, { fitView: true });
        if (disposed) return;
        storeRef.current = store;
        allIDsRef.current = engine.allIDs;
        modelStoresRef.current.set(primary.id, { store, offset, localIDs, globalIDs, fileName: primary.fileName, schema: detectSchema(primary.bytes) });
        loadedModelIdsRef.current.add(primary.id);
        setVisibleIds(new Set(engine.allIDs));

        measureRef.current = new MeasureTool(engine, host);
        measureRef.current.setGeoref(georefRef.current);
        alignToolRef.current = new AlignTool(engine, host, (slot, ifcPt) => {
          if (slot === "A") setModelPtA(ifcPt);
          else setModelPtB(ifcPt);
          setArmedSlot(null);
        });
        alignToolRef.current.setGeoref(georefRef.current);
        parcelLayerRef.current = new ParcelLayer(engine, host);
        measureRef.current.setParcelLayer(parcelLayerRef.current); // measure can snap to parcel corners
        engine.onSectionMove = (pos) => setSecPos(pos); // keep the slider in sync with the drag handle
        wireEvents(host);

        // Model centroid in IFC absolute coords (handles real-coordinate models
        // whose IfcMapConversion has a zero Eastings/Northings offset).
        const mb = engine.modelBounds();
        const centroid = mb
          ? engine.worldToIfc({ x: (mb.min[0] + mb.max[0]) / 2, y: (mb.min[1] + mb.max[1]) / 2, z: (mb.min[2] + mb.max[2]) / 2 })
          : { x: engine.rtcOffset.x, y: engine.rtcOffset.y, z: engine.rtcOffset.z };
        modelCentroidRef.current = centroid;
        setFileInfo(
          gatherFileInfo(store, globalIDs.length, bytes.length, fileName, detectSchema(bytes), georefRef.current, centroid),
        );
        setStatus("Model încărcat • orbit: stânga • pan: dreapta/mijloc • zoom: scroll • Esc: anulează");
        setReady(true);
      } catch (e: any) {
        if (!disposed) setStatus("Eroare la încărcarea modelului: " + (e?.message ?? e));
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(resizeRaf);
      ro.disconnect();
      measureRef.current?.dispose();
      alignToolRef.current?.dispose();
      parcelLayerRef.current?.dispose();
      engine.dispose();
      measureRef.current = null;
      alignToolRef.current = null;
      parcelLayerRef.current = null;
      engineRef.current = null;
      delete (window as any).__engine;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Background: a settings override (hex) wins over the theme default.
  useEffect(() => {
    const bg = settings.viewer.background;
    engineRef.current?.setState({ clearColor: bg ? hexToRgba(bg) : VIEWER_BG[theme] });
  }, [theme, settings.viewer.background]);

  // Camera projection follows the setting.
  useEffect(() => {
    engineRef.current?.setProjection(settings.viewer.projection);
  }, [settings.viewer.projection, ready]);

  // Default snap options come from settings (toolbar toggles still override live).
  useEffect(() => {
    const next = { ...settings.viewer.snap };
    setSnapOpts(next);
    if (engineRef.current) engineRef.current.snapOptions = next;
  }, [settings.viewer.snap]);

  useEffect(() => {
    georefRef.current = georef;
    measureRef.current?.setGeoref(georef);
    alignToolRef.current?.setGeoref(georef);
  }, [georef]);

  // Draw the fetched parcels in the 3D scene (only while the cadastral panel is
  // open), re-projecting whenever the parcels or the georef change.
  useEffect(() => {
    const show = cadastreEnabled && dock === "geo";
    parcelLayerRef.current?.setData(show ? parcels : [], georef);
    if (!show) setSelectedParcel(null);
  }, [parcels, georef, dock, ready, cadastreEnabled]);

  // Disabling the Cadastre module while its panel is open closes + disarms it.
  useEffect(() => {
    if (cadastreEnabled) return;
    setDock((d) => (d === "geo" ? "none" : d));
    setArmedSlot(null);
    alignToolRef.current?.disarm();
    setArmedCorner(null);
    armedCornerRef.current = null;
    parcelLayerRef.current?.setArmed(false);
  }, [cadastreEnabled]);

  useEffect(() => {
    parcelLayerRef.current?.setShowAllLabels(showAllLabels);
  }, [showAllLabels]);

  // Federation: react to the models list — add newcomers, remove the departed,
  // then rebuild the per-model forests. Runs once primary is ready, then on every
  // models change. Guarded against duplicate adds (StrictMode / re-runs).
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !ready) return;
    let cancelled = false;
    (async () => {
      for (const m of models) {
        if (loadedModelIdsRef.current.has(m.id) || engine.hasModel(m.id)) continue;
        setBusyAdd(true);
        try {
          const { store, offset, localIDs, globalIDs } = await engine.addModel(m.id, m.bytes, m.fileName, { fitView: false });
          if (cancelled) return;
          modelStoresRef.current.set(m.id, { store, offset, localIDs, globalIDs, fileName: m.fileName, schema: detectSchema(m.bytes) });
          loadedModelIdsRef.current.add(m.id);
        } catch (e) {
          console.error("Federare: nu am putut adăuga modelul", m.fileName, e);
        }
      }
      for (const id of [...loadedModelIdsRef.current]) {
        if (models.some((m) => m.id === id)) continue;
        engine.removeModel(id);
        const rec = modelStoresRef.current.get(id);
        if (rec) for (const g of rec.globalIDs) modelHiddenRef.current.delete(g);
        hiddenModelsRef.current.delete(id);
        modelStoresRef.current.delete(id);
        loadedModelIdsRef.current.delete(id);
      }
      if (cancelled) return;
      setBusyAdd(false);
      allIDsRef.current = engine.allIDs;
      rebuildForests();
      applyVisibility();
      setModelList(models.map((m) => ({ id: m.id, fileName: m.fileName, primary: m.primary, visible: !hiddenModelsRef.current.has(m.id), schema: detectSchema(m.bytes) })));
      setModelsVersion((v) => v + 1);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, ready]);

  // Rebuild the per-model forests when the language changes so the localised
  // tree labels (e.g. the material buckets) follow the switch. Skips the initial
  // render (the model effect builds them) and any time models aren't ready yet.
  const didMountLang = useRef(false);
  useEffect(() => {
    if (!didMountLang.current) { didMountLang.current = true; return; }
    if (ready && engineRef.current) rebuildForests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  // Turning the section tool OFF removes the plane. Turning it ON only ARMS the
  // tool — the plane is created when the user double-clicks a face.
  useEffect(() => {
    if (!section) engineRef.current?.clearSection();
  }, [section]);

  // Keep the fullscreen flag in sync (handles Esc / external exit too).
  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else mainRef.current?.requestFullscreen?.();
  };

  // Keyboard: Esc cancels; H hide/restore selection; Z zoom extents; F frame selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        chooseMeasure("none");
        if (sectionRef.current) toggleSection();
        setArmedSlot(null);
        alignToolRef.current?.disarm();
        setArmedCorner(null);
        armedCornerRef.current = null;
        parcelLayerRef.current?.setArmed(false);
        setStatus("Comandă anulată (Esc).");
      } else if (e.key === "h" || e.key === "H") {
        toggleHideSelection();
      } else if (e.key === "z" || e.key === "Z") {
        engineRef.current?.fit();
      } else if (e.key === "f" || e.key === "F") {
        if (selectedRef.current.size) engineRef.current?.zoomToSelection(selectedRef.current);
      } else if (e.key === "i" || e.key === "I") {
        if (selectedRef.current.size) isolateIds([...selectedRef.current]);
      } else if (e.key === "s" || e.key === "S") {
        toggleSection();
      } else if (e.key === "e" || e.key === "E") {
        toggleEditRef.current(); // toggle the attribute/property editor
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (measureRef.current?.hasSelection()) { e.preventDefault(); measureRef.current.deleteSelected(); }
      } else if (e.key === "1") {
        engineRef.current?.setPresetView("top");
      } else if (e.key === "2") {
        engineRef.current?.setPresetView("bottom");
      } else if (e.key === "3") {
        engineRef.current?.setPresetView("front");
      } else if (e.key === "4") {
        engineRef.current?.setPresetView("back");
      } else if (e.key === "5") {
        engineRef.current?.setPresetView("left");
      } else if (e.key === "6") {
        engineRef.current?.setPresetView("right");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Color overrides have two drivers sharing one channel: the data-table
  // "color by group" map (takes priority) and the IDS red-paint of non-conforming
  // elements. Re-applied whenever either changes.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || !ready) return;
    if (groupColorMap && groupColorMap.size) {
      eng.setColorOverrideMap(groupColorMap);
    } else if (idsReport) {
      const failing = new Set<number>();
      for (const spec of idsReport.specificationResults)
        for (const e of spec.entityResults) if (!e.passed) failing.add(e.expressId);
      eng.setColorOverrides(failing, IDS_FAIL_COLOR);
    } else {
      eng.clearColorOverrides();
    }
  }, [groupColorMap, idsReport, ready]);

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
      const align = alignToolRef.current;
      if (align && align.armed()) return align.onClick(ev);
      const layer = parcelLayerRef.current;
      if (layer && layer.armed()) {
        const c = layer.pickCorner(ev.clientX, ev.clientY);
        const slot = armedCornerRef.current;
        if (c && slot) setCornerTarget(slot, c);
        return; // consume the click while picking a parcel corner
      }
      const measure = measureRef.current;
      if (measure && measure.mode !== "none") return measure.onClick(ev);
      if (sectionRef.current) return;
      // Outside measure mode, a click first tries to select an existing
      // measurement; only if none is hit do we fall through to element picking.
      if (measure && measure.selectAt(ev.clientX, ev.clientY)) { clearSelection(); return; }
      const engine = engineRef.current;
      if (!engine) return;
      const hit = await engine.pick(ev.clientX, ev.clientY);
      if (hit && hit.expressId != null) {
        selectIds([hit.expressId], hit.expressId);
        parcelLayerRef.current?.clearSelection();
        setSelectedParcel(null);
      } else {
        // Clicking empty space over a parcel selects the parcel instead.
        const info = parcelLayerRef.current?.selectAt(ev.clientX, ev.clientY) ?? null;
        clearSelection();
        setSelectedParcel(info);
        if (!info) parcelLayerRef.current?.clearSelection();
      }
    };
    host.ondblclick = (ev: MouseEvent) => {
      const measure = measureRef.current;
      if (measure && measure.mode === "area") return measure.onDblClick();
      if (measure && measure.mode !== "none") return;
      // Only when the section tool is armed: double-click a face → create the cut there.
      if (sectionRef.current) sectionFromFace(ev);
    };
    host.onmousemove = (ev: MouseEvent) => {
      const align = alignToolRef.current;
      if (align && align.armed()) { align.onMove(ev); return; }
      const layer = parcelLayerRef.current;
      if (layer && layer.armed()) { layer.onHover(ev.clientX, ev.clientY); return; }
      const measure = measureRef.current;
      if (measure && measure.mode !== "none") { measure.onMove(ev); return; }
      // idle: highlight the parcel under the cursor (no-op when no parcels loaded)
      layer?.onHover(ev.clientX, ev.clientY);
    };
  }

  // --- cadastral georeferencing -------------------------------------------
  const armModelPick = (slot: AlignSlot) => {
    // model-point and parcel-corner picking are mutually exclusive
    setArmedCorner(null);
    armedCornerRef.current = null;
    parcelLayerRef.current?.setArmed(false);
    setArmedSlot(slot);
    alignToolRef.current?.arm(slot);
  };
  const armCornerPick = (slot: AlignSlot) => {
    setArmedSlot(null);
    alignToolRef.current?.disarm();
    armedCornerRef.current = slot;
    setArmedCorner(slot);
    parcelLayerRef.current?.setArmed(true);
  };
  const setCornerTarget = (slot: AlignSlot, c: { e: number; n: number }) => {
    if (slot === "A") setTargetA(c);
    else setTargetB(c);
    armedCornerRef.current = null;
    setArmedCorner(null);
    parcelLayerRef.current?.setArmed(false);
  };
  // Apply a computed georef live: viewer Stereo 70 readouts + (via App) the globe.
  const applyGeorefLive = (g: GeorefInfo) => {
    georefRef.current = g;
    measureRef.current?.setGeoref(g);
    alignToolRef.current?.setGeoref(g);
    onGeorefChange?.(g);
  };
  // Apply live AND record it for the non-destructive IFC export (IfcMapConversion).
  const writeGeorefToIfc = (g: GeorefInfo) => {
    applyGeorefLive(g);
    editor.setGeoref(g);
    onChangeCount(editor.changeCount());
  };

  const isPrimary = (modelId: string) => modelId === primaryId;

  // --- selection ----------------------------------------------------------
  const selectIds = (ids: number[], expressID?: number) => {
    if (ids.length) lastHiddenRef.current = [];
    selectedRef.current = new Set(ids);
    setSelectedIds(new Set(ids));
    engineRef.current?.setSelectionOutline(ids);
    // Selecting something new exits any active edit form.
    setEditing(false);
    setEditDetail(null);
    const propId = expressID ?? (ids.length === 1 ? ids[0] : undefined);
    // Route the global id back to its owning model's store for properties.
    const r = propId != null ? engineRef.current?.resolveGlobal(propId) : null;
    if (r) {
      editTargetRef.current = { modelId: r.modelId, localId: r.localId };
      // Primary elements read through App's editor (mutation-aware, so applied
      // edits persist on reselect). Federated models are view-only.
      if (isPrimary(r.modelId)) {
        const detail = editor.getSelection(r.localId);
        setSelHeader(detail.header);
        setPropGroups(detailToPropGroups(detail));
      } else {
        const { header, groups } = getSelectionProps(r.store, r.localId);
        setSelHeader(header);
        setPropGroups(groups);
      }
      setPropsKey((k) => k + 1);
    } else {
      editTargetRef.current = null;
      setPropGroups(null);
      setSelHeader(null);
    }
  };

  const clearSelection = () => {
    selectedRef.current = new Set();
    setSelectedIds(new Set());
    engineRef.current?.setSelectionOutline([]);
    editTargetRef.current = null;
    setEditing(false);
    setEditDetail(null);
    setPropGroups(null);
    setSelHeader(null);
  };

  // --- editing (primary model only) ---------------------------------------
  // Editable whenever the selection resolves to a single real entity on the
  // primary model. editTargetRef is only set when resolveGlobal maps a real
  // positive id to an owning model, so synthetic class-group / MODEL-root rows
  // (negative ids) stay non-editable while non-geometric spatial containers —
  // whose own expressId resolves — become editable.
  const canEditSelection = !!editTargetRef.current && isPrimary(editTargetRef.current.modelId);

  const startEdit = () => {
    const t = editTargetRef.current;
    if (!t || !isPrimary(t.modelId)) return;
    setEditDetail(editor.getSelection(t.localId));
    setEditing(true);
  };

  const onEditSaved = () => {
    const t = editTargetRef.current;
    if (!t) return;
    // Edits were applied to App's editor by the EditPanel; refresh + report.
    const detail = editor.getSelection(t.localId);
    setPropGroups(detailToPropGroups(detail));
    setSelHeader(detail.header);
    setEditing(false);
    setEditDetail(null);
    onChangeCount(editor.changeCount());
  };

  const exitEdit = () => {
    setEditing(false);
    setEditDetail(null);
  };

  // Keep the "E" shortcut bound to the current closures (the keydown effect's deps
  // are empty, so it reads this ref instead of stale state).
  toggleEditRef.current = () => {
    if (editing) exitEdit();
    else if (canEditSelection) startEdit();
  };

  // Rebuild the three per-model forests (one MODEL root per loaded model). Spatial
  // keeps the per-container class subgrouping; ids are offset into global space.
  const rebuildForests = () => {
    const spatial: TreeNode[] = [];
    const cls: TreeNode[] = [];
    const mat: TreeNode[] = [];
    let idx = 0;
    for (const m of models) {
      const rec = modelStoresRef.current.get(m.id);
      if (!rec) continue;
      const rootId = -(2_000_000 + idx);
      const localSet = new Set(rec.localIDs);
      const sRaw = buildTree(rec.store, localSet);
      const sGrouped = sRaw ? groupByClass(sRaw, { n: 0 }) : null;
      spatial.push(modelRootNode(rootId, rec.fileName, sGrouped ? [offsetTree(sGrouped, rec.offset)] : [], rec.globalIDs));
      cls.push(modelRootNode(rootId, rec.fileName, buildClassTree(rec.store, localSet).map((n) => offsetTree(n, rec.offset)), rec.globalIDs));
      mat.push(modelRootNode(rootId, rec.fileName, buildMaterialTree(rec.store, localSet).map((n) => offsetTree(n, rec.offset)), rec.globalIDs));
      idx++;
    }
    setSpatialRoots(spatial);
    setClassRoots(cls);
    setMaterialRoots(mat);
    // Seed each view's expansion with its default-open nodes. Rebuilds happen on
    // federation changes (add/remove model), where resetting expansion is expected.
    setExpandedByView({
      spatial: collectDefaultOpen(spatial),
      class: collectDefaultOpen(cls),
      material: collectDefaultOpen(mat),
    });
  };

  // --- visibility ---------------------------------------------------------
  const applyVisibility = () => {
    const eng = engineRef.current;
    if (!eng) return;
    // Effective hidden = element-level hides ∪ per-model hides.
    const hidden = new Set<number>(hiddenRef.current);
    for (const id of modelHiddenRef.current) hidden.add(id);
    eng.setState({ hiddenIds: hidden, isolatedIds: isolatedRef.current ? new Set(isolatedRef.current) : null });
    const all = allIDsRef.current;
    const iso = isolatedRef.current;
    const next = new Set<number>(iso ? [...iso] : all);
    for (const id of hidden) next.delete(id);
    setVisibleIds(next);
  };

  // Per-model visibility toggle (folds the model's global ids into the hidden set).
  const toggleModelVisible = (id: string, visible: boolean) => {
    const rec = modelStoresRef.current.get(id);
    if (!rec) return;
    if (visible) {
      hiddenModelsRef.current.delete(id);
      for (const g of rec.globalIDs) modelHiddenRef.current.delete(g);
    } else {
      hiddenModelsRef.current.add(id);
      for (const g of rec.globalIDs) modelHiddenRef.current.add(g);
    }
    applyVisibility();
    setModelList((l) => l.map((m) => (m.id === id ? { ...m, visible } : m)));
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
  const startModelsResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    // The panel sits directly before the divider; measure from its top edge so the
    // height tracks the cursor regardless of the toolbar/header above it.
    const panel = (e.currentTarget as HTMLElement).previousElementSibling as HTMLElement | null;
    const top = panel?.getBoundingClientRect().top ?? 0;
    const onMove = (ev: MouseEvent) =>
      setModelsHeight(Math.min(window.innerHeight * 0.75, Math.max(80, ev.clientY - top)));
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
            {t("viewer.webgpuPre")}<b>WebGPU</b>{t("viewer.webgpuPost")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="viewer-wrap">
      <aside className="ifctree-panel" style={{ width: treeWidth }}>
        <ModelsPanel
          models={modelList}
          busy={busyAdd}
          onToggleVisible={toggleModelVisible}
          onRemove={onRemoveModel}
          onAddModel={onAddModel}
          height={modelsHeight}
        />
        <div className="models-resize" onMouseDown={startModelsResize} title={t("viewer.resizeModels")} />
        <div className="tree-tabs">
          <button className={"tree-tab" + (treeView === "spatial" ? " active" : "")} onClick={() => setTreeView("spatial")}>{t("viewer.treeSpatial")}</button>
          <button className={"tree-tab" + (treeView === "class" ? " active" : "")} onClick={() => setTreeView("class")}>{t("viewer.treeClass")}</button>
          <button className={"tree-tab" + (treeView === "material" ? " active" : "")} onClick={() => setTreeView("material")}>{t("viewer.treeMaterial")}</button>
        </div>
        {activeRoots ? (
          <IfcTree
            roots={activeRoots}
            expanded={expanded}
            onToggle={toggleNode}
            onCollapseAll={collapseAllTree}
            onExpandAll={expandAllTree}
            visibleIds={visibleIds}
            selectedIds={selectedIds}
            onSelect={(ids, expressID) => selectIds(ids, expressID)}
            onToggleVisible={(ids, visible) => (visible ? showIds(ids) : hideIds(ids))}
          />
        ) : (
          <div className="ifctree-empty">{t("viewer.treeLoading")}</div>
        )}
        <div className="tree-resize" onMouseDown={startTreeResize} title={t("viewer.resize")} />
      </aside>

      <div className="viewer-main" ref={mainRef}>
        <div className="vtoolbar">
          <Dropdown label={t("viewer.measure")} icon={<ToolIcon kind="measure" />} active={measureMode !== "none"}>
            <button className={"vmenu-item" + (measureMode === "length" ? " active" : "")} onClick={() => chooseMeasure("length")}><span className="ic"><ToolIcon kind="distance" /></span> {t("viewer.measureLength")}</button>
            <button className={"vmenu-item" + (measureMode === "point" ? " active" : "")} onClick={() => chooseMeasure("point")}><span className="ic"><ToolIcon kind="point" /></span> {t("viewer.measurePoint")}</button>
            <button className={"vmenu-item" + (measureMode === "area" ? " active" : "")} onClick={() => chooseMeasure("area")}><span className="ic">▱</span> {t("viewer.measureArea")}</button>
            <div className="vmenu-sep" />
            <div onClick={(e) => e.stopPropagation()} style={{ padding: "4px 12px", fontSize: 12 }}>
              <div style={{ opacity: 0.7, margin: "2px 0 4px" }}>{t("viewer.snapTo")}</div>
              {([["vertex", t("viewer.snapVertex")], ["midpoint", t("viewer.snapMid")], ["edge", t("viewer.snapEdge")], ["face", t("viewer.snapFace")]] as const).map(([k, lbl]) => (
                <label key={k} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", cursor: "pointer" }}>
                  <input type="checkbox" checked={snapOpts[k]} onChange={() => toggleSnap(k)} /> {lbl}
                </label>
              ))}
            </div>
            <div className="vmenu-sep" />
            <button className="vmenu-item danger" onClick={() => measureRef.current?.clearAll()}><span className="ic">🗑</span><span>{t("viewer.clearMeasures")}</span></button>
          </Dropdown>

          <span className="vsep" />

          <Dropdown label={t("viewer.section")} icon={<ToolIcon kind="section" />} active={section}>
            <button className={"vmenu-item" + (section ? " active" : "")} onClick={toggleSection}>
              <span className="ic"><ToolIcon kind="section" /></span><span>{t("viewer.sectionPlane")}</span><span className="vmenu-key">S</span>
            </button>
            <div className="vmenu-sep" />
            <button className="vmenu-item danger" onClick={clearSections}><span className="ic">🗑</span><span>{t("viewer.clearSections")}</span></button>
          </Dropdown>

          <span className="vsep" />

          <Dropdown label={t("viewer.visibility")} icon="👁">
            <button className="vmenu-item" onClick={() => hideIds(selArr())}>
              <span className="ic"><VisIcon kind="hide" /></span><span>{t("viewer.hideSel")}</span><span className="vmenu-key">H</span>
            </button>
            <button className="vmenu-item" onClick={() => isolateIds(selArr())}>
              <span className="ic"><VisIcon kind="isolate" /></span><span>{t("viewer.isolateSel")}</span><span className="vmenu-key">I</span>
            </button>
            <button className="vmenu-item" onClick={() => { if (selectedRef.current.size) engineRef.current?.zoomToSelection(selectedRef.current); }}>
              <span className="ic"><VisIcon kind="frame" /></span><span>{t("viewer.frameSel")}</span><span className="vmenu-key">F</span>
            </button>
            <div className="vmenu-sep" />
            <button className="vmenu-item" onClick={showAll}><span className="ic"><VisIcon kind="show" /></span><span>{t("viewer.showAll")}</span></button>
          </Dropdown>

          <span className="vsep" />

          <Dropdown label={t("viewer.views")} icon={<ToolIcon kind="views" />}>
            <button className="vmenu-item" onClick={() => engineRef.current?.setPresetView("top")}>
              <span className="ic"><ViewIcon kind="up" /></span><span>{t("viewer.viewTop")}</span><span className="vmenu-key">1</span>
            </button>
            <button className="vmenu-item" onClick={() => engineRef.current?.setPresetView("bottom")}>
              <span className="ic"><ViewIcon kind="down" /></span><span>{t("viewer.viewBottom")}</span><span className="vmenu-key">2</span>
            </button>
            <button className="vmenu-item" onClick={() => engineRef.current?.setPresetView("front")}>
              <span className="ic"><ViewIcon kind="front" /></span><span>{t("viewer.viewFront")}</span><span className="vmenu-key">3</span>
            </button>
            <button className="vmenu-item" onClick={() => engineRef.current?.setPresetView("back")}>
              <span className="ic"><ViewIcon kind="back" /></span><span>{t("viewer.viewBack")}</span><span className="vmenu-key">4</span>
            </button>
            <button className="vmenu-item" onClick={() => engineRef.current?.setPresetView("left")}>
              <span className="ic"><ViewIcon kind="left" /></span><span>{t("viewer.viewLeft")}</span><span className="vmenu-key">5</span>
            </button>
            <button className="vmenu-item" onClick={() => engineRef.current?.setPresetView("right")}>
              <span className="ic"><ViewIcon kind="right" /></span><span>{t("viewer.viewRight")}</span><span className="vmenu-key">6</span>
            </button>
            <div className="vmenu-sep" />
            <button className="vmenu-item" onClick={() => engineRef.current?.fit()}>
              <span className="ic">⤢</span><span>{t("viewer.fitAll")}</span><span className="vmenu-key">Z</span>
            </button>
          </Dropdown>

          <span className="vsep" />

          <button className={"vbtn" + (dock === "ids" ? " active" : "")} onClick={() => setDock((d) => (d === "ids" ? "none" : "ids"))}>
            <span className="ic"><ToolIcon kind="ids" /></span>
            <span>IDS</span>
          </button>

          <button className={"vbtn" + (dock === "bcf" ? " active" : "")} onClick={() => setDock((d) => (d === "bcf" ? "none" : "bcf"))}>
            <span className="ic"><ToolIcon kind="bcf" /></span>
            <span>BCF</span>
          </button>

          <button className={"vbtn" + (tableOpen ? " active" : "")} onClick={() => setTableOpen((o) => !o)}>
            <span className="ic"><ToolIcon kind="table" /></span>
            <span>Tabel</span>
          </button>

          {cadastreEnabled && (
            <button className={"vbtn" + (dock === "geo" ? " active" : "")} onClick={() => setDock((d) => (d === "geo" ? "none" : "geo"))}>
              <span className="ic"><ToolIcon kind="cadastre" /></span>
              <span>{t("geo.tab")}</span>
            </button>
          )}

          <span className="vsep" />

          <button className={"vbtn" + (showInfo ? " active" : "")} onClick={() => setShowInfo((s) => !s)} title={t("viewer.modelInfoTitle")}>
            <span className="ic">ℹ</span>
            <span>{t("viewer.info")}</span>
          </button>
        </div>

        <div className="viewer-host" ref={hostRef} style={{ position: "relative" }}>
          <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
          {ready && settings.viewer.navCube && (
            <NavCube
              getTransform={() => engineRef.current?.cubeMatrix() ?? ""}
              onFace={(v) => engineRef.current?.setPresetView(v)}
              onOrbit={(dx, dy) => engineRef.current?.orbit(dx, dy)}
            />
          )}
          {ready && settings.viewer.viewBar && (
            <ViewBar
              onHome={() => engineRef.current?.homeView()}
              onFit={() => engineRef.current?.fit()}
              onZoomIn={() => engineRef.current?.zoomBy(-200)}
              onZoomOut={() => engineRef.current?.zoomBy(200)}
              onFullscreen={toggleFullscreen}
              fullscreen={fullscreen}
            />
          )}
          {section && (
            <div className="section-ctl" style={sectionCtlStyle}>
              <span style={{ fontSize: 12, opacity: 0.85 }}>{t("viewer.sectionHint")}</span>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12 }}>{t("viewer.position")}</span>
                <input
                  type="range" min={0} max={100} value={secPos}
                  onChange={(e) => { const v = Number(e.target.value); setSecPos(v); engineRef.current?.sectionSetPos(v); }}
                  style={{ width: 140 }}
                />
                <span style={{ fontSize: 12, width: 32 }}>{secPos}%</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12 }}>{t("viewer.size")}</span>
                <input
                  type="range" min={2} max={100} value={secSize}
                  onChange={(e) => { const v = Number(e.target.value); setSecSize(v); engineRef.current?.setSectionSize(v / 100); }}
                  style={{ width: 120 }}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox" checked={secFlip}
                  onChange={(e) => { setSecFlip(e.target.checked); engineRef.current?.sectionSetFlipped(e.target.checked); }}
                /> {t("viewer.flip")}
              </label>
            </div>
          )}
        </div>

        {tableOpen && ready && pivotModels.length > 0 && (
          <DataTablePanel
            models={pivotModels}
            fileName={fileName}
            config={pivotConfig}
            onConfigChange={setPivotConfig}
            onSelectRows={(ids) => selectIds(ids)}
            onColorByGroup={setGroupColorMap}
            onClose={() => setTableOpen(false)}
          />
        )}
      </div>

      {(propGroups || showInfo) && (
      <aside className="props-panel" style={{ width: propsWidth }}>
        <div className="props-resize" onMouseDown={startPropsResize} title={t("viewer.resize")} />
        <div className="props-head">
          <span>{propGroups ? t("viewer.propsTitle") : t("viewer.modelInfoTitle")}</span>
          <span className="props-close" onClick={() => (propGroups ? clearSelection() : setShowInfo(false))} title={t("viewer.deselect")}>×</span>
        </div>
        <div className="props-body">
          {propGroups ? (
            <>
              {selHeader && (
                <div className="sel-header">
                  <div className="sel-title">
                    <div className="sel-name" title={selHeader.name}>{selHeader.name || t("viewer.unnamed")}</div>
                    {selHeader.type && <div className="sel-type">{selHeader.type}</div>}
                  </div>
                  <div className="sel-actions">
                    <button
                      className={"sel-btn" + (editing ? " active" : "")}
                      title={editing ? t("viewer.editClose") : canEditSelection ? t("viewer.editOpen") : t("viewer.editPrimaryOnly")}
                      disabled={!editing && !canEditSelection}
                      onClick={() => (editing ? exitEdit() : startEdit())}
                    >
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
                      </svg>
                    </button>
                    <button className="sel-btn" title={t("viewer.frameElement")} onClick={() => engineRef.current?.zoomToSelection(selectedRef.current)}>
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                      </svg>
                    </button>
                    <button className="sel-btn" title={t("viewer.hideElement")} onClick={hideSelection}>
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.6" /><path d="M3 3l18 18" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
              {editing && editDetail && editTargetRef.current ? (
                <EditPanel
                  editor={editor}
                  id={editTargetRef.current.localId}
                  detail={editDetail}
                  schema={editor.schema()}
                  onSaved={onEditSaved}
                  onCancel={exitEdit}
                />
              ) : (
                <PropAccordion key={propsKey} groups={propGroups} favorites={favorites} onToggleFavorite={onToggleFavorite} />
              )}
            </>
          ) : fileInfo ? (
            <FileInfoPanel info={fileInfo} />
          ) : (
            <div className="props-empty">{t("viewer.propsEmpty")}</div>
          )}
        </div>
      </aside>
      )}

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

      {cadastreEnabled && dock === "geo" && (() => {
        // Auto-centre the cadastral search on the model: map its centroid to
        // Stereo 70 with the current georef. "known" only when the result is a
        // real-world location (georeferenced, or geometry already in Stereo 70).
        const c = modelCentroidRef.current;
        const en = c ? modelToStereo70(georef, c.x, c.y, c.z) : null;
        const known = !!en && (georef != null || inRomania(en.e, en.n));
        return (
          <GeorefPanel
            modelA={modelPtA}
            modelB={modelPtB}
            armedSlot={armedSlot}
            onArmModelPick={armModelPick}
            targetA={targetA}
            targetB={targetB}
            armedCorner={armedCorner}
            onArmCornerPick={armCornerPick}
            baseGeoref={georef}
            modelCenter={known && en ? { e: en.e, n: en.n } : null}
            onParcelsChange={onParcelsChange}
            selectedParcel={selectedParcel}
            showAllLabels={showAllLabels}
            onShowAllLabels={setShowAllLabels}
            supportsGeoref={editor.supportsGeoref()}
            onApply={applyGeorefLive}
            onWriteIfc={writeGeorefToIfc}
            onClose={() => {
              setDock("none");
              setArmedSlot(null);
              alignToolRef.current?.disarm();
              setArmedCorner(null);
              armedCornerRef.current = null;
              parcelLayerRef.current?.setArmed(false);
            }}
          />
        );
      })()}
    </div>
  );
}

// Friendly labels for the IfcRoot attribute rows in the read-only panel.
// Translated at call time (the attribute name stays the IFC identifier).
const ATTR_LABEL_KEYS: Record<string, I18nKey> = {
  Name: "viewer.attr.name",
  Description: "viewer.attr.description",
  ObjectType: "viewer.attr.objectType",
  Tag: "viewer.attr.tag",
};
const attrLabel = (name: string): string => {
  const k = ATTR_LABEL_KEYS[name];
  return k ? t(k) : name;
};

// Flatten an editor's view-aware selection into the read-only PropAccordion shape
// (so applied edits show in the non-edit panel too). GlobalId rows are kept.
function detailToPropGroups(detail: SelectionDetail): PropGroup[] {
  return detail.groups.map((g) => ({
    name: g.kind === "attribute" ? t("viewer.attrGroup") : g.name,
    rows: g.rows
      .filter((r) => r.value.length)
      .map((r) => ({ k: g.kind === "attribute" ? attrLabel(r.name) : r.name, v: r.value, edited: r.edited })),
  })).filter((g) => g.rows.length);
}

// Ids of every node that starts open by default (mirrors IfcTree's per-node rule).
function collectDefaultOpen(roots: TreeNode[], depth = 0, acc = new Set<number>()): Set<number> {
  for (const n of roots) {
    if (defaultNodeOpen(n, depth)) acc.add(n.expressID);
    collectDefaultOpen(n.children, depth + 1, acc);
  }
  return acc;
}

// Ids of every node that has children (i.e. everything that can be expanded).
function collectAllIds(roots: TreeNode[], acc = new Set<number>()): Set<number> {
  for (const n of roots) {
    if (n.children.length) acc.add(n.expressID);
    collectAllIds(n.children, acc);
  }
  return acc;
}

// Spatial containers are never grouped; element children are grouped by IFC class.
const SPATIAL_TYPES = new Set(["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCSPACE", "IFCFACILITY", "IFCBRIDGE", "IFCROAD", "IFCRAILWAY", "IFCMARINEFACILITY", "IFCFACILITYPART"]);

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
