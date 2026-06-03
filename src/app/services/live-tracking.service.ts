import { Injectable, signal, inject } from '@angular/core';
import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getDatabase, ref, set, onValue, off, DatabaseReference } from 'firebase/database';
import { Geolocation } from '@capacitor/geolocation';
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

  readonly sesionId     = signal<string | null>(null);
  readonly posicionViva = signal<PosicionViva | null>(null);
  /** null = conectando · true = rider activo · false = sesión expirada/sin datos */
  readonly sesionViva   = signal<boolean | null>(null);

  private app:      FirebaseApp | null = null;
  private intervalo: ReturnType<typeof setInterval> | null = null;
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

    // Asegurar GPS activo — sin watchPosition corriendo, posicionActual() siempre
    // es null. geo.iniciar() tiene guard "if (activo) return" — seguro si ya está viva.
    await this.geo.iniciar();

    // No usamos appStateChange para pausar: el share dialog nativo dispara
    // isActive=false pero NO garantiza isActive=true al cerrarse, dejando el
    // intervalo bloqueado para siempre. Android WebView suspende setInterval
    // automáticamente cuando la app va a background real — no necesitamos hacerlo
    // manualmente. El intervalo se reanuda solo al regresar al primer plano.
    await this.publicarPosicion(sesionId); // primer envío inmediato
    this.intervalo = setInterval(() => {
      this.publicarPosicion(sesionId);
    }, 2000);
  }

  detenerPublicacion(): void {
    if (this.intervalo !== null) {
      clearInterval(this.intervalo);
      this.intervalo = null;
    }
    this.sesionId.set(null);
  }

  private async publicarPosicion(sesionId: string): Promise<void> {
    // Preferir el Signal (ya calculado, filtrado) — fallback a getCurrentPosition
    // cuando posicionActual es null (primera carga o browser sin GPS continuo).
    let lat: number, lng: number, accuracy: number;
    const posSignal = this.geo.posicionActual();

    if (posSignal) {
      lat      = posSignal.lat;
      lng      = posSignal.lng;
      accuracy = posSignal.accuracy ?? 15;
    } else {
      try {
        const raw = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 5000 });
        lat      = raw.coords.latitude;
        lng      = raw.coords.longitude;
        accuracy = raw.coords.accuracy ?? 15;
      } catch {
        return; // GPS sin fix aún — reintentar en próximo intervalo (watchPosition llegará pronto)
      }
    }

    const db     = getDatabase(this.getApp());
    const posRef = ref(db, `sessions/${sesionId}/pos`);
    const datos: PosicionViva = {
      lat,
      lng,
      bat:      this.deviceMonitor.nivelBateria(),
      km:       this.ruta.distanciaAcumulada_km(),
      kmh:      this.geo.velocidadMS() * 3.6,
      bri:      this.superficie.briActual(),
      accuracy,
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
    this.sesionViva.set(null); // conectando
    const db = getDatabase(this.getApp());
    this.listenerRef = ref(db, `sessions/${sesionId}/pos`);
    onValue(this.listenerRef, (snapshot) => {
      const datos = snapshot.val() as PosicionViva | null;
      if (datos) {
        this.sesionViva.set(true);
        this.posicionViva.set(datos);
        onChange(datos);
      } else {
        // Solo marcar expirada si nunca recibimos datos en esta suscripción
        if (this.sesionViva() !== true) {
          this.sesionViva.set(false);
        }
      }
    });
  }

  desuscribir(): void {
    if (this.listenerRef) {
      off(this.listenerRef);
      this.listenerRef = null;
    }
    this.posicionViva.set(null);
    this.sesionViva.set(null);
  }
}
