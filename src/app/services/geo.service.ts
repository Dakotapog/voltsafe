import { Injectable, signal, inject, effect, OnDestroy } from '@angular/core';
import { Geolocation, Position, CallbackID } from '@capacitor/geolocation';
import { haversine } from '../utils/haversine';
import {
  clasificarConfianza,
  radioSnapM,
  NivelConfianza,
} from '../models/confidence-ring';
import { DeviceMonitorService } from './device-monitor.service';

/**
 * GeoService — Posición 1 en el orden de inicialización.
 *
 * Produce: Signal posicionActual {lat, lng, accuracy, timestamp}
 * Consume: Signal nivelBateria → intervalo adaptativo watchPosition
 *
 * Innovaciones GPS integradas (GPS-Precision-Strategy.md):
 *   P1: Filtro de velocidad física (max 12 m/s ≈ 43 km/h)
 *   P3: Confidence Ring — accuracy como selector de estrategia
 *   TTC: Temporal Confidence Decay — la incertidumbre crece entre fixes
 *
 * Ver: GPS-Precision-Strategy.md, Confidence-Ring-Model.md, Estrategia-Bateria-Adaptativa.md
 */

export interface PosicionActual {
  lat: number;
  lng: number;
  accuracy: number;
  timestamp: number;
}

@Injectable({ providedIn: 'root' })
export class GeoService implements OnDestroy {
  private readonly deviceMonitor = inject(DeviceMonitorService);

  // ---- Signals públicos ----

  /** Posición actual del ciclista. null hasta primer fix GPS válido. */
  readonly posicionActual = signal<PosicionActual | null>(null);

  /**
   * Posición raw pre-filtro. Actualizada con CADA fix del hardware, sin confidence ring.
   * Usar exclusivamente para live sharing (LiveTrackingService) donde accuracy 80m es OK.
   * Para navegación/snap-to-road usar posicionActual().
   */
  readonly posicionRaw = signal<PosicionActual | null>(null);

  /** Nivel de confianza del último fix GPS */
  readonly nivelConfianza = signal<NivelConfianza>(NivelConfianza.ALTA);

  /** Velocidad estimada en m/s (de los últimos 2 fixes válidos) */
  readonly velocidadMS = signal(0);

  // ---- Estado interno ----

  private watchId: CallbackID | null = null;
  private ultimaPosicion: PosicionActual | null = null;
  // Referencia para el speed filter — se actualiza con CADA fix que pasa la velocidad,
  // sin importar el confidence ring. Resuelve el bug donde ultimaPosicion se congelaba
  // en la primera posición (accuracy <35m) y el speed filter empezaba a rechazar todo.
  private ultimaPosicionRaw: PosicionActual | null = null;
  private activo = false;
  /**
   * Cuando true, fuerza GPS a 1s sin importar el nivel de batería.
   * Activado por LiveTrackingService — el usuario aceptó el costo de batería al compartir.
   */
  private modoTrackingActivo = false;

  /** Velocidad máxima física de un ciclista en m/s (~43 km/h, GPS-P1) */
  private readonly VELOCIDAD_MAX_MS = 12.0;

  // Effect: cuando cambia el intervalo GPS por batería, reiniciar watchPosition.
  // Si modoTrackingActivo: ignora batería y fuerza 1s para que el viewer vea movimiento fluido.
  // Usa void para manejar la promesa sin bloquear el effect (no puede ser async).
  private readonly intervaloEffect = effect(() => {
    const intervaloMs = this.deviceMonitor.intervaloGpsMs();
    if (this.activo) {
      void this.detenerWatch().then(() =>
        this.iniciarWatch(this.modoTrackingActivo ? 1000 : intervaloMs)
      );
    }
  });

  // ============================================================
  // CONTROL DE SESIÓN
  // ============================================================

  /**
   * Inicia el tracking GPS. Llamado por RutaService al iniciar sesión.
   */
  async iniciar(): Promise<void> {
    if (this.activo) return;
    this.activo = true;

    // Pedir permisos
    const permisos = await Geolocation.checkPermissions();
    if (permisos.location !== 'granted') {
      await Geolocation.requestPermissions();
    }

    const intervaloMs = this.deviceMonitor.intervaloGpsMs();
    await this.iniciarWatch(intervaloMs);
  }

  /**
   * Detiene el tracking GPS. Llamado por RutaService al detener sesión.
   */
  async detener(): Promise<void> {
    this.activo = false;
    await this.detenerWatch();
  }

  /**
   * Fuerza GPS a 1s mientras el usuario está compartiendo ubicación en vivo.
   * Llama con false al detener la publicación para restaurar el intervalo de batería.
   */
  async setModoTracking(activo: boolean): Promise<void> {
    if (this.modoTrackingActivo === activo) return;
    this.modoTrackingActivo = activo;
    if (this.activo) {
      await this.detenerWatch();
      const intervaloMs = activo ? 1000 : this.deviceMonitor.intervaloGpsMs();
      await this.iniciarWatch(intervaloMs);
    }
  }

  // ============================================================
  // WATCH POSITION
  // ============================================================

  private async iniciarWatch(intervaloMs: number): Promise<void> {
    try {
      this.watchId = await Geolocation.watchPosition(
        {
          enableHighAccuracy: true,
          timeout: intervaloMs + 5000,
          minimumUpdateInterval: intervaloMs,
        },
        (position, err) => {
          if (err || !position) return;
          this.procesarPosicion(position);
        }
      );
    } catch (err) {
      console.error('[GeoService] Error watchPosition:', err);
    }
  }

  private async detenerWatch(): Promise<void> {
    if (this.watchId !== null) {
      await Geolocation.clearWatch({ id: this.watchId });
      this.watchId = null;
    }
  }

  // ============================================================
  // PROCESAMIENTO — FILTRO + CONFIDENCE RING
  // ============================================================

  private procesarPosicion(position: Position): void {
    const { latitude: lat, longitude: lng, accuracy } = position.coords;
    const timestamp = position.timestamp;

    // ---- GPS-P1: Filtro de velocidad física ----
    // Usa ultimaPosicionRaw (siempre actualizada) — no ultimaPosicion que se congela
    // cuando accuracy >= 35m (DESCARTE) en entornos urbanos como Bogotá.
    if (!this.esMovimientoFisicamentePosible(lat, lng, timestamp)) {
      return;
    }

    // Actualizar referencia del speed filter SIEMPRE que pase la velocidad.
    // Este es el fix del bug raíz: ultimaPosicionRaw nunca se congela.
    const posRaw: PosicionActual = { lat, lng, accuracy: accuracy ?? 50, timestamp };
    this.ultimaPosicionRaw = posRaw;
    this.posicionRaw.set(posRaw);

    // ---- TTC: Temporal Confidence Decay ----
    let effectiveAccuracy = accuracy ?? 10;
    if (this.ultimaPosicion) {
      const dtS = (timestamp - this.ultimaPosicion.timestamp) / 1000;
      const driftM = this.velocidadMS() * dtS;
      effectiveAccuracy = Math.max(effectiveAccuracy, effectiveAccuracy + driftM * 0.5);
    }

    // ---- GPS-P3: Confidence Ring ----
    const nivel = clasificarConfianza(effectiveAccuracy);
    this.nivelConfianza.set(nivel);

    // Velocidad estimada — usa ultimaPosicionRaw para mayor frecuencia de actualización
    if (this.ultimaPosicionRaw) {
      const dtS = (timestamp - this.ultimaPosicionRaw.timestamp) / 1000;
      if (dtS > 0) {
        const distM = haversine(
          this.ultimaPosicionRaw.lat,
          this.ultimaPosicionRaw.lng,
          lat,
          lng
        );
        // Solo actualizar si hay movimiento real (evita 0 m/s por mismo timestamp)
        if (distM > 0) this.velocidadMS.set(distM / dtS);
      }
    }

    if (nivel === NivelConfianza.DESCARTE) {
      // accuracy >= 35m: posicionRaw ya actualizada, posicionActual no (snap-to-road)
      return;
    }

    const nuevaPos: PosicionActual = { lat, lng, accuracy: effectiveAccuracy, timestamp };
    this.posicionActual.set(nuevaPos);
    this.ultimaPosicion = nuevaPos;
  }

  // ============================================================
  // GPS-P1: FILTRO DE VELOCIDAD FÍSICA
  // ============================================================

  /**
   * Descarta saltos GPS que implican velocidad > 43 km/h.
   * El 80% de los saltos de multipath urbano son >20m en <2s.
   * Ningún ciclista alcanza 43 km/h instantáneamente.
   *
   * Usa haversine.ts (función compartida).
   */
  private esMovimientoFisicamentePosible(
    lat: number,
    lng: number,
    timestamp: number
  ): boolean {
    // Usa ultimaPosicionRaw (no ultimaPosicion) — se actualiza con cada fix válido
    // sin importar el confidence ring. Evita que el speed filter rechace posiciones
    // reales cuando ultimaPosicion lleva minutos congelada por DESCARTE.
    const ref = this.ultimaPosicionRaw;
    if (!ref) return true;

    const dtS = (timestamp - ref.timestamp) / 1000;
    if (dtS <= 0) return true;

    const distM = haversine(ref.lat, ref.lng, lat, lng);
    return (distM / dtS) <= this.VELOCIDAD_MAX_MS;
  }

  ngOnDestroy(): void {
    this.detenerWatch();
  }
}
