/**
 * centerline.ts — Extracción de eje central de polígonos elongados
 *
 * Contexto: ciclorrutas IDECA son Polygon (ancho físico ~2-5m, largo hasta ~500m).
 * DatabaseService usa extractCenterline() durante la migración inicial.
 * MapaService usa proyectarSobreSegmento() en cada tick GPS.
 *
 * Algoritmo: PCA slice-and-midpoint + Douglas-Peucker
 * Sin dependencias externas.
 */

// ============================================================
// EXTRACCIÓN DE CENTERLINE
// ============================================================

/**
 * Extrae la línea central de un polígono elongado.
 * @param ring  Anillo exterior del polígono: array de [lng, lat], cerrado (primer = último punto)
 * @returns     Array de [lng, lat] del centerline. Mínimo 2 puntos garantizado.
 */
export function extractCenterline(ring: [number, number][]): [number, number][] {
  // Eliminar duplicado de cierre si existe
  const pts: [number, number][] =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : [...ring];

  // Fallback para polígonos degenerados
  if (pts.length < 3) {
    return pts.length === 2 ? pts : [pts[0], pts[0]];
  }

  // ---- Paso 1: PCA para eje de elongación ----
  const n = pts.length;
  const meanLng = pts.reduce((s, p) => s + p[0], 0) / n;
  const meanLat = pts.reduce((s, p) => s + p[1], 0) / n;

  // cosLat normaliza longitud a metros equivalentes para que PCA sea correcto
  const cosLat = Math.cos((meanLat * Math.PI) / 180);

  const centered: [number, number][] = pts.map(
    (p) => [(p[0] - meanLng) * cosLat, p[1] - meanLat]
  );

  // Covarianza 2×2
  let cxx = 0,
    cxy = 0,
    cyy = 0;
  for (const [x, y] of centered) {
    cxx += x * x;
    cxy += x * y;
    cyy += y * y;
  }
  cxx /= n;
  cxy /= n;
  cyy /= n;

  // Autovalor mayor (forma cerrada para 2×2)
  const trace = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
  const lambda1 = trace / 2 + disc;

  // Autovector correspondiente a lambda1
  let axisX = cxy;
  let axisY = lambda1 - cxx;
  const axisLen = Math.sqrt(axisX * axisX + axisY * axisY);
  if (axisLen < 1e-12) {
    axisX = 1;
    axisY = 0;
  } else {
    axisX /= axisLen;
    axisY /= axisLen;
  }

  // Eje perpendicular
  const perpX = -axisY;
  const perpY = axisX;

  // ---- Paso 2: Rango de proyecciones sobre el eje ----
  const projs = centered.map(([x, y]) => x * axisX + y * axisY);
  const minProj = Math.min(...projs);
  const maxProj = Math.max(...projs);
  const spanDeg = maxProj - minProj;
  const spanM = spanDeg * 111320; // aprox metros a esta latitud

  // ---- Paso 3: Sampling — 1 slice cada ~10m, mínimo 3, máximo 50 ----
  const N_SLICES = Math.min(50, Math.max(3, Math.round(spanM / 10)));
  const clPoints: [number, number][] = [];

  for (let i = 0; i <= N_SLICES; i++) {
    const proj = minProj + (i / N_SLICES) * spanDeg;

    // Intersecciones del polígono con el plano perpendicular en 'proj'
    const perpIntersections: number[] = [];
    for (let j = 0; j < pts.length; j++) {
      const [x1, y1] = centered[j];
      const [x2, y2] = centered[(j + 1) % pts.length];
      const p1 = x1 * axisX + y1 * axisY;
      const p2 = x2 * axisX + y2 * axisY;

      if ((p1 <= proj && p2 > proj) || (p2 <= proj && p1 > proj)) {
        const t = (proj - p1) / (p2 - p1);
        const ix = x1 + t * (x2 - x1);
        const iy = y1 + t * (y2 - y1);
        perpIntersections.push(ix * perpX + iy * perpY);
      }
    }

    if (perpIntersections.length < 2) continue;

    const minPerp = Math.min(...perpIntersections);
    const maxPerp = Math.max(...perpIntersections);
    const midPerp = (minPerp + maxPerp) / 2;

    // Volver a coordenadas geográficas
    const cx = proj * axisX + midPerp * perpX;
    const cy = proj * axisY + midPerp * perpY;
    const lng = meanLng + cx / cosLat;
    const lat = meanLat + cy;
    clPoints.push([lng, lat]);
  }

  // Fallback si no se obtuvieron puntos (polígono muy pequeño o irregular)
  if (clPoints.length < 2) {
    const iMin = projs.indexOf(minProj);
    const iMax = projs.indexOf(maxProj);
    return [pts[iMin], pts[iMax]];
  }

  // ---- Paso 4: Douglas-Peucker leve para eliminar puntos colineales ----
  return dpSimplify(clPoints, 0.000005);
}

// ---- Douglas-Peucker ----

function dpSimplify(
  pts: [number, number][],
  epsilon: number
): [number, number][] {
  if (pts.length <= 2) return pts;

  const start = pts[0];
  const end = pts[pts.length - 1];
  let maxDist = 0,
    maxIdx = 0;

  for (let i = 1; i < pts.length - 1; i++) {
    const d = pointToSegmentDist(pts[i], start, end);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = dpSimplify(pts.slice(0, maxIdx + 1), epsilon);
    const right = dpSimplify(pts.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [start, end];
}

function pointToSegmentDist(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-20) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)
  );
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// ============================================================
// WKT SERIALIZACIÓN / DESERIALIZACIÓN
// ============================================================

export function toWKTLineString(pts: [number, number][]): string {
  return (
    'LINESTRING(' +
    pts.map((p) => `${p[0].toFixed(5)} ${p[1].toFixed(5)}`).join(', ') +
    ')'
  );
}

export function fromWKTLineString(wkt: string): [number, number][] {
  const inner = wkt.replace(/^LINESTRING\s*\(/, '').replace(/\)$/, '');
  return inner.split(',').map((pair) => {
    const [lng, lat] = pair.trim().split(/\s+/).map(Number);
    return [lng, lat] as [number, number];
  });
}

// ============================================================
// SNAP-TO-SEGMENT
// ============================================================

export function proyectarSobreSegmento(
  gps: [number, number],
  centerline: [number, number][]
): [number, number] {
  let minDist = Infinity;
  let closest: [number, number] = centerline[0];

  for (let i = 0; i < centerline.length - 1; i++) {
    const proj = projectPointOntoEdge(gps, centerline[i], centerline[i + 1]);
    const d = Math.hypot(gps[0] - proj[0], gps[1] - proj[1]);
    if (d < minDist) {
      minDist = d;
      closest = proj;
    }
  }

  return closest;
}

function projectPointOntoEdge(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): [number, number] {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-20) return a;
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)
  );
  return [a[0] + t * dx, a[1] + t * dy];
}

// ============================================================
// LONGITUD DE CENTERLINE
// ============================================================

export function calcularLongitudCenterlineM(
  pts: [number, number][]
): number {
  let total = 0;
  const R = 6371000;
  for (let i = 0; i < pts.length - 1; i++) {
    const [lng1, lat1] = pts[i];
    const [lng2, lat2] = pts[i + 1];
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    total += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return total;
}
