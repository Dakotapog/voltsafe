import { Injectable, signal, inject } from '@angular/core';
import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getDatabase, ref, set, onValue, off, DatabaseReference } from 'firebase/database';
import { App } from '@capacitor/app';
import { environment } from '../../environments/environment';
import { GeoService } from './geo.service';
import { DeviceMonitorService } from './device-monitor.service';
import { RutaService } from './ruta.service';
import { SuperficieService } from './superficie.service';

export interface PosicionViva {
  lat:      number;
  lng:      number;
  bat:      number;
  km:       number;
  kmh:      number;
  bri:      string;
  accuracy: number;
  ts:       number;
}

/**
 * LiveTrackingService — RF-06: tracking en vivo vía Firebase Realtime Database.
 *
 * APK side: publica posición cada 2s mientras sesión activa y app en foreground.
 *           Se pausa automáticamente en background para no agotar batería.
 * PWA side: suscribe a sesión por ID y notifica cada cambio.
 *
 * Firebase path: sessions/{sesionId}/pos
 * URL viewer:    https://voltsafe.netlify.app/?sesion={sesionId}
 */
@Injectable({ providedIn: 'root' })
export class LiveTrackingService {
  private readonly geo           = inject(GeoService);
  private readonly deviceMonitor = inject(DeviceMonitorService);
  private readonly ruta          = inject(RutaService);
  private readonly superficie    = inject(SuperficieService);

  readonly sesionId    = signal<string | null>(null);
  readonly posicionViva = signal<PosicionViva | null>(null);

  private app:      FirebaseApp | null = null;
  private intervalo: ReturnType<typeof setInterval> | null = null;
  private enBackground = false;
  private listenerRef: DatabaseReference | null = null;

  private getApp(): FirebaseApp {
    if (this.app) return this.app;
    const apps = getApps();
    this.app = apps.length > 0 ? apps[0] : initializeApp(environment.firebase);
    return this.app;
  }

  // ============================================================
  // APK SIDE — publicar posición en vivo
  // ============================================================

  generarSesionId(): string {
    const random = Math.random().toString(36).substring(2, 8);
    return `vs-${Date.now()}-${random}`;
  }

  generarURLViewer(sesionId: string): string {
    return `https://voltsafe.netlify.app/?sesion=${sesionId}`;
  }

  async iniciarPublicacion(sesionId: string): Promise<void> {
    this.sesionId.set(sesionId);
    this.enBackground = false;

    // Escuchar cambios de estado de la app para pausar en background
    await App.addListener('appStateChange', ({ isActive }) => {
      this.enBackground = !isActive;
    });

    await this.publicarPosicion(sesionId); // primer envío inmediato
    this.intervalo = setInterval(() => {
      if (!this.enBackground) {
        this.publicarPosicion(sesionId);
      }
    }, 2000);
  }

  detenerPublicacion(): void {
    if (this.intervalo !== null) {
      clearInterval(this.intervalo);
      this.intervalo = null;
    }
    App.removeAllListeners().catch(() => {});
    this.sesionId.set(null);
  }

  private async publicarPosicion(sesionId: string): Promise<void> {
    const pos = this.geo.posicionActual();
    if (!pos) return;

    const db     = getDatabase(this.getApp());
    const posRef = ref(db, `sessions/${sesionId}/pos`);
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

  suscribirSesion(sesionId: string, onChange: (pos: PosicionViva) => void): void {
    const db = getDatabase(this.getApp());
    this.listenerRef = ref(db, `sessions/${sesionId}/pos`);
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
