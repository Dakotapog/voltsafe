import { Injectable, signal } from '@angular/core';

/**
 * ViewerService — Modo de visualización compartida.
 *
 * Cuando alguien recibe un link de VoltSafe con parámetros de posición,
 * este servicio los captura y los expone como Signals para que MapaPage
 * muestre el marcador del rider en el mapa de VoltSafe.
 *
 * URL format: https://voltsafe.netlify.app/?lat=4.6650&lng=-74.0560&bat=78&km=2.31&kmh=18.5&bri=SUAVE
 *
 * TTC: NASA Eyes on the Solar System usa exactamente este patrón —
 * el estado del objeto (posición, velocidad) codificado en la URL →
 * cualquier browser recibe la misma vista. Sin servidor, sin backend.
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

  /** null = modo normal de la app · params = modo viewer desde link compartido */
  readonly params = signal<ViewerParams | null>(null);

  /**
   * Lee los parámetros de la URL al arrancar la app.
   * Si lat/lng están presentes → activa modo viewer.
   */
  parsearDesdeURL(): boolean {
    const search = new URLSearchParams(window.location.search);
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
