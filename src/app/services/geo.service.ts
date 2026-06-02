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

  /** Nivel de confianza del último fix GPS */
  readonly nivelConfianza = signal<NivelConfianza>(NivelConfianza.ALTA);

  /** Velocidad estimada en m/s (de los últimos 2 fixes válidos) */
  readonly velocidadMS = signal(0);

  // ---- Estado interno ----

  private watchId: CallbackID | null = null;
  private ultimaPosicion: PosicionActual | null = null;
  private activo = false;

  /** Velocidad máxima física de un ciclista en m/s (~43 km/h, GPS-P1) */
  private readonly VELOCIDAD_MAX_MS = 12.0;

  // Effect: cuando cambia el intervalo GPS por batería, reiniciar watchPosition
  private readonly intervaloEffect = effect(() => {
    const intervaloMs = this.deviceMonitor.intervaloGpsMs();
    if (this.activo) {
      // Reiniciar watch con nuevo intervalo
      this.detenerWatch();
      this.iniciarWatch(intervaloMs);
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
    if (!this.esMovimientoFisicamentePosible(lat, lng, timestamp)) {
      // Salto de multipath — descartar silenciosamente
      return;
    }

    // ---- TTC: Temporal Confidence Decay ----
    // La incertidumbre crece entre fixes. Si el GPS no actualiza en 15s
    // y el ciclista va a 20km/h, el drift real es ~83m.
    // Esto unifica Estrategia-Bateria-Adaptativa con Confidence Ring.
    let effectiveAccuracy = accuracy ?? 10;
    if (this.ultimaPosicion) {
      const dtS = (timestamp - this.ultimaPosicion.timestamp) / 1000;
      const driftM = this.velocidadMS() * dtS;
      effectiveAccuracy = Math.max(effectiveAccuracy, effectiveAccuracy + driftM * 0.5);
      // Factor 0.5: el GPS ya corrige parcialmente el drift al fijar
    }

    // ---- GPS-P3: Confidence Ring — selector de estrategia ----
    const nivel = clasificarConfianza(effectiveAccuracy);
    this.nivelConfianza.set(nivel);

    // Actualizar velocidad estimada
    if (this.ultimaPosicion) {
      const dtS = (timestamp - this.ultimaPosicion.timestamp) / 1000;
      if (dtS > 0) {
        const distM = haversine(
          this.ultimaPosicion.lat,
          this.ultimaPosicion.lng,
          lat,
          lng
        );
        this.velocidadMS.set(distM / dtS);
      }
    }

    // Según anillo de confianza, decidir qué hacer
    if (nivel === NivelConfianza.DESCARTE) {
      // GPS inutilizable — no actualizar posición (dead reckoning futuro E3)
      return;
    }

    // Para anillos ALTA, MEDIA, BAJA: actualizar posición
    // (snap-to-segment se hará en MapaService cuando esté implementado)
    const nuevaPos: PosicionActual = {
      lat,
      lng,
      accuracy: effectiveAccuracy,
      timestamp,
    };

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
    if (!this.ultimaPosicion) return true;

    const dtS = (timestamp - this.ultimaPosicion.timestamp) / 1000;
    if (dtS <= 0) return true; // timestamps idénticos — aceptar

    const distM = haversine(
      this.ultimaPosicion.lat,
      this.ultimaPosicion.lng,
      lat,
      lng
    );
    const velocidadMS = distM / dtS;

    return velocidadMS <= this.VELOCIDAD_MAX_MS;
  }

  ngOnDestroy(): void {
    this.detenerWatch();
  }
}
