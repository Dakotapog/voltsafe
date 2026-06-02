import { Injectable, signal, inject } from '@angular/core';
import { Geolocation } from '@capacitor/geolocation';
import { DatabaseService } from './database.service';
import { GeoService } from './geo.service';
import { RutaService } from './ruta.service';
import { MapaService } from './mapa.service';

/**
 * GeneroService — RF-08 (Nodo 14) — Posición 11 (on-demand)
 *
 * Produce: Signal reportesGenero[] → capa morada en MapaService
 * Consume:
 *   - posicionActual (← GeoService, si sesión activa)
 *   - sesionActiva (← RutaService, para elegir fuente de posición)
 *   - alertaActiva (← ZonasService → SesionPage FAB pulse)
 *
 * Persiste: tabla reportes_genero en SQLite
 *
 * UX crítica: "Denuncia Rápida" en ≤ 2 taps, ≤ 3 segundos.
 * FAB morado siempre visible durante sesión activa.
 * Sin formulario, sin texto obligatorio, sin confirmación bloqueante.
 *
 * ═══════════════════════════════════════════════════════════
 * TTC CROSS-DOMAIN CONNECTIONS
 * ═══════════════════════════════════════════════════════════
 *
 * TTC #10 — Efecto Espectador Invertido (Darley & Latané, 1968)
 *   El Bystander Effect dice que la presencia de otros REDUCE la probabilidad
 *   de que alguien actúe. El FAB pulsante invierte esto: cuando alertaActiva
 *   = true (zona de peligro detectada), la app SE CONVIERTE en el espectador
 *   que NO es pasivo. La animación es una intervención digital de espectador
 *   que rompe el ciclo de pasividad. Ninguna app de movilidad hace esto.
 *
 * TTC #11 — Teoría de Ventanas Rotas Computacional (Wilson & Kelling, 1982)
 *   El pipeline C03→C06 (acelerómetro → autoSeedDesdeImpacto → zonas_peligro)
 *   ES la versión computacional de Broken Windows Theory. Un bache detectado
 *   por el sensor señala inversión infraestructural baja, que correlaciona con
 *   mayor violencia de género en Bogotá. El acelerómetro detecta las "ventanas
 *   rotas" que el urbanismo preventivo necesita para priorizar.
 *
 * TTC #12 — Epidemiología Visual (KDE → capas Leaflet)
 *   La superposición de capa roja (zonas_peligro) + morada (reportes_genero)
 *   en MapaService ES una kernel density estimation visual. El ojo humano
 *   identifica clusters de inseguridad sin algoritmo. Esto es exactamente
 *   lo que la Secretaría de la Mujer de Bogotá necesita para intervenciones.
 *
 * Ver: Nodo-14-Seguridad-de-Genero.md
 */

export type TipoReporteGenero = 'acoso' | 'oscuridad' | 'aislamiento';

export interface ReporteGenero {
  id?: number;
  tipo: TipoReporteGenero;
  descripcion: string;
  lat: number;
  lng: number;
  fecha: string;
}

@Injectable({ providedIn: 'root' })
export class GeneroService {
  private readonly db = inject(DatabaseService);
  private readonly geo = inject(GeoService);
  private readonly ruta = inject(RutaService);
  private readonly mapa = inject(MapaService);

  /** Todos los reportes activos — alimenta la capa morada en el mapa */
  readonly reportesGenero = signal<ReporteGenero[]>([]);

  /** Indica si los reportes ya fueron cargados de SQLite */
  private cargado = false;

  // ============================================================
  // CARGA INICIAL
  // ============================================================

  /**
   * Carga todos los reportes activos de SQLite.
   * Llamado al abrir la pantalla de mapa o al primer reporte.
   */
  async cargar(): Promise<void> {
    if (this.cargado) return;

    const rows = await this.db.query(
      'SELECT id, tipo, descripcion, lat, lng, fecha FROM reportes_genero WHERE activo = 1'
    );

    this.reportesGenero.set(
      rows.map((r) => ({
        id: r.id,
        tipo: r.tipo as TipoReporteGenero,
        descripcion: r.descripcion ?? '',
        lat: r.lat,
        lng: r.lng,
        fecha: r.fecha,
      }))
    );

    this.cargado = true;
    this.actualizarCapaMapa();
  }

  // ============================================================
  // REGISTRO DE REPORTE — "DENUNCIA RÁPIDA" (≤ 2 taps, ≤ 3s)
  // ============================================================

  /**
   * Registra un reporte de seguridad de género.
   *
   * Flujo UX:
   *   Tap 1: FAB morado
   *   Tap 2: seleccionar categoría en action-sheet
   *   → INSERT SQLite + marcador morado en mapa + toast 1.5s
   *
   * TTC #10 (Bystander Effect inversion):
   *   Si alertaActiva = true al momento del reporte, el FAB estaba pulsando.
   *   La app ya había "intervenido" como espectador digital — el reporte
   *   es la acción que completa el ciclo de intervención.
   *
   * @param tipo — 'acoso' | 'oscuridad' | 'aislamiento'
   * @param descripcion — opcional, no bloqueante
   */
  async registrarReporte(
    tipo: TipoReporteGenero,
    descripcion: string = ''
  ): Promise<ReporteGenero> {
    // Obtener posición: del Signal si hay sesión, o getCurrentPosition
    let lat: number, lng: number;
    const posActual = this.ruta.sesionActiva()
      ? this.geo.posicionActual()
      : null;

    if (posActual) {
      lat = posActual.lat;
      lng = posActual.lng;
    } else {
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
      });
      lat = pos.coords.latitude;
      lng = pos.coords.longitude;
    }

    // INSERT en SQLite
    await this.db.run(
      'INSERT INTO reportes_genero (tipo, descripcion, lat, lng) VALUES (?, ?, ?, ?)',
      [tipo, descripcion, lat, lng]
    );

    // Obtener el registro recién creado (con id y fecha auto-generados)
    const rows = await this.db.query(
      'SELECT id, tipo, descripcion, lat, lng, fecha FROM reportes_genero ORDER BY id DESC LIMIT 1'
    );

    const nuevo: ReporteGenero = {
      id: rows[0]?.id,
      tipo,
      descripcion,
      lat,
      lng,
      fecha: rows[0]?.fecha ?? new Date().toISOString(),
    };

    // Actualizar Signal reactivo
    this.reportesGenero.update((list) => [...list, nuevo]);

    // Actualizar capa morada en mapa
    this.actualizarCapaMapa();

    console.log(
      `[GeneroService] Reporte registrado: ${tipo} en (${lat.toFixed(5)}, ${lng.toFixed(5)})`
    );

    return nuevo;
  }

  // ============================================================
  // CAPA LEAFLET MORADA — VIA MAPASERVICE.AGREGARCAPA (TTC #9 Mediator)
  // ============================================================

  /**
   * Envía todos los reportes al mapa como capa 'reportes_genero'.
   *
   * TTC #12 (Epidemiología visual):
   *   Esta capa morada + la capa roja de zonas_peligro forman una
   *   "KDE visual" — el ojo humano identifica clusters de inseguridad.
   *   Es el dato que la Secretaría de la Mujer necesita sin algoritmo.
   */
  private actualizarCapaMapa(): void {
    const reportes = this.reportesGenero();
    if (reportes.length === 0) return;

    this.mapa.agregarCapa(
      'reportes_genero',
      reportes.map((r) => ({
        lat: r.lat,
        lng: r.lng,
        tipo: r.tipo,
        descripcion: `${this.etiquetaTipo(r.tipo)} — ${r.fecha}${r.descripcion ? ': ' + r.descripcion : ''}`,
      }))
    );
  }

  /** Etiqueta legible para la UI */
  etiquetaTipo(tipo: TipoReporteGenero): string {
    switch (tipo) {
      case 'acoso':
        return 'Acoso / Intimidación';
      case 'oscuridad':
        return 'Zona oscura / Sin iluminación';
      case 'aislamiento':
        return 'Aislamiento / Sin personas';
    }
  }
}
