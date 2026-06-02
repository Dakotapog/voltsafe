import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, ModalController } from '@ionic/angular';
import { ExternalidadesService } from '../services/externalidades.service';

/**
 * EnmeComponent — Pantalla ENME (Nodo 19 / T19-01 a T19-04)
 *
 * Abierta como ion-modal desde PerfilPage.
 * Muestra información estática de la ENME (Ley 1964/2019) y
 * una tarjeta dinámica con el aporte personal del ciclista.
 *
 * TTC #23 — Teoría de Autodeterminación (Deci & Ryan, 1985):
 *   La motivación sostenida para adoptar movilidad eléctrica no viene
 *   de saber que existe la Ley 1964 (regulación externa) sino de
 *   percibir el propio aporte concreto (regulación integrada).
 *   La tarjeta dinámica hace exactamente eso: convierte el CO2 acumulado
 *   del ciclista en equivalentes comprensibles (árboles, metas ENME).
 *   Argumento oral: "La pantalla ENME no es informativa — es motivacional.
 *   Implementa la Teoría de Autodeterminación: mueve al usuario de
 *   'cumplir la ley' a 'quiero contribuir'."
 */
@Component({
  selector: 'app-enme',
  templateUrl: 'enme.component.html',
  standalone: true,
  imports: [IonicModule, CommonModule],
})
export class EnmeComponent {
  private readonly modal = inject(ModalController);
  readonly externalidades = inject(ExternalidadesService);

  /** Meta ENME diaria: 1700g CO2 evitados/día por ciclista urbano (ENME.md) */
  readonly META_ENME_DIARIA_G = 1700;

  /** Un árbol absorbe ~22 kg CO2/año (fuente: IDEAM Colombia) */
  readonly CO2_ARBOL_G = 22_000;

  /** Progreso hacia el primer árbol equivalente (0.0 – 1.0, tope en 1.0) */
  get progresoArbol(): number {
    const co2 = this.externalidades.acumuladoHistorico().co2_g;
    return Math.min(1, co2 / this.CO2_ARBOL_G);
  }

  cerrar(): void {
    this.modal.dismiss();
  }
}
