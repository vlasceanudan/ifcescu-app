# Plan de situație IFC — web app

A fully client-side web app to enrich a *plan de situație* IFC file with project,
beneficiary, land-registration, address and **georeferencing** metadata, inspect it
in an interactive 3D viewer, and place it on a **3D globe** in real-world context.
Everything runs **in the browser** — IFC parsing/editing/export and geometry via
[**@ifc-lite**](https://github.com/louistrue/ifc-lite) (Rust → WebAssembly), 3D
rendering via **@ifc-lite/renderer (WebGPU)**, and the globe via
[CesiumJS](https://cesium.com/platform/cesiumjs/) — so there is **no server** and it
can be hosted as a static site on **GitHub Pages**. It is targeted at Romania:
national projection **Stereo 70 (EPSG:3844)** and vertical datum **Marea Neagră 1975**.

Built with **Vite + React + TypeScript**, the buildingSMART colour palette
(magenta primary, teal/blue accents) and a light/dark theme toggle. Full-screen
app-shell layout: top bar, resizable IFC-structure tree on the left, viewer in the
centre, resizable properties panel on the right.

> **`migrate-ifc-lite` branch.** This branch replaces the previous engine
> (`web-ifc` + `web-ifc-viewer` + `three.js`) with **`@ifc-lite`** end-to-end:
> `@ifc-lite/parser` (columnar IFC2X3/4/4X3 parse), `@ifc-lite/geometry`
> (streaming tessellation), `@ifc-lite/mutations` + `@ifc-lite/export`
> (non-destructive STEP export), and `@ifc-lite/renderer` (WebGPU). The decision
> record and headless verification harnesses live in [`poc/`](poc/).
>
> ⚠️ **The 3D viewer requires WebGPU** (recent Chrome/Edge, or Safari 18+). Without
> WebGPU it shows a notice — **data editing and export still work**. The globe
> (Cesium) works everywhere.

## Features

### 📝 Editare date (metadata editing)
- Edit project **number/name**, **beneficiary** (person or organisation — upserted,
  never duplicated), **`PSet_LandRegistration`** (LandTitleID, LandId) and
  **`PSet_Address`** (Street, Town, Region/county, PostalCode, Country) on the chosen
  `IfcSite`.
- **Add an `IfcSite`** when the model has none: instead of refusing the file, the
  *Teren* card offers an **Adaugă IfcSite** button (creates the site and aggregates it
  under the `IfcProject`), so land/address data always has somewhere to attach.
- **Georeferențiere (Stereo 70)** — a **collapsible** section (closed by default):
  read/edit the **`IfcMapConversion`** + **`IfcProjectedCRS`** origin —
  Est (X) / Nord (Y) / Cotă / rotation / scale (IFC4+ only; disabled with a note on
  IFC2x3). Full-precision easting/northing is preserved on export.
- Fields **pre-fill** from the model; light validation (postal code, land fields,
  Stereo 70 bounds).
- Apply → summary of changes → **download the enriched `.ifc`**.
- **Non-destructive export** via `@ifc-lite/export`: every untouched record is
  preserved with full numeric precision (no truncation / malformed reals), and only
  the entities you created/edited change — the download stays geometrically identical
  to the source and opens cleanly in other viewers (see [Notes](#notes)).

### 🧊 Vizualizare 3D (viewer — WebGPU)
- **Streaming load**: geometry streams into the WebGPU scene as it tessellates, so the
  UI stays responsive (the heavy work runs off the main thread).
- **IFC structure tree** (left, resizable): the spatial hierarchy with leaf elements
  **grouped by IFC class** (e.g. `PILE (336)`), so a storey with hundreds of identical
  elements reads as a short class list. Toggle **visibility** (eye) and **select**
  straight from the tree. Built natively from the `@ifc-lite` store (IFC2X3/4/4X3).
- **Selection**: click an element (in the viewer or tree) → a clean **lime silhouette
  outline** (feature edges; depth-independent, like the previous viewer).
- **Properties** (right, resizable):
  - When an element is selected, a **title** shows its **name + IFC class** with two
    actions — **zoom-to** (fit the camera tightly to the element) and **hide**.
  - Property sets are grouped into collapsible accordions — an *Atribute* section,
    custom psets, then **quantity sets (`Qto_*`) always last**.
  - **Favorite a property** with the ☆ star to pin it in a *Favorite* section that
    stays visible as you move between elements; favorites reset when a new file is
    imported.
  - With **nothing selected**, the panel shows a **model overview** (file size, schema,
    project name/GlobalId, statistics) and a **Location** card — the model centroid
    mapped to Stereo 70 → WGS84 on an embedded **OpenStreetMap** map with a pin, plus
    quick links to **Google Maps / OpenStreetMap / Google Earth**.
- **Măsurare**: length, point and area, with **object snapping**. The active snap
  methods are **selectable** in the Măsurare menu — **Vârf** (endpoint), **Mijloc**
  (edge midpoint), **Muchie** (nearest on edge), **Față** (surface); all on by default.
  A per-type glyph shows what's being snapped. The **point** tool reports IFC X/Y/Z and,
  when georeferenced, Stereo 70 **E/N/H**. Measuring **coexists with an active section**.
- **Secțiune**: arm the tool, then **double-click a face** → a clip plane aligned to
  that face. The plane shows as a **fixed bounding-box-sized outline** (no fill, drawn
  in 3D so it never morphs on zoom) with a **draggable scissor handle**; move it with
  the handle or the position slider, and flip the kept side. (The WebGPU renderer
  supports one clip plane at a time.)
- **Vizibilitate**: hide / isolate / show-all.
- **Vederi**: axonometric (fit), top, front, back, left, right, bottom.
- **Keyboard shortcuts**: **`Z`** zoom-to selection, **`H`** toggle hide/restore the
  selection, **`Esc`** cancels the active command.
- Large georeferenced models are handled by `@ifc-lite`'s **RTC** (relative-to-centre)
  origin, so they render without float32 jitter; reported coordinates remain exact.

### 🌍 Glob 3D (Cesium globe)
- Places the IFC model on a 3D world map at its true location and **cotă**. Works for
  both **georeferenced** IFCs (`IfcMapConversion`) and IFCs already in **real Stereo 70
  coordinates** (including models whose map conversion has a zero Eastings/Northings
  offset); models with only a small local origin show a notice.
- **Token-free** basemaps: OpenStreetMap **Stradă** / Esri **Satelit**, plus Esri
  **World Elevation** terrain.
- **Earth transparency** slider — see geometry below the surface (e.g. foundation piles).
- **Mouse controls match the 3D viewer**: orbit (left), pan (right), zoom (scroll).
- Renders the **real per-element IFC colours** and shows a readout (Est/Nord/cotă,
  lon/lat, geoid ζ, terrain cotă, ellipsoidal height, meridian convergence).
- **Vertical datum**: IFC heights are Marea Neagră 1975 (≈ mean sea level); global
  terrain providers serve mean-sea-level heights too, so the model is placed at its
  cotă directly and sits coherently on the terrain. A bundled **EGM2008** geoid grid
  (`public/geoid/egm2008-ro.json`, generated by `scripts/gen-geoid.mjs`) provides the
  geoid undulation ζ shown in the readout.

## Develop

```bash
npm install
npm run dev      # dev server
npm run build    # typecheck + production build to dist/
npm run preview  # serve the production build locally
npm test         # vitest: editor round-trip + geo (crs/geoid/placement)
```

> The editor round-trip test parses a real IFC with `@ifc-lite`; it needs a sample —
> set `IFC_SAMPLE=<path>` or that test skips. The `geo` tests run with no sample.
> `poc/` holds extra headless harnesses (Node + a puppeteer-driven WebGPU smoke);
> see [`poc/README.md`](poc/README.md).

## Deploy to GitHub Pages

`vite.config.ts` uses `base: "./"`, so the build works at any Pages path without
changes. Push to a GitHub repo and enable **Settings → Pages → Source: GitHub
Actions**; the included [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
builds and publishes `dist/` on every push. Cesium's static assets and the `@ifc-lite`
WASM + geometry workers are bundled by Vite at build time. (The WebGPU viewer needs a
WebGPU-capable browser at runtime; editing/export and the globe do not.)

## Project structure

```
index.html              app entry
vite.config.ts          base "./"; Cesium assets; @ifc-lite wasm/workers
public/
  logo_bsro.svg         buildingSMART România logo (inlined; theme-aware)
  geoid/egm2008-ro.json EGM2008 geoid undulation grid, Romania clip
scripts/gen-geoid.mjs   one-off generator for the geoid grid asset
src/
  App.tsx               app shell (top bar + tabs + main)
  ifc/
    store.ts            shared @ifc-lite columnar parse provider (parseStore)
    editor.ts           IfcEditor: read / edit / export on @ifc-lite (mutations + export)
    constants.ts        counties, pset/prop names, Stereo 70 defaults
    guid.ts             IFC GUID generator
  components/
    Header, UploadPanel, EditorForm, Viewer, IfcTree, PropsPanel, GlobeViewer
  viewer/
    engine.ts           WebGPU engine wrapper (@ifc-lite/renderer): load/pick/render,
                        camera controls, selection outline, section, snapping
    model.ts            spatial tree + property groups + file overview from the store
    measure.ts          measurement tool (length/point/area) + snap glyphs
  geo/                  globe placement: crs (proj4), geoid, extractGeometry,
                        placement (Stereo 70 → WGS84 + cotă), glb builder
  theme/theme.css       buildingSMART palette + light/dark
  hooks/useTheme.ts
tests/
  editor.test.ts        editor + georef round-trip on @ifc-lite (needs a sample IFC)
  createSite.test.ts    add-IfcSite + non-destructive export round-trip
  geo.test.ts           crs / geoid / placement unit tests
poc/                    @ifc-lite vs web-ifc analysis + headless verification harnesses
```

## Notes

- **Engine: 100% `@ifc-lite`.** `web-ifc`, `web-ifc-viewer` and `three.js` are no
  longer dependencies. Parsing/geometry/editing/export run on `@ifc-lite`; rendering
  runs on `@ifc-lite/renderer` (WebGPU).
- **WebGPU is required for the 3D viewer** — there is no WebGL fallback in the
  renderer. The app gates on `navigator.gpu` and shows a notice when absent; data
  editing, export and the Cesium globe keep working.
- **Export is non-destructive.** `@ifc-lite/export` regenerates STEP while preserving
  every untouched record (verified token-for-token) with full numeric precision — the
  Stereo 70 eastings/northings keep all significant digits, and there are no malformed
  reals. Only created/edited entities (project name, psets, a new site, beneficiary,
  georef) change.
- **IFC4X3** is parsed natively by `@ifc-lite` (no schema-table workaround needed).
- **Section: one clip plane at a time** — the WebGPU renderer clips against a single
  plane. The plane is created from a double-clicked face and slid along its normal;
  creating a new one replaces the current.
- **Snapping** is computed app-side from retained geometry (the renderer's built-in
  snap is unreliable on batched geometry), which is why the snap methods are fully
  selectable and the glyphs are precise.
- The Cesium globe is **token-free** (no Cesium ion access token). Horizontal
  Stereo 70 → WGS84 uses a 7-parameter Helmert (≈ sub-2 m) — fine for context, not a
  cadastral-grade grid transform.
- The model is parsed client-side, so very large IFC files take longer to open.
- The Location map embeds OpenStreetMap and the map/Earth links open external sites, so
  that card needs network access (it simply stays empty offline).
