# POC @ifc-lite — rezultate & decizie

Rulat headless (vitest/Node) pe două modele reale, ambele cu `IfcMapConversion`:
- **plan** — `IFC Plan de situatie App/Ridicare topo IFC_v0_IFC4X3_ADD2.ifc` (233 KB, IFC4X3, georeferențiat) — cazul real.
- **large** — `SP4 IFC/230515_C3D_BIM_Sibiu_Pitesti-IFC4.ifc` (52,8 MB, IFC4).

Pachete: `@ifc-lite/parser@3.2.0`, `@ifc-lite/geometry@2.7.1`, `@ifc-lite/export@1.19.8`,
`@ifc-lite/mutations@1.15.4`, `@ifc-lite/wasm@2.9.0`. Rulează: `npx vitest run poc/`.

> **Constatare-cheie de mediu:** WASM-ul geometriei `@ifc-lite` **rulează headless** după
> un mic bootstrap (vezi `wasm-init.ts`) — nu a fost nevoie de pagină browser pentru (a) și (c).
> Dar pentru (b), calea sincronă din Node NU e reprezentativă (vezi mai jos).

---

## (a) Paritate georef — ✅ GO

3 surse comparate: RAW (regex pe textul STEP) vs web-ifc (`IfcEditor.getGeoref()`) vs `@ifc-lite` (`extractGeoreferencingOnDemand`).

| Model | eastings | northings | height | CRS | verdict |
|---|---|---|---|---|---|
| plan | `787661.492898342` (toate 3 identice) | `308909.688248943` | `20.18` | `EPSG:3844` | **paritate exactă** |
| large | `0` (origine 0,0,0; georef prin nume CRS) | `0` | `0` | `EPSG:3844` | paritate |

`@ifc-lite` citește **precizia completă** (15 cifre semnificative) — exact criteriul nenegociabil.
Bonus: extrage și `description` ("Pulkovo 1942(58) / Stereo70"), `geodeticDatum`, `mapProjection`, `mapUnit`/`mapUnitScale` — mai bogat decât pipeline-ul actual.

## (b) Timpi parse + geometrie — ⛔ web-ifc câștigă la viteză brută; @ifc-lite câștigă la responsivitate

**Rezolvat în browser real** (Chrome headless, **WebGPU + crossOriginIsolated + SharedArrayBuffer**,
12 cores, 5 workers) — calea performantă reală `@ifc-lite` (`processParallel`). Vezi
`poc/browser/` și `bench-output.log`.

### Model mare (52,8 MB, IFC4, ~380k triunghiuri) — semnalul real

| engine / mode | parse(ms) | geom(ms) | **total(ms)** | first-frame(ms) | tris |
|---|---|---|---|---|---|
| web-ifc (main-thread) | 482 | 1.184 | **1.666** | 1.184 | 375.622 |
| @ifc-lite sync `process()` | 1.080 | 26.628 | 27.708 | 26.628 | 382.103 |
| @ifc-lite **`processParallel`** (5 workers) | 1.080 | 7.109 | **8.189** | **1.088** | 382.052 |

### Model plan (0,2 MB, IFC4X3, 88 triunghiuri) — prea mic, dominat de overhead

| engine / mode | total(ms) |
|---|---|
| web-ifc | 49 |
| @ifc-lite sync | 88 |
| @ifc-lite parallel | 267 (overhead de spawn workers) |

### Interpretare (onest)
- **Viteză brută: web-ifc câștigă net.** Chiar și pe calea paralelă cu 12 cores, `@ifc-lite`
  e **~5× mai lent la geometrie** (7,1 s vs 1,2 s) și **~5× pe total** (8,2 s vs 1,7 s) pe
  modelul tău mare. **Claim-ul „5× faster than web-ifc" NU se confirmă pe modelele tale — e invers.**
  (Ambele engine-uri instanțiază geometria: prepass-ul `@ifc-lite` a redus 913.869 entități la
  4.964 job-uri de geometrie; web-ifc cache-uiește per `geometryExpressID`. Comparație corectă.)
- **Responsivitate: `@ifc-lite` câștigă.** Geometria rulează **off-main-thread** (workers) și
  **streaming**: prima geometrie apare la **~1,1 s** și UI-ul rămâne liber tot timpul. web-ifc
  (`extractMergedMesh` / web-ifc-viewer, cum face aplicația ta acum) **blochează main thread-ul ~1,7 s**
  → UI înghețat. Pe modele și mai mari, diferența de percepție crește.

→ **Verdict (b):** migrarea geometriei pe `@ifc-lite` **NU se justifică prin viteză** (web-ifc e
mai rapid pe modelele tale). Se justifică **doar** dacă vrei UI non-blocant + încărcare
progresivă. Dar un câștig de responsivitate mai ieftin e să muți **geometria web-ifc actuală
într-un Web Worker** (vezi quick win-ul #1 din analiză) — mai puțin risc decât schimbarea
întregului engine de randare.

> Avertisment de reprezentativitate: modelul mare are geometrie brep „murdară" (web-ifc scoate
> sute de `No basis found for brep!`), iar planul e IFC4X3 topo cu foarte puține solide — nu sunt
> cazul ideal pentru niciun engine. Dar **sunt modelele tale reale**, deci verdictul ține pentru cazul tău.

## (c) Round-trip export non-destructiv — ✅ GO

`exportToStep` / `StepExporter` regenerează STEP din store, editând liniile root in-place.

| Test | rezultat |
|---|---|
| Re-export pur (plan, 3103 records) | **3103/3103 identice** (token-level), 0 differ, 0 dropped — **100%** |
| Precizie easting `787661.492898342` | **păstrată** verbatim |
| Numere malformate (`E+09.` ca la web-ifc 0.0.39) | **niciunul** |
| Cu mutație `IfcProject.Name` → "POC-RENAMED" | aplicată; `modifiedEntityCount:1`; precizia + restul liniilor intacte |

> Notă: comparația e token-level (ignoră whitespace). `@ifc-lite` poate reformata
> spațierea, dar **valorile și precizia sunt identice** — singurul lucru care contează
> (whitespace e nesemnificativ în STEP; fișierul se deschide curat în alte viewere).

**Implicație:** `@ifc-lite/export` reproduce nativ garanția non-destructivă. Hack-ul de splice
din `IfcEditor.export()` exista **doar** ca să ocolească serializatorul stricat din web-ifc 0.0.39
— `@ifc-lite` nu are acea problemă. Exportul poate fi **înlocuit complet**.

---

## Verdict & recomandare

| Criteriu | Prag | Rezultat |
|---|---|---|
| (a) Georef precizie completă | GO obligatoriu | ✅ **GO** |
| (b) Timpi ≥ web-ifc pe model mare | GO | ⛔ **NU** (web-ifc ~5× mai rapid; @ifc-lite câștigă doar la responsivitate) |
| (c) Export non-destructiv reproductibil | GO sau hibrid | ✅ **GO (complet)** |

**Decizie: GO pentru adoptarea `@ifc-lite` la parse + citire georef + editare/export** (criteriile
care țin de logica ta de domeniu sunt verzi, inclusiv precizia — nenegociabilul). Faza 2
(**IDS + BCF**) este **deblocată**.

**Geometria/randarea: NU migra pe argumentul vitezei.** Benchmark-ul în browser (workers +
WebGPU, măsurat real) arată web-ifc **~5× mai rapid** pe modelele tale; „5× faster" nu se confirmă.
Migrarea randării pe `@ifc-lite` se justifică **doar** dacă prioritatea e UI non-blocant +
încărcare progresivă (`@ifc-lite` rulează off-main-thread, prima geometrie la ~1 s, fără freeze).
- Dacă vrei doar responsivitate, **mută geometria web-ifc actuală într-un Web Worker** (quick win,
  risc mic) — păstrezi viteza web-ifc ȘI deblochezi UI-ul, fără să schimbi engine-ul de randare.
- Rămâi pe **three.js + web-ifc-viewer** pentru randare (hibrid).

**Cale recomandată cu cel mai mic risc:**
1. Înlocuiește splice-ul cu `@ifc-lite/export` + citirea georef (dovedite GO).
2. Adaugă query/filtrare + **IDS/BCF** pe store-ul columnar `@ifc-lite`.
3. Pentru responsivitate la modele mari: web-ifc într-un worker (nu schimbi randarea).
4. NU migra randarea pe WebGPU `@ifc-lite` — fără câștig de viteză pe cazul tău, risc mare.
