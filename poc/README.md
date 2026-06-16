# POC: `@ifc-lite` ca engine alternativ

Evaluare izolată (nu atinge `src/`) a `@ifc-lite/*` față de pipeline-ul actual
(`web-ifc` + `web-ifc-viewer`). Vezi **[RESULTS.md](RESULTS.md)** pentru concluzii și decizie.

## Rulare

```bash
npx vitest run poc/          # toată suita POC
npx vitest run poc/bench.test.ts   # doar timpii (durează ~35s pe modelul mare)
```

Modelele de test sunt fixate în `samples.ts`; suprascrie căile cu env:
```bash
POC_PLAN=/cale/model_georef.ifc POC_LARGE=/cale/model_mare.ifc npx vitest run poc/
```
Testele se sar singure (`describe.runIf`) dacă fișierele lipsesc.

## Fișiere
- `samples.ts` — căile celor 2 modele + helpere de citire.
- `wasm-init.ts` — bootstrap WASM headless pentru `@ifc-lite/geometry` (init cu bytes locali,
  altfel `__wbg_init` face `fetch` și pică în Node).
- `00-smoke.test.ts` — confirmă API-ul real `@ifc-lite` + viabilitatea headless.
- `georef-parity.test.ts` — Pasul A (criteriul critic): paritate `IfcMapConversion`.
- `bench.test.ts` — Pasul B: timpi parse+geometrie, web-ifc vs `@ifc-lite`.
- `export-roundtrip.test.ts` — Pasul C: export non-destructiv + precizie.

## Benchmark în browser (criteriul b — calea reală cu workers + WebGPU)
`poc/browser/` conține un benchmark care rulează calea performantă reală `@ifc-lite`
(`processParallel`, Web Workers + SharedArrayBuffer) vs web-ifc, într-un Chrome real.

```bash
# automat (headless, conduce Chrome via puppeteer-core, scrie cifrele în consolă):
node poc/browser/run-bench.mjs both        # plan | large | both
# manual (deschide în browser, alegi fișier sau apeși butoanele):
npx vite --config poc/browser/vite.bench.config.ts   # apoi http://localhost:5191/
```
Necesită headere COOP/COEP (setate de `vite.bench.config.ts`) pentru SharedArrayBuffer.
Rezultate + interpretare: secțiunea **(b)** din [RESULTS.md](RESULTS.md). Log brut:
`poc/browser/bench-output.log`.

## Curățare (dacă renunți la POC)
```bash
npm rm @ifc-lite/parser @ifc-lite/geometry @ifc-lite/export @ifc-lite/mutations @ifc-lite/wasm
rm -rf poc/
```

> Notă: `poc/browser/` mai folosește `puppeteer-core` (deja în devDependencies) și
> Chrome instalat local (`CHROME_PATH` pentru a suprascrie calea).
