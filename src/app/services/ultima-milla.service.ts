import { Injectable, signal, inject, effect } from '@angular/core';
import { haversine } from '../utils/haversine';
import { GeoService } from './geo.service';

/**
 * UltimaMillaService — RF-07 (Nodo 09)
 *
 * Produce:
 *   - Signal proximaEstacion (→ AutonomiaService para umbral adaptativo 15%/20%)
 *   - Signal estacionesCercanas[] (→ UI lista con distancia + ícono bicicletero)
 *
 * Consume: Signal posicionActual (← GeoService)
 * Lee: assets/estaciones_tm.json (no SQLite — JSON estático)
 *
 * TTC cross-domain: el umbral adaptativo viene de teoría de decisión —
 * el costo de quedarse sin batería es menor si hay estación TM cerca (plan B).
 * Por eso el umbral de PRECAUCIÓN baja de 20% a 15% cuando hay estación < 500m.
 *
 * Ver: Nodo-09-Ultima-Milla, Signal-Dependency-Graph.md
 */

export interface EstacionTM {
  id: string;
  nombre: string;
  tipo: string;
  lat: number;
  lng: number;
  tiene_bicicletero: boolean;
  riesgo_estacionamiento: string;
  lineas: string[];
  distancia_m?: number;
}

export interface ProximaEstacion {
  estacion: EstacionTM;
  distancia_m: number;
}

@Injectable({ providedIn: 'root' })
export class UltimaMillaService {
  private readonly geo = inject(GeoService);

  /** Estación más cercana (o null). Consumido por AutonomiaService para umbral adaptativo */
  readonly proximaEstacion = signal<ProximaEstacion | null>(null);

  /** Top 5 estaciones más cercanas — para UI ion-list */
  readonly estacionesCercanas = signal<EstacionTM[]>([]);

  private estaciones: EstacionTM[] = [];

  // Reactivo: recalcular en cada cambio de posición
  private readonly posicionEffect = effect(() => {
    const pos = this.geo.posicionActual();
    if (pos && this.estaciones.length > 0) {
      this.calcularCercanas(pos.lat, pos.lng);
    }
  });

  /**
   * Carga estaciones desde JSON estático. Llamado al abrir pantalla Última Milla
   * o al iniciar sesión.
   */
  async cargar(): Promise<void> {
    if (this.estaciones.length > 0) return; // ya cargado

    const response = await fetch('/assets/estaciones_tm.json');
    const data = await response.json();
    this.estaciones = data.estaciones ?? [];
  }

  private calcularCercanas(lat: number, lng: number): void {
    const conDistancia = this.estaciones.map((e) => ({
      ...e,
      distancia_m: haversine(lat, lng, e.lat, e.lng),
    }));

    conDistancia.sort((a, b) => a.distancia_m - b.distancia_m);

    // Top 5 para la lista
    this.estacionesCercanas.set(conDistancia.slice(0, 5));

    // Próxima estación para AutonomiaService
    if (conDistancia.length > 0) {
      this.proximaEstacion.set({
        estacion: conDistancia[0],
        distancia_m: conDistancia[0].distancia_m,
      });
    }
  }
}
