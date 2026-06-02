import { Injectable } from '@angular/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

/**
 * HapticsService — Feedback háptico semántico para VoltSafe.
 *
 * Cada patrón comunica un evento específico con un lenguaje táctil distinto
 * para que el ciclista no confunda una alerta de zona con una confirmación de sesión.
 *
 * TTC #10 (Bystander Effect): el canal háptico es la intervención física del
 * espectador digital — el aviso llega antes de que el ojo procese el visual.
 *
 * TTC #21 (Jan Gehl): el tap suave de estación TM < 500m no interrumpe
 * el pedaleo — es el umbral de confort de Gehl codificado en milisegundos.
 *
 * Ver: [[UX-Visual-Innovations]] V1 · [[ZonasService]] · [[SesionPage]]
 */
@Injectable({ providedIn: 'root' })
export class HapticsService {

  /** Sesión iniciada — doble pulso firme: "arrancamos" */
  async sesionIniciada(): Promise<void> {
    try {
      await Haptics.impact({ style: ImpactStyle.Heavy });
      await this._delay(140);
      await Haptics.impact({ style: ImpactStyle.Light });
    } catch { /* Haptics no disponible en web */ }
  }

  /** Sesión detenida — notificación de éxito: "completado" */
  async sesionDetenida(): Promise<void> {
    try {
      await Haptics.notification({ type: NotificationType.Success });
    } catch { /* Haptics no disponible en web */ }
  }

  /**
   * Estación TM < 500m — tap único suave.
   * No interrumpe el pedaleo — el ciclista decide si gira a verlo.
   * TTC #21 (Jan Gehl 500m TOD): el aviso llega exactamente cuando
   * la transferencia modal es viable y cómoda.
   */
  async estacionCercana(): Promise<void> {
    try {
      await Haptics.impact({ style: ImpactStyle.Light });
    } catch { /* Haptics no disponible en web */ }
  }

  /** Bache severo detectado por acelerómetro — tic síncrono al impacto */
  async bacheDetectado(): Promise<void> {
    try {
      await Haptics.impact({ style: ImpactStyle.Medium });
    } catch { /* Haptics no disponible en web */ }
  }

  /**
   * Zona de peligro — DENTRO del radio.
   * Triple pulso urgente: inconfundible con cualquier notificación del SO.
   * Heavy+Heavy+Medium en 160ms: el ciclista lo siente aunque lleve guantes.
   */
  async zonaPeligroDentro(): Promise<void> {
    try {
      await Haptics.impact({ style: ImpactStyle.Heavy });
      await this._delay(80);
      await Haptics.impact({ style: ImpactStyle.Heavy });
      await this._delay(80);
      await Haptics.impact({ style: ImpactStyle.Medium });
    } catch { /* Haptics no disponible en web */ }
  }

  /**
   * Zona de peligro — ACERCÁNDOSE (radio 1.5×).
   * Pulso medium único: aviso sin alarma — el ciclista aún puede redirigir.
   */
  async zonaPeligroAcercandose(): Promise<void> {
    try {
      await Haptics.impact({ style: ImpactStyle.Medium });
    } catch { /* Haptics no disponible en web */ }
  }

  private _delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
