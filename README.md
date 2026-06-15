# Plan de situație IFC — web app

A fully client-side web app to enrich a *plan de situație* IFC file with project,
beneficiary, land-registration and address metadata, and to inspect it in an
interactive 3D viewer. Everything runs **in the browser** — IFC parsing, editing
and export via [web-ifc](https://github.com/ThatOpen/engine_web-ifc) and 3D
rendering via [web-ifc-viewer](https://github.com/ThatOpen/web-ifc-viewer) — so
there is **no server** and it can be hosted as a static site on **GitHub Pages**.

Built with **Vite + React + TypeScript**, the buildingSMART colour palette
(magenta primary, teal/blue accents) and a light/dark theme toggle. Full-screen
app-shell layout: top bar, resizable IFC-structure tree on the left, viewer in the
centre, resizable properties panel on the right.

## Features

### 📝 Editare date (metadata editing)
- Edit project **number/name**, **beneficiary** (person or organisation — upserted,
  never duplicated), **`PSet_LandRegistration`** (LandTitleID, LandId) and
  **`PSet_Address`** (Street, Town, Region/county, PostalCode, Country) on the chosen
  `IfcSite`.
- Fields **pre-fill** from the model; light validation (postal code, land fields).
- Apply → summary of changes → **download the enriched `.ifc`**.

### 🧊 Vizualizare 3D (viewer)
- **IFC structure tree** (left, resizable): browse the spatial hierarchy; toggle
  element **visibility** (eye) and **select** straight from the tree.
- **Selection**: click an element (in the viewer or tree) → a clean **outline**
  highlight (no hover highlight); **`H`** hides the selection, **`Esc`** cancels the
  active command.
- **Properties** (right, resizable): grouped into collapsible accordions — an
  *Atribute* section plus one per property/quantity set.
- **Măsurare**: length, point and area, with AutoCAD-style **snapping** (endpoint /
  midpoint / section-intersection / on-edge) shown by a snap marker.
- **Secțiune**: clipping planes that persist while measuring; measurements snap to the
  cut and ignore hidden geometry.
- **Vizibilitate**: hide / isolate / show-all.
- **Vederi**: axonometric, top, front, back, left, right, bottom, and fit-to-model.

## Develop

```bash
npm install
npm run dev      # dev server
npm run build    # typecheck + production build to dist/
npm run preview  # serve the production build locally
npm test         # editor round-trip test (vitest)
```

> `npm test` round-trips an edit through real `web-ifc`; it needs a sample IFC —
> set `IFC_SAMPLE=<path>` or the test skips.

## Deploy to GitHub Pages

`vite.config.ts` uses `base: "./"`, so the build works at any Pages path without
changes. Push to a GitHub repo and enable **Settings → Pages → Source: GitHub
Actions**; the included [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
builds and publishes `dist/` on every push to `main`.

## Project structure

```
index.html              app entry
vite.config.ts          base "./", copies web-ifc.wasm to the site root
public/logo_bsro.svg    buildingSMART România logo (inlined; theme-aware)
src/
  App.tsx               app shell (top bar + tabs + main)
  ifc/
    editor.ts           IfcEditor: open / read / edit / export (web-ifc)
    constants.ts        counties, pset/prop names
    guid.ts             IFC GUID generator
    api.ts              shared web-ifc API (wasm path)
  components/
    Header, UploadPanel, EditorForm, Viewer, IfcTree, PropsPanel
  viewer/measure.ts     measurement tool (length/point/area + snapping)
  theme/theme.css       buildingSMART palette + light/dark
  hooks/useTheme.ts
tests/editor.test.ts    vitest round-trip test
```

## Notes

- `web-ifc` maps IFC type codes to deserializers via `Function.name`, so the build
  sets `esbuild.keepNames` in `vite.config.ts` — removing it breaks `GetLine` in the
  minified bundle.
- `web-ifc.wasm` is copied to the site root at build time and loaded via
  `import.meta.env.BASE_URL`, so it resolves at any GitHub Pages sub-path.
- The viewer loads its engine from the bundled `web-ifc-viewer`; the model is parsed
  client-side, so very large IFC files take longer to open.
