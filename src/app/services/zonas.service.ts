import { Injectable, signal, inject, effect } from '@angular/core';
import { haversine } from '../utils/haversine';
import {
  evaluarProximidadZona,
  ProximidadZona,
} from '../models/confidence-ring';
import { DatabaseService } from './database.service';
import { GeoService } from './geo.service';
import { HapticsService } from './haptics.service';

/**
 * ZonasService — RF-05 (Nodo 06)
 *
 * Produce: Signal alertaActiva
 * Consume: Signal posicionActual (← GeoService)
 * Lee: tabla zonas_peligro (← DatabaseService)
 *
 * Innovación: Confidence Ring Model para proximidad gradual
 *   DENTRO → banner rojo + vibración continua
 *   ACERCANDOSE → toast naranja + vibración única
 *   CERCANO → marcador visible en mapa
 *   LEJOS → sin acción
 *
 * TTC: también consume impactoDetectado (de SuperficieService) para auto-seeding
 * de zonas con clasificación SEVERO+ (C03→C06). Implementado cuando SensorService exista.
 *
 * Ver: Nodo-06-Zonas-Peligro, Confidence-Ring-Model.md
 */

export interface AlertaActiva {
  activa: boolean;
  zona?: string;
  distancia_m?: number;
  tipo?: string;
}

interface ZonaCargada {
  id: number;
  tipo: string;
  descripcion: string;
  lat: number;
  lng: number;
  radio_m: number;
}

@Injectable({ providedIn: 'root' })
export class ZonasService {
  private readonly db      = inject(DatabaseService);
  private readonly geo     = inject(GeoService);
  private readonly haptics = inject(HapticsService);

  /** Signal consumido por UI (banner), SeguridadService (SOS rojo), GeneroService (FAB pulso) */
  readonly alertaActiva = signal<AlertaActiva>({ activa: false });

  /** Zonas cargadas en memoria para evitar queries repetidas */
  private zonasActivas: ZonaCargada[] = [];

  /** Anti-spam: IDs de zonas para las que ya se mostró toast */
  private toastsRecientes = new Set<number>();

  // Reactivo: verificar proximidad en cada cambio de posición
  private readonly posicionEffect = effect(() => {
    const pos = this.geo.posicionActual();
    if (pos && this.zonasActivas.length > 0) {
      this.verificarProximidad(pos.lat, pos.lng);
    }
  });

  /**
   * Carga todas las zonas activas de SQLite a memoria.
   * Llamado una vez al abrir la pantalla del mapa o al iniciar sesión.
   */
  async cargarZonas(): Promise<void> {
    const rows = await this.db.query(
      'SELECT id, tipo, descripcion, lat, lng, radio_m FROM zonas_peligro WHERE activa = 1'
    );
    this.zonasActivas = rows.map((r) => ({
      id: r.id,
      tipo: r.tipo,
      descripcion: r.descripcion ?? r.tipo,
      lat: r.lat,
      lng: r.lng,
      radio_m: r.radio_m,
    }));
  }

  /** Retorna todas las zonas cargadas (para MapaService.agregarCapa) */
  obtenerZonas(): ZonaCargada[] {
    return this.zonasActivas;
  }

  // ============================================================
  // GEOFENCING CON ANILLOS DE PROXIMIDAD
  // ============================================================

  private verificarProximidad(lat: number, lng: number): void {
    let alertaMasCercana: AlertaActiva = { activa: false };
    let distanciaMinima = Infinity;

    for (const zona of this.zonasActivas) {
      const distM = haversine(lat, lng, zona.lat, zona.lng);
      const prox = evaluarProximidadZona(distM, zona.radio_m);

      if (prox === ProximidadZona.DENTRO || prox === ProximidadZona.ACERCANDOSE) {
        if (distM < distanciaMinima) {
          distanciaMinima = distM;
          alertaMasCercana = {
            activa: true,
            zona: zona.descripcion,
            distancia_m: Math.round(distM),
            tipo: zona.tipo,
          };
        }

        // Vibración semántica via HapticsService
        if (prox === ProximidadZona.DENTRO) {
          this.haptics.zonaPeligroDentro().catch(() => {});
        } else if (!this.toastsRecientes.has(zona.id)) {
          this.haptics.zonaPeligroAcercandose().catch(() => {});
          this.toastsRecientes.add(zona.id);
          // Limpiar después de 60s para permitir re-notificación
          setTimeout(() => this.toastsRecientes.delete(zona.id), 60_000);
        }
      }
    }

    this.alertaActiva.set(alertaMasCercana);
  }

  // ============================================================
  // REPORTE MANUAL DE ZONA (T06-07)
  // ============================================================

  /**
   * Inserta una zona reportada manualmente por el usuario desde MapaPage.
   * La zona se activa inmediatamente y se recarga en memoria.
   *
   * @param tipo           — 'hurto' | 'iluminacion' | 'via_deteriorada' | 'accidente'
   * @param descripcion    — texto libre del usuario
   * @param lat / lng      — posición GPS actual (tomada de GeoService en MapaPage)
   */
  async reportarZona(
    tipo: string,
    descripcion: string,
    lat: number,
    lng: number
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO zonas_peligro (tipo, descripcion, lat, lng, radio_m, fuente, activa)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [tipo, descripcion, lat, lng, 100, 'usuario']
    );
    // Recargar zonas en memoria para que el geofencing las detecte
    await this.cargarZonas();
  }

  // ============================================================
  // AUTO-SEEDING DESDE IMPACTOS (C03→C06)
  // ============================================================

  /**
   * Recibe un impacto SEVERO o CRITICO y crea una zona de peligro automática.
   * Llamado por SuperficieService (cuando exista) vía impactoDetectado Signal.
   */
  async autoSeedDesdeImpacto(
    lat: number,
    lng: number,
    clasificacion: string
  ): Promise<void> {
    if (clasificacion !== 'SEVERO' && clasificacion !== 'CRITICO') return;

    await this.db.run(
      'INSERT INTO zonas_peligro (tipo, descripcion, lat, lng, radio_m, fuente) VALUES (?, ?, ?, ?, ?, ?)',
      [
        'via_deteriorada',
        `Auto-detectado: impacto ${clasificacion}`,
        lat,
        lng,
        50,
        'auto_sensor',
      ]
    );

    // Recargar zonas en memoria
    await this.cargarZonas();
  }
}
