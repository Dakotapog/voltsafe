/**
 * confidence-ring.ts — Modelo de anillos de confianza para GPS y zonas de peligro.
 *
 * GPS: el campo accuracy de @capacitor/geolocation selecciona la estrategia
 * de corrección (snap directo, verificación por dirección, historial, dead reckoning).
 *
 * Zonas: reemplaza geofencing binario (dentro/fuera) por respuesta proporcional
 * en 4 anillos de proximidad.
 *
 * Sin dependencias externas.
 */

// ============================================================
// ANILLOS DE CONFIANZA GPS
// ============================================================

export enum NivelConfianza {
  ALTA = 'ALTA',
  MEDIA = 'MEDIA',
  BAJA = 'BAJA',
  DESCARTE = 'DESCARTE',
}

export function clasificarConfianza(accuracyM: number): NivelConfianza {
  if (accuracyM < 8) return NivelConfianza.ALTA;
  if (accuracyM < 20) return NivelConfianza.MEDIA;
  if (accuracyM < 35) return NivelConfianza.BAJA;
  return NivelConfianza.DESCARTE;
}

export function radioSnapM(nivel: NivelConfianza): number {
  switch (nivel) {
    case NivelConfianza.ALTA:
      return 30;
    case NivelConfianza.MEDIA:
      return 50;
    case NivelConfianza.BAJA:
      return 80;
    case NivelConfianza.DESCARTE:
      return 0;
  }
}

// ============================================================
// ANILLOS DE PROXIMIDAD — ZONAS DE PELIGRO
// ============================================================

export enum ProximidadZona {
  DENTRO = 'DENTRO',
  ACERCANDOSE = 'ACERCANDOSE',
  CERCANO = 'CERCANO',
  LEJOS = 'LEJOS',
}

export function evaluarProximidadZona(
  distanciaM: number,
  radioZonaM: number
): ProximidadZona {
  const ratio = distanciaM / radioZonaM;
  if (ratio <= 1.0) return ProximidadZona.DENTRO;
  if (ratio <= 1.5) return ProximidadZona.ACERCANDOSE;
  if (ratio <= 2.5) return ProximidadZona.CERCANO;
  return ProximidadZona.LEJOS;
}

// ============================================================
// ACCIÓN DE UI POR PROXIMIDAD
// ============================================================

export interface AccionProximidad {
  actualizarSignal: boolean;
  vibracion: 'ninguna' | 'unica' | 'continua';
  toast: string | null;
  colorBanner: string | null;
}

export function accionPorProximidad(
  prox: ProximidadZona,
  nombreZona: string,
  distanciaM: number
): AccionProximidad {
  switch (prox) {
    case ProximidadZona.DENTRO:
      return {
        actualizarSignal: true,
        vibracion: 'continua',
        toast: null,
        colorBanner: '#ff0000',
      };
    case ProximidadZona.ACERCANDOSE:
      return {
        actualizarSignal: true,
        vibracion: 'unica',
        toast: `Zona de riesgo a ${Math.round(distanciaM)}m: ${nombreZona}`,
        colorBanner: '#ff6600',
      };
    case ProximidadZona.CERCANO:
      return {
        actualizarSignal: false,
        vibracion: 'ninguna',
        toast: null,
        colorBanner: null,
      };
    case ProximidadZona.LEJOS:
      return {
        actualizarSignal: false,
        vibracion: 'ninguna',
        toast: null,
        colorBanner: null,
      };
  }
}
