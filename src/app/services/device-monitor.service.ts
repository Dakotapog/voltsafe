import { Injectable, signal, OnDestroy } from '@angular/core';
import { Device } from '@capacitor/device';

/**
 * DeviceMonitorService — Posición 0 en el orden de inicialización.
 *
 * Produce: Signal nivelBateria (0-100)
 * Consumidores:
 *   - GeoService → intervalo adaptativo watchPosition (5s/10s/15s)
 *   - SensorService → ratio descarte acelerómetro (1/2/4)
 *
 * Ver: Estrategia-Bateria-Adaptativa.md — tabla maestra de muestreo
 */
@Injectable({ providedIn: 'root' })
export class DeviceMonitorService implements OnDestroy {

  /** Nivel de batería 0-100. Inicializa en 100 (conservador: máxima calidad hasta primer read) */
  readonly nivelBateria = signal(100);

  /** Intervalo GPS en milisegundos según nivel de batería */
  readonly intervaloGpsMs = signal(5000);

  /** Ratio de descarte del acelerómetro (1 = sin descarte, 2 = descartar 50%, 4 = descartar 75%) */
  readonly ratioDescarteAcelerometro = signal(1);

  private intervaloId: ReturnType<typeof setInterval> | null = null;

  /**
   * Inicia el monitoreo de batería. Llamado desde app.component.ts después de DatabaseService.
   */
  async iniciar(): Promise<void> {
    // Lectura inmediata
    await this.leerBateria();

    // Lectura periódica cada 60s
    this.intervaloId = setInterval(() => this.leerBateria(), 60_000);
  }

  private async leerBateria(): Promise<void> {
    try {
      const info = await Device.getBatteryInfo();
      // batteryLevel: 0.0 a 1.0 (o undefined en web/desktop)
      const nivel = Math.round((info.batteryLevel ?? 1) * 100);
      this.nivelBateria.set(nivel);
      this.actualizarEstrategia(nivel);
    } catch {
      // En web/dev: batería no disponible — mantener defaults
      this.nivelBateria.set(100);
    }
  }

  /**
   * Tabla maestra de Estrategia-Bateria-Adaptativa.md
   *
   * | Batería   | GPS intervalo | Acelerómetro descarte |
   * |-----------|---------------|----------------------|
   * | > 50%     | 5s            | 1 (sin descarte)     |
   * | 30-50%    | 10s           | 2 (descartar 50%)    |
   * | < 30%     | 15s           | 4 (descartar 75%)    |
   */
  private actualizarEstrategia(nivel: number): void {
    if (nivel > 50) {
      this.intervaloGpsMs.set(5_000);
      this.ratioDescarteAcelerometro.set(1);
    } else if (nivel >= 30) {
      this.intervaloGpsMs.set(10_000);
      this.ratioDescarteAcelerometro.set(2);
    } else {
      this.intervaloGpsMs.set(15_000);
      this.ratioDescarteAcelerometro.set(4);
    }
  }

  ngOnDestroy(): void {
    if (this.intervaloId !== null) {
      clearInterval(this.intervaloId);
    }
  }
}
