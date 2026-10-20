// One painting, bent by code. Round 07's idea (a painted figure with bones and continuous skin weights), rebuilt so
// the painted pose is exact: the mesh is a fine grid laid over the painting's own pixels and the silhouette comes from
// the texture's alpha, so at rest every pixel sits where it was painted and thin things (the wand) stay crisp.
//
// Skinning is forward kinematics with blended angles rather than blended matrices: a vertex with weight w on a joint
// turns by w·θ about that joint's painted position, distal joints first. Weights are continuous (smooth polygons and
// cut lines), so there are no hinge seams or holes, only a soft fan of paint where a joint opens; large turns never
// collapse the way linear-blend skinning does. Faces carry no arm weight. Coordinates are painted canvas pixels
// (x right, y down); angles are degrees, positive clockwise on screen.
import * as T from '../vendor/three.module.js';

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const D2R = Math.PI / 180;

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
// signed distance to a polygon, positive inside
export function polyDistance(p, poly) {
  let inside = false, best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    best = Math.min(best, segDist(p, a, b));
  }
  return inside ? best : -best;
}
const inEllipse = (p, e) => ((p[0] - e.at[0]) / e.r[0]) ** 2 + ((p[1] - e.at[1]) / e.r[1]) ** 2;

// The weight of each joint of a chain at a painted point. Joint 0's weight is the chain's region (a polygon with a
// soft edge; its edge across the root of the limb is the cut). Each later joint multiplies in a soft cut line across
// the limb at that joint, so everything beyond the joint turns with it.
function keepWeight(p, keep = []) {
  let weight = 1;
  for (const shape of keep) {
    if (shape.polygon) {
      // Zero throughout the polygon AND its margin. Fade only outside that protected footprint,
      // so triangles touching rigid paint cannot interpolate a moving corner into the laptop.
      const outside = -polyDistance(p, shape.polygon);
      weight *= smooth(shape.margin || 0, (shape.margin || 0) + shape.soft, outside);
    } else {
      weight *= smooth(1, 1.6, inEllipse(p, shape));
    }
  }
  return weight;
}

export function chainWeights(chain, p, keep = []) {
  let base = smooth(-chain.soft, chain.soft, polyDistance(p, chain.region));
  base *= keepWeight(p, keep) * keepWeight(p, chain.keep);
  const out = [base];
  for (let k = 1; k < chain.joints.length; k++) {
    // the cut runs along the bisector of the joint's angle, so a sharply bent knee still splits thigh from shin
    const P = chain.joints[k - 1].at, J = chain.joints[k].at, N = (chain.joints[k + 1] || { at: chain.end }).at;
    const a = Math.hypot(J[0] - P[0], J[1] - P[1]), b = Math.hypot(N[0] - J[0], N[1] - J[1]);
    let nx = (J[0] - P[0]) / a + (N[0] - J[0]) / b, ny = (J[1] - P[1]) / a + (N[1] - J[1]) / b;
    const nl = Math.hypot(nx, ny); nx /= nl; ny /= nl;
    const along = (p[0] - J[0]) * nx + (p[1] - J[1]) * ny;
    const band = chain.joints[k].band;
    out.push(base * smooth(-band, band, along));
  }
  return out;
}

// turn point (x, y) through a chain's joints, distal first, each by its weight times its angle
function turn(chain, w, angles, x, y) {
  for (let k = chain.joints.length - 1; k >= 0; k--) {
    const a = (angles[k] || 0) * w[k] * D2R; if (!a) continue;
    const [cx, cy] = chain.joints[k].at, c = Math.cos(a), s = Math.sin(a), dx = x - cx, dy = y - cy;
    x = cx + dx * c - dy * s; y = cy + dx * s + dy * c;
  }
  return [x, y];
}

// Deform one painted point (with its own weights) for a pose. pose.chains[name] = [angles], pose.sway = {amp, t}.
export function deformPoint(def, weights, sway, pose, x, y) {
  let ox = x, oy = y;
  for (let c = 0; c < def.chains.length; c++) {
    const chain = def.chains[c], angles = pose.chains[chain.name]; if (!angles) continue;
    const [nx, ny] = turn(chain, weights[c], angles, x, y);
    ox += nx - x; oy += ny - y;
  }
  if (sway && pose.sway && pose.sway.amp) {
    const { amp, t } = pose.sway, ph = x * 0.011 + y * 0.006;
    ox += amp * sway * Math.sin(t * 1.15 + ph);
    oy += amp * sway * 0.45 * Math.sin(t * 0.83 + ph * 1.7 + 1.1);
  }
  return [ox, oy];
}

export function swayWeight(def, p) {
  if (!def.sway) return 0;
  let w = smooth(-def.sway.soft, def.sway.soft, polyDistance(p, def.sway.region));
  w *= keepWeight(p, def.keep) * keepWeight(p, def.sway.keep);
  return w;
}

// Textures are sampled half a mip level sharper than WebGL's default (a -0.5 LOD bias): the HD paintings are drawn
// at about 0.75 of their pixels on a 2x screen, where plain trilinear filtering would already blend in the half-size
// level and give back most of the blur the extra pixels removed.
export function sharpen(material, bias = -0.5) {
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
      T.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', `texture( map, vMapUv, ${bias.toFixed(2)} )`));
  };
  material.customProgramCacheKey = () => `sharpen${bias}`;
  return material;
}

// Build the mesh for one character from its decoded image (the cropped painting, at 1x or HD) and its definition.
// The mesh, its weights and the crop are in painted 1536-canvas pixels whatever the image's own resolution.
export function createPainting(def, image, crop) {
  const [X0, Y0, CW, CH] = crop, g = def.grid;
  const can = document.createElement('canvas'); can.width = CW; can.height = CH;
  const ctx = can.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0, CW, CH);
  const alpha = ctx.getImageData(0, 0, CW, CH).data;
  // a cell is part of the figure if any pixel in it (or one pixel around it) has alpha
  const nx = Math.ceil(CW / g), ny = Math.ceil(CH / g), solid = new Uint8Array(nx * ny);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    if (!alpha[4 * (y * CW + x) + 3]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const i = Math.floor((x + dx) / g), j = Math.floor((y + dy) / g);
      if (i >= 0 && j >= 0 && i < nx && j < ny) solid[j * nx + i] = 1;
    }
  }
  const index = new Map(), rest = [], uv = [];
  const vert = (i, j) => {
    const key = j * (nx + 1) + i; if (index.has(key)) return index.get(key);
    const x = X0 + Math.min(i * g, CW), y = Y0 + Math.min(j * g, CH);
    index.set(key, rest.length / 2); rest.push(x, y); uv.push((x - X0) / CW, 1 - (y - Y0) / CH);
    return index.get(key);
  };
  const tris = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!solid[j * nx + i]) continue;
    const a = vert(i, j), b = vert(i + 1, j), c = vert(i + 1, j + 1), d = vert(i, j + 1);
    if ((i + j) & 1) tris.push([a, d, b], [b, d, c]); else tris.push([a, d, c], [a, c, b]);
  }
  const n = rest.length / 2;
  const weights = [], sway = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const p = [rest[2 * v], rest[2 * v + 1]];
    weights.push(def.chains.map(chain => chainWeights(chain, p, def.keep)));
    sway[v] = swayWeight(def, p);
  }
  // painter's order inside the figure: each chain sits in front of (layer > 0) or behind (layer < 0) the body,
  // and the more a triangle belongs to it, the further forward or back it goes
  const key = t => {
    let k = 0;
    def.chains.forEach((chain, c) => { k += chain.layer * Math.max(weights[t[0]][c][0], weights[t[1]][c][0], weights[t[2]][c][0]); });
    return k;
  };
  tris.sort((s, t) => key(s) - key(t));
  // silhouette vertices: on the boundary between figure cells and empty cells (the deformed figure's extent)
  const edge = new Set();
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    let on = 0, off = 0;
    for (const [di, dj] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < nx && jj < ny && solid[jj * nx + ii]) on++; else off++;
    }
    if (on && off) edge.add(j * (nx + 1) + i);
  }
  const outline = [...edge].map(k => index.get(k)).filter(v => v !== undefined);

  const [px, py] = def.pivot;
  const positions = new Float32Array(n * 3);
  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.BufferAttribute(positions, 3).setUsage(T.DynamicDrawUsage));
  geometry.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  geometry.setIndex(tris.flat());
  const texture = new T.Texture(image);
  texture.colorSpace = T.SRGBColorSpace; texture.anisotropy = 4; texture.needsUpdate = true;
  const material = sharpen(new T.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, side: T.DoubleSide }));
  const mesh = new T.Mesh(geometry, material);
  mesh.frustumCulled = false; mesh.renderOrder = def.order; mesh.name = def.name;
  const group = new T.Group(); group.add(mesh); group.name = def.name + ' painting';

  const rig = {
    def, group, mesh, rest, weights, sway, outline, n, triangles: tris.length,
    // weights for an arbitrary painted point (the wand tip, the fingertip)
    weightsAt: p => def.chains.map(chain => chainWeights(chain, p, def.keep)),
    // painted point -> deformed painted point for a pose
    deform(pose, x, y, w = rig.weightsAt([x, y]), s = swayWeight(def, [x, y])) { return deformPoint(def, w, s, pose, x, y); },
    // painted (deformed) point -> local mesh coordinates
    local: (x, y) => [x - px, -(y - py)],
    pose(pose) {
      for (let v = 0; v < n; v++) {
        const [x, y] = deformPoint(def, weights[v], sway[v], pose, rest[2 * v], rest[2 * v + 1]);
        positions[3 * v] = x - px; positions[3 * v + 1] = -(y - py); positions[3 * v + 2] = 0;
      }
      geometry.attributes.position.needsUpdate = true;
    },
    // the group sits so that, unrotated and unmoved, every vertex lands on its painted place (world x = painted x,
    // world y = -painted y). Offsets are painted pixels; roll and yaw are degrees about the pivot.
    place(state) {
      group.position.set(px + state.x, -(py + state.y), 0);
      group.rotation.set(0, (state.yaw || 0) * D2R, -(state.roll || 0) * D2R);
    },
    dispose() { geometry.dispose(); material.dispose(); texture.dispose(); },
  };
  return rig;
}
