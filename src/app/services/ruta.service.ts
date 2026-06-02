import { Injectable, signal, inject, effect, computed } from '@angular/core';
import { haversine } from '../utils/haversine';
import { GeoService, PosicionActual } from './geo.service';
import { DatabaseService } from './database.service';

/**
 * RutaService — Posición 3 en el orden de inicialización.
 *
 * Produce:
 *   - Signal distanciaAcumulada_km (→ AutonomiaService, ExternalidadesService)
 *   - Signal sesionActiva (→ GeneroService: fuente de posición)
 *
 * Consume: Signal posicionActual (← GeoService)
 *
 * Responsabilidades:
 *   - Orquestar inicio/fin de sesión (GeoService.iniciar/detener)
 *   - Acumular distancia con Haversine sobre posiciones filtradas
 *   - Serializar track como LineString WKT al detener sesión
 *   - Persistir sesión en SQLite (tabla sesiones + puntos_ruta)
 *
 * Ver: Nodo-02-Registro-Ruta, Signal-Dependency-Graph.md
 */

interface PuntoTrack {
  lat: number;
  lng: number;
  timestamp: number;
}

@Injectable({ providedIn: 'root' })
export class RutaService {
  private readonly geo = inject(GeoService);
  private readonly db = inject(DatabaseService);

  // ---- Signals públicos ----

  /** true mientras hay una sesión de ruta activa */
  readonly sesionActiva = signal(false);

  /** Distancia acumulada en kilómetros durante la sesión actual */
  readonly distanciaAcumulada_km = signal(0);

  /** ID de la sesión activa en SQLite (null si no hay sesión) */
  readonly sesionId = signal<number | null>(null);

  // ---- Estado interno ----

  private track: PuntoTrack[] = [];
  private distanciaAcumuladaM = 0;
  private inicioTimestamp = 0;

  // Contador de ticks — sólo activo durante la sesión (setInterval zone-tracked)
  private _timerInterval: ReturnType<typeof setInterval> | null = null;
  private readonly _ticks = signal(0);

  /** Duración de la sesión actual en segundos */
  readonly duracion_s = computed(() => {
    this._ticks();
    if (!this.sesionActiva() || !this.inicioTimestamp) return 0;
    return Math.round((Date.now() - this.inicioTimestamp) / 1000);
  });

  // Effect: cada vez que posicionActual cambia, acumular distancia
  private readonly posicionEffect = effect(() => {
    const pos = this.geo.posicionActual();
    if (pos && this.sesionActiva()) {
      this.agregarPunto(pos);
    }
  });

  // ============================================================
  // CONTROL DE SESIÓN
  // ============================================================

  /**
   * Inicia una nueva sesión de ruta.
   * Crea registro en SQLite, arranca GeoService, inicia timer.
   */
  async iniciarSesion(
    bateriaInicioPct?: number,
    autonomiaPredichaKm?: number
  ): Promise<void> {
    if (this.sesionActiva()) return;

    // Reset estado
    this.track = [];
    this.distanciaAcumuladaM = 0;
    this.distanciaAcumulada_km.set(0);
    this.inicioTimestamp = Date.now();

    // Crear sesión en SQLite
    const inicio = new Date().toISOString();
    const cambios = await this.db.run(
      'INSERT INTO sesiones (inicio, bateria_inicio_pct, autonomia_predicha_km) VALUES (?, ?, ?)',
      [inicio, bateriaInicioPct ?? null, autonomiaPredichaKm ?? null]
    );

    // Obtener el ID de la sesión recién creada
    const rows = await this.db.query(
      'SELECT id FROM sesiones ORDER BY id DESC LIMIT 1'
    );
    this.sesionId.set(rows[0]?.id ?? null);

    // Arrancar GPS
    await this.geo.iniciar();

    // Iniciar timer — setInterval zone-tracked garantiza CD cada segundo
    this._ticks.set(0);
    this._timerInterval = setInterval(() => this._ticks.update(n => n + 1), 1000);

    this.sesionActiva.set(true);
    console.log(`[RutaService] Sesión ${this.sesionId()} iniciada`);
  }

  /**
   * Detiene la sesión activa.
   * Serializa track, actualiza SQLite, detiene GPS.
   */
  async detenerSesion(): Promise<void> {
    if (!this.sesionActiva()) return;

    this.sesionActiva.set(false);

    // Detener timer
    if (this._timerInterval !== null) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }

    // Detener GPS
    await this.geo.detener();

    // Serializar track como LineString WKT
    const geometryWKT =
      this.track.length >= 2
        ? 'LINESTRING(' +
          this.track
            .map((p) => `${p.lng.toFixed(5)} ${p.lat.toFixed(5)}`)
            .join(', ') +
          ')'
        : null;

    // Actualizar sesión en SQLite
    const id = this.sesionId();
    if (id !== null) {
      const fin = new Date().toISOString();
      const duracion = Math.round((Date.now() - this.inicioTimestamp) / 1000);
      await this.db.run(
        'UPDATE sesiones SET fin = ?, distancia_m = ?, duracion_s = ?, geometry = ? WHERE id = ?',
        [fin, Math.round(this.distanciaAcumuladaM), duracion, geometryWKT, id]
      );
    }

    console.log(
      `[RutaService] Sesión ${id} detenida: ${this.distanciaAcumulada_km().toFixed(2)} km, ${this.duracion_s()}s`
    );

    this.sesionId.set(null);
  }

  // ============================================================
  // T02-07 — FOTOGRAFÍA GEORREFERENCIADA (RF-02)
  // ============================================================

  /**
   * Registra una foto tomada durante la sesión activa.
   * Inserta un punto en `puntos_ruta` con `foto_path` — la imagen
   * queda vinculada a coordenadas GPS + timestamp + sesión_id.
   *
   * TTC #25 — Cadena de Custodia Forense (Criminalística → PGIS ciudadano):
   *   El protocolo forense exige: imagen + coordenadas + timestamp + contexto
   *   de evento = evidencia vinculante al espacio-tiempo (cadena de custodia).
   *   VoltSafe implementa ese protocolo pasivamente: `foto_path` + `lat` + `lng`
   *   + `timestamp` ISO + `sesion_id` constituyen evidencia ciudadana de un bache,
   *   un obstáculo o una zona peligrosa. El ciclista produce en 2 taps lo que
   *   un inspector del Invías produce con formularios y viáticos.
   *   Argumento oral: "La columna foto_path implementa cadena de custodia forense:
   *   imagen + coordenadas + tiempo + sesión. Un ciclista que fotografía un bache
   *   produce el mismo valor probatorio que un informe del Invías, en 2 taps."
   *
   * @param webPath   URI local del archivo (Capacitor Camera webPath)
   * @param lat       Latitud GPS en el momento de la captura
   * @param lng       Longitud GPS en el momento de la captura
   */
  async registrarFoto(webPath: string, lat: number, lng: number): Promise<void> {
    const id = this.sesionId();
    if (id === null) return;
    await this.db.run(
      'INSERT INTO puntos_ruta (sesion_id, lat, lng, timestamp, foto_path) VALUES (?, ?, ?, ?, ?)',
      [id, lat, lng, new Date().toISOString(), webPath]
    );
  }

  // ============================================================
  // ACUMULACIÓN DE TRACK
  // ============================================================

  private agregarPunto(pos: PosicionActual): void {
    const punto: PuntoTrack = {
      lat: pos.lat,
      lng: pos.lng,
      timestamp: pos.timestamp,
    };

    // Calcular distancia incremental
    if (this.track.length > 0) {
      const ultimo = this.track[this.track.length - 1];
      const deltaM = haversine(ultimo.lat, ultimo.lng, punto.lat, punto.lng);

      // Filtro de micro-movimiento: ignorar deltas < 2m (ruido GPS estacionario)
      if (deltaM < 2) return;

      this.distanciaAcumuladaM += deltaM;
      this.distanciaAcumulada_km.set(this.distanciaAcumuladaM / 1000);
    }

    this.track.push(punto);

    // Persistir punto en SQLite (async, no bloquea)
    const id = this.sesionId();
    if (id !== null) {
      this.db
        .run(
          'INSERT INTO puntos_ruta (sesion_id, lat, lng, timestamp) VALUES (?, ?, ?, ?)',
          [id, punto.lat, punto.lng, new Date(punto.timestamp).toISOString()]
        )
        .catch((err) =>
          console.error('[RutaService] Error INSERT punto:', err)
        );
    }
  }
}
