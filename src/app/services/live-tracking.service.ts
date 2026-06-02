import { Injectable, signal, inject } from '@angular/core';
import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getDatabase, ref, set, onValue, off, DatabaseReference } from 'firebase/database';
import { environment } from '../../environments/environment';
import { GeoService } from './geo.service';
import { DeviceMonitorService } from './device-monitor.service';
import { RutaService } from './ruta.service';
import { SuperficieService } from './superficie.service';

export interface PosicionViva {
  lat: number;
  lng: number;
  bat: number;
  km: number;
  kmh: number;
  bri: string;
  accuracy: number;
  ts: number;
}

/**
 * LiveTrackingService — RF-06 extensión: tracking en vivo vía Firebase RTDB.
 *
 * APK side: publica posición cada 5s mientras la sesión está activa.
 * PWA side: suscribe a una sesión y notifica cambios de posición.
 *
 * Path Firebase: sessions/{sessionId}/pos
 * URL viewer:    https://voltsafe.netlify.app/?session={sessionId}
 */
@Injectable({ providedIn: 'root' })
export class LiveTrackingService {
  private readonly geo           = inject(GeoService);
  private readonly deviceMonitor = inject(DeviceMonitorService);
  private readonly ruta          = inject(RutaService);
  private readonly superficie    = inject(SuperficieService);

  /** ID de la sesión en vivo activa (null = no publicando) */
  readonly sessionId = signal<string | null>(null);

  /** Posición recibida en modo viewer (null = sin datos aún) */
  readonly posicionViva = signal<PosicionViva | null>(null);

  private app: FirebaseApp | null = null;
  private intervaloPublicacion: ReturnType<typeof setInterval> | null = null;
  private listenerRef: DatabaseReference | null = null;

  private getApp(): FirebaseApp {
    if (this.app) return this.app;
    // Reutilizar app si ya fue inicializada (evita duplicados en hot-reload)
    const apps = getApps();
    this.app = apps.length > 0 ? apps[0] : initializeApp(environment.firebase);
    return this.app;
  }

  // ============================================================
  // APK SIDE — publicar posición en vivo
  // ============================================================

  generarSessionId(): string {
    const random = Math.random().toString(36).substring(2, 8);
    return `vs-${Date.now()}-${random}`;
  }

  generarURLViewer(sessionId: string): string {
    return `https://voltsafe.netlify.app/?session=${sessionId}`;
  }

  async iniciarPublicacion(sessionId: string): Promise<void> {
    this.sessionId.set(sessionId);
    await this.publicarPosicion(sessionId); // primer envío inmediato
    this.intervaloPublicacion = setInterval(
      () => this.publicarPosicion(sessionId),
      5000
    );
  }

  detenerPublicacion(): void {
    if (this.intervaloPublicacion !== null) {
      clearInterval(this.intervaloPublicacion);
      this.intervaloPublicacion = null;
    }
    this.sessionId.set(null);
  }

  private async publicarPosicion(sessionId: string): Promise<void> {
    const pos = this.geo.posicionActual();
    if (!pos) return;

    const db = getDatabase(this.getApp());
    const posRef = ref(db, `sessions/${sessionId}/pos`);
    const datos: PosicionViva = {
      lat:      pos.lat,
      lng:      pos.lng,
      bat:      this.deviceMonitor.nivelBateria(),
      km:       this.ruta.distanciaAcumulada_km(),
      kmh:      this.geo.velocidadMS() * 3.6,
      bri:      this.superficie.briActual(),
      accuracy: pos.accuracy ?? 15,
      ts:       Date.now(),
    };
    await set(posRef, datos).catch((err) =>
      console.error('[LiveTracking] Error al publicar:', err)
    );
  }

  // ============================================================
  // PWA SIDE — suscribir a sesión en vivo
  // ============================================================

  suscribirSesion(sessionId: string, onChange: (pos: PosicionViva) => void): void {
    const db = getDatabase(this.getApp());
    this.listenerRef = ref(db, `sessions/${sessionId}/pos`);
    onValue(this.listenerRef, (snapshot) => {
      const datos = snapshot.val() as PosicionViva | null;
      if (datos) {
        this.posicionViva.set(datos);
        onChange(datos);
      }
    });
  }

  desuscribir(): void {
    if (this.listenerRef) {
      off(this.listenerRef);
      this.listenerRef = null;
    }
    this.posicionViva.set(null);
  }
}
