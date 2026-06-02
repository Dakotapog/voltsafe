/**
 * haversine.ts — Distancia entre dos puntos geográficos en metros.
 *
 * Función compartida reutilizada en:
 * - MapaService (Nodo 04) — snap-to-segment
 * - ZonasService (Nodo 06) — geofencing
 * - UltimaMillaService (Nodo 09) — estación TM más cercana
 * - GeneroService (Nodo 14) — georreferenciación de reportes
 * - GeoService — filtro de velocidad física (GPS-Precision-Strategy)
 *
 * Sin dependencias externas.
 */

const R = 6371000; // Radio de la Tierra en metros

export function haversine(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
