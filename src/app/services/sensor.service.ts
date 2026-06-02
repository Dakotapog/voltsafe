import { Injectable, signal, inject, OnDestroy } from '@angular/core';
import { Motion, AccelListenerEvent } from '@capacitor/motion';
import { DeviceMonitorService } from './device-monitor.service';

/**
 * SensorService — Posición 2 en el orden de inicialización.
 *
 * Produce: Signal aceleracionRaw {ax, ay, az} — stream nativo del acelerómetro
 * Consume: Signal nivelBateria ← DeviceMonitorService → ratioDescarte adaptativo
 *
 * Responsabilidad única: wrapper del listener nativo de Motion.
 * El procesamiento BRI (filtro, RMS, clasificación) vive en SuperficieService.
 *
 * ─────────────────────────────────────────────────────────────────────
 * TTC #17 — Red Sismográfica Distribuida (Geofísica → BRI colectivo)
 *   Dominio origen: geofísica — red mundial de estaciones sismográficas (USGS, IRIS)
 *   Puente: las redes sismográficas detectan terremotos distribuyendo muchos sensores
 *   de bajo costo en el espacio geográfico. Cada nodo captura la señal local;
 *   el procesamiento colectivo localiza la fuente con precisión centimétrica.
 *   VoltSafe replica este modelo: cada smartphone es un nodo sismográfico urbano
 *   que captura "micro-terremotos de pavimento" (baches, grietas, expansiones).
 *   La red colectiva de usuarios produce el primer mapa de rugosidad vial de
 *   Bogotá con granularidad de metros — dato inexistente en cualquier fuente oficial.
 *   El SensorService es el hardware de este nodo sísmico.
 *   Argumento oral: "SensorService convierte cada smartphone en una estación
 *   sismográfica urbana. La red colectiva de usuarios de VoltSafe produce el
 *   primer mapa de vibraciones viales de Bogotá con granularidad de metros —
 *   equivalente a un survey sísmico de la infraestructura ciclista."
 *
 * Ver: Nodo-03-Deteccion-Superficie, Capacitor-Motion.md, TTC-Conexiones-Ocultas.md
 */

export interface AceleracionRaw {
  ax: number;
  ay: number;
  az: number;
}

@Injectable({ providedIn: 'root' })
export class SensorService implements OnDestroy {
  private readonly deviceMonitor = inject(DeviceMonitorService);

  // ── Signals públicos ──────────────────────────────────────────────

  /**
   * Stream de aceleración cruda incluyendo gravedad.
   * SuperficieService consume este Signal para filtrado y clasificación BRI.
   * Null hasta que se inicia el listener.
   */
  readonly aceleracionRaw = signal<AceleracionRaw | null>(null);

  /** true mientras el listener de Motion está activo */
  readonly activo = signal(false);

  private contadorLecturas = 0;

  // ── Control del listener ──────────────────────────────────────────

  /**
   * Inicia el listener de acelerómetro.
   * Llamado al iniciar sesión de ruta (desde RutaService o SesionPage).
   */
  async iniciar(): Promise<void> {
    if (this.activo()) return;

    this.contadorLecturas = 0;

    await Motion.addListener('accel', (event: AccelListenerEvent) => {
      // Muestreo adaptativo según batería (Estrategia-Bateria-Adaptativa.md)
      // ratioDescarteAcelerometro: 1 (>50% bat) / 2 (30-50%) / 4 (<30%)
      this.contadorLecturas++;
      const ratio = this.deviceMonitor.ratioDescarteAcelerometro();

      if (this.contadorLecturas % ratio !== 0) return;

      // Usar accelerationIncludingGravity: datos crudos más confiables para BRI
      // (ver Capacitor-Motion.md §6 — por qué no usar acceleration procesada)
      const acc = event.accelerationIncludingGravity;
      this.aceleracionRaw.set({
        ax: acc?.x ?? 0,
        ay: acc?.y ?? 0,
        az: acc?.z ?? 0,
      });
    });

    this.activo.set(true);
    console.log('[SensorService] Acelerómetro iniciado');
  }

  /**
   * Detiene el listener. Llamado al detener sesión.
   */
  async detener(): Promise<void> {
    if (!this.activo()) return;
    await Motion.removeAllListeners();
    this.aceleracionRaw.set(null);
    this.activo.set(false);
    this.contadorLecturas = 0;
    console.log('[SensorService] Acelerómetro detenido');
  }

  ngOnDestroy(): void {
    Motion.removeAllListeners().catch(() => {});
  }
}
