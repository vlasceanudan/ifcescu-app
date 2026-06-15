// Extract and merge an IFC model's geometry from web-ifc into one buffer, in
// IFC model coordinates (Z-up; X≈East, Y≈North, Z=up). Used by the globe view
// to re-render the model on the Cesium globe.
//
// web-ifc's GetVertexArray returns interleaved position+normal (6 floats/vtx);
// each placed geometry carries a 4x4 flatTransformation (column-major) into
// model space. Positions are kept as Float64 so large "real-coordinate" models
// (E≈400–700k) survive before localisation.
import type { IfcAPI } from "web-ifc";

export interface MergedMesh {
  positions: Float64Array; // x,y,z … in IFC model coordinates
  normals: Float32Array; // nx,ny,nz …
  colors: Uint8Array; // r,g,b,a per vertex (0–255) from the IFC surface styles
  indices: Uint32Array;
  bbox: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  vertexCount: number;
  triangleCount: number;
}

interface Chunk {
  pos: Float64Array;
  nrm: Float32Array;
  idx: Uint32Array;
  base: number; // vertex offset for this chunk's indices
  rgba: [number, number, number, number]; // 0–255, this geometry's colour
}

export function extractMergedMesh(api: IfcAPI, modelID: number): MergedMesh {
  // Cache raw (local) geometry per geometryExpressID — geometries are instanced.
  const rawCache = new Map<number, { verts: Float32Array; idx: Uint32Array }>();
  const chunks: Chunk[] = [];
  let totalVerts = 0;
  let totalIdx = 0;

  api.StreamAllMeshes(modelID, (flatMesh: any) => {
    const geoms = flatMesh.geometries;
    for (let i = 0; i < geoms.size(); i++) {
      const placed = geoms.get(i);
      let raw = rawCache.get(placed.geometryExpressID);
      if (!raw) {
        const g = api.GetGeometry(modelID, placed.geometryExpressID);
        const verts = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
        const idx = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
        // Copy out of WASM heap (the views become invalid after free).
        raw = { verts: new Float32Array(verts), idx: new Uint32Array(idx) };
        rawCache.set(placed.geometryExpressID, raw);
      }
      const m = placed.flatTransformation as number[]; // column-major 4x4
      const n = raw.verts.length / 6;
      const pos = new Float64Array(n * 3);
      const nrm = new Float32Array(n * 3);
      for (let v = 0; v < n; v++) {
        const x = raw.verts[v * 6], y = raw.verts[v * 6 + 1], z = raw.verts[v * 6 + 2];
        const nx = raw.verts[v * 6 + 3], ny = raw.verts[v * 6 + 4], nz = raw.verts[v * 6 + 5];
        // web-ifc core returns geometry Y-up (X=East, Y=Up, Z=-North). Convert to
        // IFC convention (X=East, Y=North, Z=Up) — a +90° rotation about X, which
        // preserves winding/normals — so placement uses true IFC coordinates.
        const ex = m[0] * x + m[4] * y + m[8] * z + m[12];
        const ey = m[1] * x + m[5] * y + m[9] * z + m[13];
        const ez = m[2] * x + m[6] * y + m[10] * z + m[14];
        pos[v * 3] = ex;        // East
        pos[v * 3 + 1] = -ez;   // North
        pos[v * 3 + 2] = ey;    // Up
        // Normals by the 3x3 rotation part (assume ~uniform scale), normalised.
        let tx = m[0] * nx + m[4] * ny + m[8] * nz;
        let ty = m[1] * nx + m[5] * ny + m[9] * nz;
        let tz = m[2] * nx + m[6] * ny + m[10] * nz;
        const len = Math.hypot(tx, ty, tz) || 1;
        nrm[v * 3] = tx / len;
        nrm[v * 3 + 1] = -tz / len;
        nrm[v * 3 + 2] = ty / len;
      }
      const col = placed.color; // { x, y, z, w } floats 0–1
      const to255 = (c: number) => Math.max(0, Math.min(255, Math.round((c ?? 0) * 255)));
      chunks.push({
        pos, nrm, idx: raw.idx, base: totalVerts,
        rgba: [to255(col?.x), to255(col?.y), to255(col?.z), col?.w != null ? to255(col.w) : 255],
      });
      totalVerts += n;
      totalIdx += raw.idx.length;
    }
  });

  // Concatenate chunks into final buffers, offsetting indices.
  const positions = new Float64Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Uint8Array(totalVerts * 4);
  const indices = new Uint32Array(totalIdx);
  let pOff = 0, iOff = 0;
  const bbox = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const ch of chunks) {
    positions.set(ch.pos, pOff * 3);
    normals.set(ch.nrm, pOff * 3);
    const vCount = ch.pos.length / 3;
    for (let v = 0; v < vCount; v++) {
      const o = (pOff + v) * 4;
      colors[o] = ch.rgba[0]; colors[o + 1] = ch.rgba[1]; colors[o + 2] = ch.rgba[2]; colors[o + 3] = ch.rgba[3];
    }
    for (let k = 0; k < ch.idx.length; k++) indices[iOff + k] = ch.idx[k] + ch.base;
    for (let v = 0; v < ch.pos.length; v += 3) {
      const x = ch.pos[v], y = ch.pos[v + 1], z = ch.pos[v + 2];
      if (x < bbox.minX) bbox.minX = x; if (x > bbox.maxX) bbox.maxX = x;
      if (y < bbox.minY) bbox.minY = y; if (y > bbox.maxY) bbox.maxY = y;
      if (z < bbox.minZ) bbox.minZ = z; if (z > bbox.maxZ) bbox.maxZ = z;
    }
    pOff += vCount;
    iOff += ch.idx.length;
  }

  return { positions, normals, colors, indices, bbox, vertexCount: totalVerts, triangleCount: totalIdx / 3 };
}
