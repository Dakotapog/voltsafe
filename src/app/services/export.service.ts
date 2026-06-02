import { Injectable, signal, inject } from '@angular/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { DatabaseService } from './database.service';

/**
 * ExportService — RF-10 (Nodo 17) — Posición 12 (on-demand puro).
 *
 * Genera un GeoJSON RFC 7946 con datos anonimizados de todas las sesiones
 * y lo escribe en Directory.Documents, luego ofrece compartir via Share API.
 *
 * Fuentes SQLite que unifica:
 *   - sesiones       (Nodo 02) → LineString con distancia_m
 *   - impactos       (Nodo 03) → Points BRI con clasificación
 *   - zonas_peligro  (Nodo 06) → Points de peligro
 *   - reportes_genero(Nodo 14) → Points género [con consentimiento]
 *
 * ─────────────────────────────────────────────────────────────────────
 * TTC #15 — Biopsia Urbana (Medicina/Patología → valor institucional DaaS)
 *   Dominio origen: medicina diagnóstica — biopsia de tejido
 *   Puente: en medicina, una biopsia extrae una muestra pequeña y precisa
 *   para diagnosticar la salud de un órgano completo. El GeoJSON de VoltSafe
 *   ES una biopsia de la infraestructura ciclista de Bogotá: unos kilómetros
 *   de ruta + impactos BRI + zonas de peligro = diagnóstico completo del
 *   corredor para que el IDU o IDECA prioricen intervenciones.
 *   Reencuadre: el archivo no es un "backup" — es un "informe diagnóstico
 *   de tejido urbano". Cada bache detectado = célula patológica.
 *   Los metadatos del export incluyen `tipo: "diagnostico_infraestructura"`.
 *   Argumento oral: "El GeoJSON exportado es una biopsia de la red ciclista
 *   de Bogotá: una muestra precisa que el IDU puede usar para diagnosticar
 *   corredores con deterioro infraestructural sin desplazar inspectores."
 *
 * TTC #16 — Estratificación Temporal (Arqueología → SQLite como sedimento)
 *   Dominio origen: arqueología / geología estratigráfica
 *   Puente: los arqueólogos leen la historia a través de capas de sedimento.
 *   Cada capa = una era. Las sesiones SQLite de VoltSafe son estratos:
 *   cada sesión = un depósito temporal de observaciones urbanas.
 *   El GeoJSON exportado contiene TODOS los estratos simultáneamente —
 *   es una sección transversal temporal de la movilidad ciclista en Bogotá.
 *   Implicación técnica: cada export usa nombre con timestamp ISO —
 *   NO sobrescribe el anterior. Cada archivo es un registro histórico
 *   inmutable, como un diario de campo arqueológico.
 *   Con suficientes usuarios: los estratos individuales forman un corpus
 *   colectivo que permite analizar la EVOLUCIÓN de la infraestructura
 *   (¿este bache existía hace 6 meses? ¿esta zona de peligro mejoró?).
 *   Argumento oral: "Cada archivo exportado es un estrato arqueológico:
 *   el corpus colectivo de usuarios permite analizar la evolución temporal
 *   de la infraestructura ciclista — dato que ninguna fuente oficial tiene."
 *
 * TTC #3 (C17 → ENME 2030): features `sesion_autonomia` cuantifican el
 *   "range anxiety gap" real: diferencia entre autonomía predicha y real.
 *   Dato que la ENME necesita para reducir la barrera de adopción de VMPs.
 *
 * Ver: Nodo-17-Estrategia-DaaS, Capacitor-Filesystem.md, TTC-Conexiones-Ocultas.md
 */

export interface ResultadoExport {
  path: string;
  totalFeatures: number;
  sesiones: number;
  impactos: number;
  zonas: number;
  reportesGenero: number;
  fotosRuta: number;
}

@Injectable({ providedIn: 'root' })
export class ExportService {
  private readonly db = inject(DatabaseService);

  /** true mientras genera el GeoJSON */
  readonly exportando = signal(false);

  /** Ruta del último archivo exportado (para botón Compartir) */
  readonly ultimoArchivo = signal<string | null>(null);

  // ── Generación del reporte ────────────────────────────────────────

  /**
   * Genera GeoJSON RFC 7946 con todos los datos anonimizados.
   * Escribe en Directory.Documents con nombre timestamped (TTC #16).
   *
   * @param incluirGenero  true = incluir reportes_genero (requiere consentimiento explícito)
   */
  async generarReporte(incluirGenero = false): Promise<ResultadoExport> {
    this.exportando.set(true);

    try {
      const features: object[] = [];

      // ── 1. Sesiones → LineString (Nodo 02) ──────────────────────
      const sesiones = await this.db.query(
        `SELECT id, distancia_m, duracion_s, geometry,
                bateria_inicio_pct, autonomia_predicha_km
         FROM sesiones
         WHERE fin IS NOT NULL AND geometry IS NOT NULL`
      );

      for (const s of sesiones) {
        const coords = this.wktLineStringToCoords(s.geometry);
        if (coords.length >= 2) {
          features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: {
              tipo: 'ruta',
              distancia_m: Math.round(s.distancia_m ?? 0),
              duracion_s: s.duracion_s ?? 0,
            },
          });
        }

        // TTC #3 (C17→ENME 2030): feature de autonomía por sesión (geometry null)
        // Cuantifica el "range anxiety gap": diferencia predicha vs real
        if (s.bateria_inicio_pct != null || s.autonomia_predicha_km != null) {
          features.push({
            type: 'Feature',
            geometry: null,
            properties: {
              tipo: 'sesion_autonomia',
              bateria_inicio_pct: s.bateria_inicio_pct,
              distancia_real_km:
                s.distancia_m != null
                  ? Math.round((s.distancia_m / 1000) * 10) / 10
                  : null,
              autonomia_predicha_km: s.autonomia_predicha_km,
            },
          });
        }
      }

      // ── 2. Impactos BRI → Points (Nodo 03) ──────────────────────
      const impactos = await this.db.query(
        `SELECT lat, lng, rms, clasificacion
         FROM impactos
         WHERE clasificacion IN ('MODERADO','SEVERO','CRITICO')`
      );

      for (const imp of impactos) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [imp.lng, imp.lat] },
          properties: {
            tipo: 'impacto_superficie',
            clasificacion: imp.clasificacion,
            rms: Math.round(imp.rms * 100) / 100,
          },
        });
      }

      // ── 3. Zonas de peligro → Points (Nodo 06) ──────────────────
      const zonas = await this.db.query(
        `SELECT lat, lng, tipo, radio_m, fuente
         FROM zonas_peligro
         WHERE activa = 1`
      );

      for (const z of zonas) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [z.lng, z.lat] },
          properties: {
            tipo: 'zona_peligro',
            categoria: z.tipo,
            radio_m: z.radio_m,
            fuente: z.fuente,
          },
        });
      }

      // ── 4. Fotos georreferenciadas → Points (Nodo 02, T02-07) ──────
      // TTC #25 — Cadena de Custodia Forense:
      //   La foto_path + lat + lng + sesion_id constituyen evidencia ciudadana
      //   admisible: imagen vinculada al espacio + tiempo + contexto de sesión.
      //   Sin este bloque, los photos points de puntos_ruta no salían al GeoJSON
      //   y la cadena de custodia quedaba rota (evidencia sin soporte espacial).
      const fotos = await this.db.query(
        `SELECT pr.lat, pr.lng, pr.timestamp, pr.foto_path, pr.sesion_id
         FROM puntos_ruta pr
         WHERE pr.foto_path IS NOT NULL AND pr.foto_path != ''`
      );

      for (const f of fotos) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
          properties: {
            tipo: 'foto_ruta',
            sesion_id: f.sesion_id,
            foto_path: f.foto_path,
            // Anonimización: solo fecha (sin hora exacta) para privacidad
            fecha: f.timestamp ? f.timestamp.split('T')[0] : null,
          },
        });
      }

      // ── 5. Reportes género → Points (Nodo 14, solo con consentimiento) ──
      let generoCount = 0;
      if (incluirGenero) {
        const reportes = await this.db.query(
          `SELECT lat, lng, tipo FROM reportes_genero WHERE activo = 1`
        );

        for (const r of reportes) {
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
            properties: {
              tipo: 'reporte_genero',
              categoria: r.tipo,
              // Anonimización: sin fecha, sin ID — solo coordenada + categoría
            },
          });
        }
        generoCount = reportes.length;
      }

      // ── 5. Construir FeatureCollection ───────────────────────────
      // TTC #15 Biopsia Urbana: metadata explica el valor diagnóstico del archivo
      const geojson = {
        type: 'FeatureCollection',
        metadata: {
          app: 'VoltSafe',
          version: '1.0',
          tipo: 'diagnostico_infraestructura',  // TTC #15: biopsia urbana
          generado_en: new Date().toISOString(),
          ciudad: 'Bogota_CO',
          total_features: features.length,
          nota_privacidad:
            'Datos anonimizados — sin timestamps por punto, sin identificador de usuario.',
        },
        features,
      };

      // ── 6. Escribir archivo (TTC #16: nombre timestamped = estrato inmutable)
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      const nombreArchivo = `VoltSafe_${timestamp}.geojson`;

      await Filesystem.writeFile({
        path: nombreArchivo,
        data: JSON.stringify(geojson, null, 2),
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
      });

      this.ultimoArchivo.set(nombreArchivo);

      return {
        path: nombreArchivo,
        totalFeatures: features.length,
        sesiones: sesiones.length,
        impactos: impactos.length,
        zonas: zonas.length,
        reportesGenero: generoCount,
        fotosRuta: fotos.length,
      };
    } finally {
      this.exportando.set(false);
    }
  }

  /**
   * Abre el Share API nativa del SO para enviar el último archivo exportado.
   * El usuario elige el canal: WhatsApp, Gmail, Drive, etc.
   */
  async compartir(): Promise<void> {
    const archivo = this.ultimoArchivo();
    if (!archivo) return;

    try {
      await Share.share({
        title: 'Reporte VoltSafe',
        text: 'Datos de movilidad ciclista en Bogotá — generados por VoltSafe',
        url: archivo,
        dialogTitle: 'Compartir reporte',
      });
    } catch {
      // Si Share no disponible (web/dev), no hacer nada
    }
  }

  // ── Utilidad: WKT LineString → GeoJSON coordinates ───────────────

  /**
   * Convierte WKT "LINESTRING(lng1 lat1, lng2 lat2, ...)"
   * a array GeoJSON [[lng1,lat1],[lng2,lat2],...].
   */
  private wktLineStringToCoords(wkt: string): [number, number][] {
    if (!wkt || !wkt.startsWith('LINESTRING(')) return [];
    const inner = wkt.slice(11, -1); // quita "LINESTRING(" y ")"
    return inner.split(',').map((pair) => {
      const [lng, lat] = pair.trim().split(' ').map(Number);
      return [lng, lat];
    });
  }
}
