/**
 * generate-centerlines.js
 *
 * Convierte ciclorrutas_simplified.geojson (Polygon)
 * a ciclorrutas_centerlines.geojson (LineString).
 *
 * Algoritmo para rectángulos de 4 vértices:
 *   1. Calcular longitud de los 4 lados
 *   2. Los 2 lados más cortos = tapas del corredor (extremos del segmento)
 *   3. Centerline = midpoint(tapa1) → midpoint(tapa2)
 *
 * Uso: node generate-centerlines.js
 * Output: src/assets/ciclorrutas_centerlines.geojson
 */

const fs = require('fs');
const path = require('path');

const INPUT  = path.join(__dirname, 'src/assets/ciclorrutas_simplified.geojson');
const OUTPUT = path.join(__dirname, 'src/assets/ciclorrutas_centerlines.geojson');

// ── Utilidades ────────────────────────────────────────────────────────────────

function distM(a, b) {
  const cosLat = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  const dx = (b[0] - a[0]) * 111320 * cosLat;
  const dy = (b[1] - a[1]) * 111320;
  return Math.hypot(dx, dy);
}

function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Extrae la centerline de un polígono.
 * Para rectángulos (4 vértices): midpoints de los 2 lados más cortos.
 * Para polígonos con más vértices: PCA slice-and-midpoint simplificado.
 */
function extractCenterline(ring) {
  // Eliminar duplicado de cierre
  const pts = (ring[0][0] === ring[ring.length-1][0] && ring[0][1] === ring[ring.length-1][1])
    ? ring.slice(0, -1)
    : ring;

  if (pts.length < 3) return pts.length === 2 ? pts : [pts[0], pts[0]];

  if (pts.length === 4) {
    // Rectángulo simple: encontrar los 2 lados más cortos (tapas)
    const sides = [
      { i: 0, j: 1, len: distM(pts[0], pts[1]) },
      { i: 1, j: 2, len: distM(pts[1], pts[2]) },
      { i: 2, j: 3, len: distM(pts[2], pts[3]) },
      { i: 3, j: 0, len: distM(pts[3], pts[0]) },
    ].sort((a, b) => a.len - b.len);

    const cap1 = sides[0];
    const cap2 = sides[1];

    // Los dos lados más cortos son las tapas — sus midpoints son los extremos del eje
    return [
      midpoint(pts[cap1.i], pts[cap1.j]),
      midpoint(pts[cap2.i], pts[cap2.j]),
    ];
  }

  // Para polígonos con más vértices: PCA simplificado
  const n = pts.length;
  const meanLng = pts.reduce((s, p) => s + p[0], 0) / n;
  const meanLat = pts.reduce((s, p) => s + p[1], 0) / n;
  const cosLat = Math.cos((meanLat * Math.PI) / 180);
  const centered = pts.map(p => [(p[0] - meanLng) * cosLat, p[1] - meanLat]);

  let cxx = 0, cxy = 0, cyy = 0;
  for (const [x, y] of centered) { cxx += x*x; cxy += x*y; cyy += y*y; }
  cxx /= n; cxy /= n; cyy /= n;

  const trace = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, trace*trace/4 - det));
  const lambda1 = trace/2 + disc;
  let axisX = cxy, axisY = lambda1 - cxx;
  const axisLen = Math.sqrt(axisX*axisX + axisY*axisY);
  if (axisLen < 1e-12) { axisX = 1; axisY = 0; }
  else { axisX /= axisLen; axisY /= axisLen; }
  const perpX = -axisY, perpY = axisX;

  const projs = centered.map(([x, y]) => x*axisX + y*axisY);
  const minProj = Math.min(...projs);
  const maxProj = Math.max(...projs);
  const spanDeg = maxProj - minProj;
  const spanM = spanDeg * 111320;
  const N_SLICES = Math.min(50, Math.max(2, Math.round(spanM / 10)));
  const clPoints = [];

  for (let i = 0; i <= N_SLICES; i++) {
    const proj = minProj + (i / N_SLICES) * spanDeg;
    const perps = [];
    for (let j = 0; j < pts.length; j++) {
      const [x1,y1] = centered[j];
      const [x2,y2] = centered[(j+1) % pts.length];
      const p1 = x1*axisX + y1*axisY;
      const p2 = x2*axisX + y2*axisY;
      if ((p1 <= proj && p2 > proj) || (p2 <= proj && p1 > proj)) {
        const t = (proj-p1)/(p2-p1);
        const ix = x1 + t*(x2-x1), iy = y1 + t*(y2-y1);
        perps.push(ix*perpX + iy*perpY);
      }
    }
    if (perps.length < 2) continue;
    const midPerp = (Math.min(...perps) + Math.max(...perps)) / 2;
    const cx = proj*axisX + midPerp*perpX;
    const cy = proj*axisY + midPerp*perpY;
    clPoints.push([meanLng + cx/cosLat, meanLat + cy]);
  }

  return clPoints.length >= 2 ? clPoints : [pts[projs.indexOf(minProj)], pts[projs.indexOf(maxProj)]];
}

// ── Encadenamiento de segmentos ───────────────────────────────────────────────
// Conecta segmentos cuyos extremos están a < SNAP_M metros → LineStrings continuos

const SNAP_M = 3.0; // umbral de conexión entre segmentos adyacentes

function snapDist(a, b) {
  return distM(a, b);
}

function chainSegments(segments) {
  // segments: array de [[lng,lat],[lng,lat]] (2-point centerlines)
  // Construir grafo de adyacencia por extremos

  const used = new Array(segments.length).fill(false);
  const chains = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;

    const chain = [...segments[start]];
    used[start] = true;

    // Extender hacia adelante desde el último punto
    let extended = true;
    while (extended) {
      extended = false;
      const tail = chain[chain.length - 1];
      for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        const [s, e] = segments[i];
        if (snapDist(tail, s) < SNAP_M) {
          chain.push(e);
          used[i] = true;
          extended = true;
          break;
        }
        if (snapDist(tail, e) < SNAP_M) {
          chain.push(s);
          used[i] = true;
          extended = true;
          break;
        }
      }
    }

    // Extender hacia atrás desde el primer punto
    extended = true;
    while (extended) {
      extended = false;
      const head = chain[0];
      for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        const [s, e] = segments[i];
        if (snapDist(head, s) < SNAP_M) {
          chain.unshift(e);
          used[i] = true;
          extended = true;
          break;
        }
        if (snapDist(head, e) < SNAP_M) {
          chain.unshift(s);
          used[i] = true;
          extended = true;
          break;
        }
      }
    }

    if (chain.length >= 2) chains.push(chain);
  }

  return chains;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('Leyendo', INPUT);
const data = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
console.log('Features:', data.features.length);

console.log('Extrayendo centerlines...');
const segments = [];
let skipped = 0;
for (const f of data.features) {
  const ring = f.geometry.coordinates[0];
  const cl = extractCenterline(ring);
  if (distM(cl[0], cl[cl.length-1]) < 0.5) { skipped++; continue; } // degenerate
  segments.push(cl.length === 2 ? cl : cl); // keep multi-point for PCA features
}
console.log('Segmentos válidos:', segments.length, '| Descartados:', skipped);

console.log('Encadenando segmentos (SNAP_M =', SNAP_M, 'm)...');
// Separar segmentos de 2 puntos (rectángulos) de multi-punto (PCA)
const twoPoint = segments.filter(s => s.length === 2);
const multiPoint = segments.filter(s => s.length > 2);

const chains = chainSegments(twoPoint);
// Los multi-punto se añaden directamente como LineStrings individuales
const allLines = [...chains, ...multiPoint];

console.log('LineStrings generadas:', allLines.length);

const geojson = {
  type: 'FeatureCollection',
  _metadata: {
    fuente: 'Generado desde ciclorrutas_simplified.geojson (IDECA)',
    algoritmo: 'midpoint-of-short-sides para rectángulos + PCA para polígonos complejos + chain snap 3m',
    fecha: new Date().toISOString().split('T')[0],
    geometry_type: 'LineString',
  },
  features: allLines.map((coords, i) => ({
    type: 'Feature',
    properties: { id: i },
    geometry: { type: 'LineString', coordinates: coords },
  })),
};

fs.writeFileSync(OUTPUT, JSON.stringify(geojson));
const sizeKB = Math.round(fs.statSync(OUTPUT).size / 1024);
console.log('✅ Escrito:', OUTPUT, '|', sizeKB, 'KB |', allLines.length, 'LineStrings');
