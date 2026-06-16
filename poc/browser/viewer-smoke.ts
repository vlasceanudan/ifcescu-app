// Headless smoke for the WebGPU ViewerEngine: load a model, build the tree,
// render, screenshot. Confirms Phase 3 works in a real browser.
import { ViewerEngine } from "../../src/viewer/engine";
import { buildTree, getSelectionProps } from "../../src/viewer/model";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const w = window as any;

(async () => {
  if (!("gpu" in navigator) || !(navigator as any).gpu) {
    w.__ERR = "no webgpu";
    w.__DONE = true;
    return;
  }
  const which = new URLSearchParams(location.search).get("m") ?? "plan";
  const engine = new ViewerEngine(canvas);
  await engine.init();
  engine.resize();
  const bytes = new Uint8Array(await (await fetch("/sample/" + which)).arrayBuffer());
  const { store, allIDs } = await engine.load(bytes);
  const tree = buildTree(store, new Set(allIDs));
  // Selection props for the first element with geometry.
  let propGroups = 0;
  let headerType = "";
  if (allIDs.length) {
    const sp = getSelectionProps(store, allIDs[0]);
    propGroups = sp.groups.length;
    headerType = sp.header.type;
  }
  await new Promise((r) => setTimeout(r, 500));
  // Section clip test: does enabling a section change the rendered image?
  const shotNoSec = await engine.screenshot();
  const mb = engine.modelBounds();
  if (mb) engine.orientSection([0, 1, 0], [(mb.min[0] + mb.max[0]) / 2, (mb.min[1] + mb.max[1]) / 2, (mb.min[2] + mb.max[2]) / 2]);
  await new Promise((r) => setTimeout(r, 600));
  const shotSec = await engine.screenshot();
  engine.clearSection();

  // Snap test: aim at the vertex nearest screen-centre.
  const cam = engine.renderer.getCamera();
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const g0 = (engine as any).geom.get(allIDs[0])?.[0];
  let bx = cw / 2, by = ch / 2, bd = 1e9;
  if (g0) {
    for (let i = 0; i < g0.pos.length; i += 3) {
      const sp = cam.projectToScreen({ x: g0.pos[i], y: g0.pos[i + 1], z: g0.pos[i + 2] }, cw, ch);
      if (!sp) continue;
      const d = Math.hypot(sp.x - cw / 2, sp.y - ch / 2);
      if (d < bd) { bd = d; bx = sp.x; by = sp.y; }
    }
  }
  const r = canvas.getBoundingClientRect();
  const snapV = engine.snap(r.x + bx, r.y + by);

  w.__RESULT = {
    allIDs: allIDs.length,
    treeChildren: tree?.children.length ?? 0,
    propGroups,
    rtc: engine.rtcOffset,
    geomKeys: (engine as any).geom?.size ?? -1,
    sectionChangedImage: shotNoSec !== shotSec,
    snapType: snapV?.type ?? null,
  };
  w.__DONE = true;
})().catch((e) => {
  w.__ERR = String(e?.stack || e);
  w.__DONE = true;
});
