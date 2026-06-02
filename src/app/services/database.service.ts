import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  SQLiteDBConnection,
} from '@capacitor-community/sqlite';
import {
  extractCenterline,
  toWKTLineString,
  calcularLongitudCenterlineM,
} from '../utils/centerline';

/**
 * DatabaseService — Posición -1 en el orden de inicialización.
 *
 * Responsabilidades:
 * 1. Crear todas las tablas SQLite WAL (migración v1)
 * 2. Importar ciclorrutas_full.geojson → segments (con centerline extraction PCA)
 * 3. Importar zonas_peligro_seed.json → zonas_peligro con fuente='seed'
 * 4. NO importar estaciones_tm.json (se lee como JSON en UltimaMillaService)
 *
 * BLOQUEANTE: ningún otro Service puede leer/escribir SQLite antes de que
 * DatabaseService.inicializar() haya completado.
 *
 * Ver: Esquema-SQLite-Consolidado.md, CenterlineExtraction.md
 */
@Injectable({ providedIn: 'root' })
export class DatabaseService {
  private sqlite = new SQLiteConnection(CapacitorSQLite);
  private db!: SQLiteDBConnection;
  private readonly DB_NAME = 'voltsafe';

  /** Signal público: true cuando la migración + importación terminó */
  readonly listo = signal(false);

  /** Signal de progreso para ion-loading */
  readonly progreso = signal('Inicializando base de datos...');

  // ============================================================
  // INICIALIZACIÓN PÚBLICA
  // ============================================================

  /**
   * Punto de entrada único. Llamado desde app.component.ts ngOnInit().
   * Bloquea hasta que SQLite + assets estén listos.
   */
  async inicializar(): Promise<void> {
    this.progreso.set('Inicializando base de datos...');

    // Browser: SQLite no disponible (jeep-sqlite no configurado).
    // Skip completo — permite preview visual y Angular DevTools sin bloqueo.
    // En native (Android) continúa el setup completo.
    if (Capacitor.getPlatform() === 'web') {
      this.listo.set(true);
      this.progreso.set('');
      return;
    }

    try {
      await this._setupDatabase();
    } catch (err) {
      console.error('[DatabaseService] Fallo inicializar:', err);
    }
    this.listo.set(true);
    this.progreso.set('');
  }

  private async _setupDatabase(): Promise<void> {
    try {
      if (Capacitor.getPlatform() === 'web') {
        await this.sqlite.initWebStore();
      }

      const existe = await this.sqlite.isConnection(this.DB_NAME, false);
      if (existe.result) {
        this.db = await this.sqlite.retrieveConnection(this.DB_NAME, false);
      } else {
        this.db = await this.sqlite.createConnection(
          this.DB_NAME,
          false,
          'no-encryption',
          1,
          false
        );
      }

      await this.db.open();
      await this.ejecutarMigracion();

      const countZonas = await this.db.query(
        'SELECT COUNT(*) as total FROM zonas_peligro WHERE fuente=\'seed\''
      );
      if ((countZonas.values?.[0]?.total ?? 0) === 0) {
        await this.importarZonasPeligro();
      }

      const countSegments = await this.db.query(
        'SELECT COUNT(*) as total FROM segments'
      );
      if ((countSegments.values?.[0]?.total ?? 0) === 0) {
        this.importarCiclorrutasBackground();
      }

      console.log('[DatabaseService] Setup SQLite completo');
    } catch (err) {
      console.error('[DatabaseService] Error setup SQLite:', err);
    }
  }

  // ============================================================
  // ACCESO PÚBLICO A LA CONEXIÓN
  // ============================================================

  /**
   * Ejecuta una consulta SELECT y retorna los resultados.
   * Uso: otros Services leen datos de SQLite.
   */
  async query(sql: string, params: any[] = []): Promise<any[]> {
    if (!this.db) return [];
    const result = await this.db.query(sql, params);
    return result.values ?? [];
  }

  /**
   * Ejecuta un INSERT/UPDATE/DELETE con parámetros.
   * Retorna el número de cambios.
   */
  async run(sql: string, params: any[] = []): Promise<number> {
    if (!this.db) return 0;
    const result = await this.db.run(sql, params, true);
    return result.changes?.changes ?? 0;
  }

  /**
   * Ejecuta múltiples sentencias SQL sin parámetros.
   */
  async execute(sql: string): Promise<void> {
    if (!this.db) return;
    await this.db.execute(sql, false);
  }

  // ============================================================
  // MIGRACIÓN v1
  // ============================================================

  private async ejecutarMigracion(): Promise<void> {
    const sql = `
      -- NODO 04: Navegación Offline
      CREATE TABLE IF NOT EXISTS segments (
        id            INTEGER PRIMARY KEY,
        nombre        TEXT,
        tipo          TEXT,
        longitud_m    REAL NOT NULL,
        pendiente     REAL DEFAULT 0.0,
        geometry      TEXT NOT NULL,
        lat_centro    REAL,
        lng_centro    REAL
      );
      CREATE INDEX IF NOT EXISTS idx_segments_lat ON segments(lat_centro);
      CREATE INDEX IF NOT EXISTS idx_segments_lng ON segments(lng_centro);

      -- NODO 02: Registro de Ruta
      CREATE TABLE IF NOT EXISTS sesiones (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        inicio                TEXT NOT NULL,
        fin                   TEXT,
        distancia_m           REAL DEFAULT 0.0,
        duracion_s            INTEGER DEFAULT 0,
        geometry              TEXT,
        bateria_inicio_pct    REAL,
        autonomia_predicha_km REAL
      );

      CREATE TABLE IF NOT EXISTS puntos_ruta (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        sesion_id     INTEGER NOT NULL,
        lat           REAL NOT NULL,
        lng           REAL NOT NULL,
        timestamp     TEXT NOT NULL,
        foto_path     TEXT,
        FOREIGN KEY (sesion_id) REFERENCES sesiones(id)
      );
      CREATE INDEX IF NOT EXISTS idx_puntos_sesion ON puntos_ruta(sesion_id);

      -- NODO 03: Detección de Superficie
      CREATE TABLE IF NOT EXISTS impactos (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        sesion_id       INTEGER NOT NULL,
        lat             REAL NOT NULL,
        lng             REAL NOT NULL,
        rms             REAL NOT NULL,
        clasificacion   TEXT NOT NULL,
        timestamp       TEXT NOT NULL,
        FOREIGN KEY (sesion_id) REFERENCES sesiones(id)
      );
      CREATE INDEX IF NOT EXISTS idx_impactos_sesion ON impactos(sesion_id);
      CREATE INDEX IF NOT EXISTS idx_impactos_clasificacion ON impactos(clasificacion);

      -- NODO 06: Zonas de Peligro
      CREATE TABLE IF NOT EXISTS zonas_peligro (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo          TEXT NOT NULL,
        descripcion   TEXT,
        lat           REAL NOT NULL,
        lng           REAL NOT NULL,
        radio_m       REAL DEFAULT 100.0,
        fuente        TEXT DEFAULT 'usuario',
        fecha         TEXT DEFAULT (datetime('now')),
        activa        INTEGER DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_zonas_lat_lng ON zonas_peligro(lat, lng);

      -- NODO 14: Seguridad de Género
      CREATE TABLE IF NOT EXISTS reportes_genero (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo          TEXT NOT NULL,
        descripcion   TEXT,
        lat           REAL NOT NULL,
        lng           REAL NOT NULL,
        fecha         TEXT DEFAULT (datetime('now')),
        activo        INTEGER DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_reportes_genero_lat_lng ON reportes_genero(lat, lng);

      -- NODO 04: Rutas Favoritas
      CREATE TABLE IF NOT EXISTS rutas_favoritas (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre        TEXT NOT NULL,
        origen_lat    REAL,
        origen_lng    REAL,
        destino_lat   REAL,
        destino_lng   REAL,
        distancia_m   REAL,
        creado_en     TEXT DEFAULT (datetime('now'))
      );
    `;

    await this.db.execute(sql, false);
    console.log('[DatabaseService] Migración v1 ejecutada');
  }

  // ============================================================
  // IMPORTACIÓN DE CICLORRUTAS
  // ============================================================

  private importarCiclorrutasBackground(): void {
    this.importarCiclorrutas().then(() => {
      console.log('[DatabaseService] Ciclorrutas background import done');
    }).catch(err => {
      console.error('[DatabaseService] Background ciclorrutas import error:', err);
    });
  }

  private async importarCiclorrutas(): Promise<void> {
    this.progreso.set('Cargando mapa de Bogotá...');

    const response = await fetch('/assets/ciclorrutas_full.geojson');
    const geoJson = await response.json();

    const features = geoJson.features ?? [];
    let importados = 0;
    let omitidos = 0;

    // Batch pequeño (50) para no saturar el bridge Capacitor con strings enormes
    const BATCH_SIZE = 50;
    let batch: string[] = [];

    for (let f = 0; f < features.length; f++) {
      const feature = features[f];
      const { geometry, properties } = feature;

      // Yield al event loop cada 50 features para no bloquear UI ni el bridge
      if (f % 50 === 0 && f > 0) {
        await new Promise(r => setTimeout(r, 0));
      }

      let centerline: [number, number][];

      // Extraer centerline según tipo de geometría
      if (geometry.type === 'Polygon') {
        const ring = geometry.coordinates[0] as [number, number][];
        if (!ring || ring.length < 4) {
          omitidos++;
          continue;
        }
        centerline = extractCenterline(ring);
      } else if (geometry.type === 'MultiPolygon') {
        const ring = geometry.coordinates[0]?.[0] as [number, number][];
        if (!ring || ring.length < 4) {
          omitidos++;
          continue;
        }
        centerline = extractCenterline(ring);
      } else if (geometry.type === 'LineString') {
        // ciclorrutas_test.geojson ya es LineString — usar directo
        centerline = geometry.coordinates as [number, number][];
      } else {
        omitidos++;
        continue;
      }

      if (centerline.length < 2) {
        omitidos++;
        continue;
      }

      const wkt = toWKTLineString(centerline);
      const longitudM = Math.round(calcularLongitudCenterlineM(centerline));

      // Centroide para índice espacial
      const latCentro =
        centerline.reduce((s, p) => s + p[1], 0) / centerline.length;
      const lngCentro =
        centerline.reduce((s, p) => s + p[0], 0) / centerline.length;

      const id = properties?.OBJECTID ?? properties?.objectid ?? properties?.id ?? f;
      const nombre = (
        properties?.NOMBRE ??
        properties?.nombre ??
        properties?.name ??
        `Segmento ${f}`
      ).replace(/'/g, "''");
      const tipo = (
        properties?.TIPO ??
        properties?.tipo ??
        'permanente'
      ).replace(/'/g, "''");

      const escapedWkt = wkt.replace(/'/g, "''");

      batch.push(
        `INSERT OR REPLACE INTO segments (id, nombre, tipo, longitud_m, pendiente, geometry, lat_centro, lng_centro) ` +
          `VALUES (${id}, '${nombre}', '${tipo}', ${longitudM}, 0.0, '${escapedWkt}', ${latCentro.toFixed(6)}, ${lngCentro.toFixed(6)})`
      );

      importados++;

      if (batch.length >= BATCH_SIZE) {
        await this.db.execute(batch.join(';\n') + ';', true);
        batch = [];
      }
    }

    // Flush remaining
    if (batch.length > 0) {
      await this.db.execute(batch.join(';\n') + ';', true);
    }

    console.log(
      `[DatabaseService] Ciclorrutas: ${importados} importadas, ${omitidos} omitidas`
    );
  }

  // ============================================================
  // IMPORTACIÓN DE ZONAS DE PELIGRO
  // ============================================================

  private async importarZonasPeligro(): Promise<void> {
    this.progreso.set('Cargando zonas de seguridad...');

    const response = await fetch('/assets/zonas_peligro_seed.json');
    const data = await response.json();
    const zonas = data.zonas ?? [];

    const statements: string[] = [];

    for (const zona of zonas) {
      const descripcion = (zona.descripcion ?? '').replace(/'/g, "''");
      const tipo = (zona.tipo ?? 'accidente').replace(/'/g, "''");
      statements.push(
        `INSERT INTO zonas_peligro (tipo, descripcion, lat, lng, radio_m, fuente) ` +
          `VALUES ('${tipo}', '${descripcion}', ${zona.lat}, ${zona.lng}, ${zona.radio_m ?? 100}, 'seed')`
      );
    }

    if (statements.length > 0) {
      await this.db.execute(statements.join(';\n') + ';', true);
    }

    console.log(
      `[DatabaseService] Zonas de peligro: ${zonas.length} seed importadas`
    );
  }
}
