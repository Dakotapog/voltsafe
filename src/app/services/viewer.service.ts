import { Injectable, signal } from '@angular/core';

/**
 * ViewerService — Modo de visualización compartida.
 *
 * Dos modos de viewer:
 *  1. Snapshot (URL params): ?lat=X&lng=Y&bat=...  → posición fija
 *  2. Live (session ID):     ?session=vs-123-abc   → tracking en tiempo real
 *
 * TTC: NASA Eyes on the Solar System — estado del rider codificado en URL.
 */
export interface ViewerParams {
  lat: number;
  lng: number;
  bat: number;
  km: number;
  kmh: number;
  bri: string;
  accuracy: number;
  confianza: string;
}

@Injectable({ providedIn: 'root' })
export class ViewerService {

  /** null = modo normal de la app · params = modo viewer snapshot */
  readonly params = signal<ViewerParams | null>(null);

  /** null = sin live session · string = session ID para Firebase */
  readonly liveSessionId = signal<string | null>(null);

  /** true si es cualquier tipo de viewer (snapshot o live) */
  get esViewer(): boolean {
    return this.params() !== null || this.liveSessionId() !== null;
  }

  /**
   * Lee los parámetros de la URL al arrancar la app.
   * Detecta tanto snapshot (?lat/lng) como live (?session).
   * Retorna true si es cualquier modo viewer.
   */
  parsearDesdeURL(): boolean {
    const search = new URLSearchParams(window.location.search);

    // Modo live: ?session=vs-1234-abc
    const sessionId = search.get('session');
    if (sessionId && sessionId.startsWith('vs-')) {
      this.liveSessionId.set(sessionId);
      return true;
    }

    // Modo snapshot: ?lat=X&lng=Y
    const lat = parseFloat(search.get('lat') ?? '');
    const lng = parseFloat(search.get('lng') ?? '');
    if (isNaN(lat) || isNaN(lng)) return false;

    this.params.set({
      lat,
      lng,
      bat:       parseInt(search.get('bat')  ?? '0') || 0,
      km:        parseFloat(search.get('km') ?? '0') || 0,
      kmh:       parseFloat(search.get('kmh')  ?? '0') || 0,
      bri:       search.get('bri')       ?? 'SUAVE',
      accuracy:  parseFloat(search.get('acc')  ?? '15') || 15,
      confianza: search.get('conf')      ?? 'MEDIA',
    });

    return true;
  }

  /** Genera la URL de Netlify con todos los parámetros de telemetría */
  generarURL(p: {
    lat: number; lng: number;
    bat: number; km: number; kmh: number;
    co2: number; bri: string;
    accuracy: number; confianza: string;
  }): string {
    const base = 'https://voltsafe.netlify.app';
    const params = new URLSearchParams({
      lat:  p.lat.toFixed(6),
      lng:  p.lng.toFixed(6),
      bat:  p.bat.toString(),
      km:   p.km.toFixed(2),
      kmh:  p.kmh.toFixed(1),
      bri:  p.bri,
      acc:  Math.round(p.accuracy).toString(),
      conf: p.confianza,
    });
    return `${base}/?${params.toString()}`;
  }
}
