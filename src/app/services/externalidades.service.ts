import { Injectable, signal, inject, effect } from '@angular/core';
import { Storage } from '@ionic/storage-angular';
import { RutaService } from './ruta.service';

/**
 * ExternalidadesService — RF-09 (Nodo 16)
 *
 * Produce: Signal externalidadesSesion {co2_g, dinero_cop, calorias}
 * Consume: Signal distanciaAcumulada_km (← RutaService)
 *
 * Factores:
 *   - CO2: 170 g/km evitados vs carro promedio Bogotá
 *   - Dinero: 368 COP/km ahorrados (gasolina + mantenimiento + parqueadero)
 *   - Calorías: 30 kcal/km (ciclismo urbano ~15 km/h, ~75kg)
 *
 * TTC cross-domain: los factores vienen de economía del transporte (CO2/km modal),
 * fisiología del ejercicio (MET ciclismo × peso × tiempo), y finanzas personales
 * (costo total de propiedad vehicular).
 *
 * Ver: Nodo-16-Externalidades, Signal-Dependency-Graph.md
 */

export interface Externalidades {
  co2_g: number;
  dinero_cop: number;
  calorias: number;
}

const FACTOR_CO2_G_KM = 170;
const FACTOR_DINERO_COP_KM = 368;
const FACTOR_CALORIAS_KM = 30;

@Injectable({ providedIn: 'root' })
export class ExternalidadesService {
  private readonly ruta = inject(RutaService);
  private storage: Storage | null = null;

  /** Externalidades calculadas en tiempo real durante la sesión */
  readonly externalidadesSesion = signal<Externalidades>({
    co2_g: 0,
    dinero_cop: 0,
    calorias: 0,
  });

  /** Acumulados históricos (todas las sesiones) */
  readonly acumuladoHistorico = signal<Externalidades>({
    co2_g: 0,
    dinero_cop: 0,
    calorias: 0,
  });

  // Reactivo: recalcular en cada cambio de distanciaAcumulada_km
  private readonly distanciaEffect = effect(() => {
    const km = this.ruta.distanciaAcumulada_km();
    this.externalidadesSesion.set({
      co2_g: Math.round(km * FACTOR_CO2_G_KM),
      dinero_cop: Math.round(km * FACTOR_DINERO_COP_KM),
      calorias: Math.round(km * FACTOR_CALORIAS_KM),
    });
  });

  async inicializar(): Promise<void> {
    this.storage = await new Storage().create();
    const stored = await this.storage.get('externalidades');
    if (stored) {
      this.acumuladoHistorico.set(stored);
    }
  }

  /**
   * Llamado al finalizar sesión: suma externalidades de la sesión al acumulado.
   */
  async actualizarAcumulado(): Promise<void> {
    const sesion = this.externalidadesSesion();
    const historico = this.acumuladoHistorico();

    const nuevo: Externalidades = {
      co2_g: historico.co2_g + sesion.co2_g,
      dinero_cop: historico.dinero_cop + sesion.dinero_cop,
      calorias: historico.calorias + sesion.calorias,
    };

    this.acumuladoHistorico.set(nuevo);

    if (this.storage) {
      await this.storage.set('externalidades', nuevo);
    }
  }

  /** Equivalencia visual para Nodo-19 ENME: gramos de CO2 → árboles plantados */
  arbolesEquivalentes(): number {
    return this.acumuladoHistorico().co2_g / 22_000;
  }
}
