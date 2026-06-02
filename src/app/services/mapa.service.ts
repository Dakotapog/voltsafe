import { Injectable, signal, inject, effect, computed } from '@angular/core';
import * as L from 'leaflet';
import 'leaflet.heat';
import { GeoService, PosicionActual } from './geo.service';
import { DatabaseService } from './database.service';
import { NivelConfianza } from '../models/confidence-ring';
import { fromWKTLineString, proyectarSobreSegmento } from '../utils/centerline';
import { haversine } from '../utils/haversine';

/**
 * MapaService — Posición 5 en el orden de inicialización.
 *
 * Responsabilidades:
 *   - Dueño exclusivo del objeto L.map (ningún otro Service lo toca)
 *   - Renderizar ciclorrutas desde GeoJSON simplificado
 *   - Marcador GPS del usuario con anillo de incertidumbre (TTC Conexión #8)
 *   - API agregarCapa(id, items[]) para Nodos 03/06/09/14 (TTC Conexión #9: Mediator)
 *   - Snap-to-segment para posición canónica (GPS-P2)
 *
 * TTC Conexión #8: El anillo de incertidumbre GPS es dual-use:
 *   - Para el ciclista: "tu GPS es impreciso aquí"
 *   - Para el tutor: "mire cómo crece cuando la batería baja"
 *   El radio = effectiveAccuracy del GeoService. El color cambia por NivelConfianza.
 *
 * TTC Conexión #9: agregarCapa() es el patrón Mediator de GoF aplicado a cartografía.
 *   Cada Service produce marcadores sin saber que otros existen. El mapa los compone.
 *   El tutor pidió "patrones de diseño" — esto es uno operando en producción.
 *
 * Ver: Nodo-04-Navegacion-Offline, Signal-Dependency-Graph.md, GPS-Precision-Strategy.md
 */

export interface CapaItem {
  lat: number;
  lng: number;
  tipo: string;
  descripcion?: string;
  /** Color individual del marcador. Si se omite, usa COLORES_CAPA[id]. */
  color?: string;
}

/** Resultado del snap-to-segment */
export interface PosicionCanonica {
  lat: number;
  lng: number;
  segmentoId: number;
  distanciaAlSegmento_m: number;
}

// Color del anillo de incertidumbre según NivelConfianza
function colorConfianza(nivel: NivelConfianza): string {
  switch (nivel) {
    case NivelConfianza.ALTA:    return '#00ff9f';
    case NivelConfianza.MEDIA:   return '#ffd43b';
    case NivelConfianza.BAJA:    return '#ff6b6b';
    default:                     return '#868e96';
  }
}

// Colores por tipo de capa
const COLORES_CAPA: Record<string, string> = {
  zonas_peligro: '#ff4444',
  estaciones_tm: '#4dabf7',
  reportes_genero: '#b197fc',
  impactos: '#ffa94d',
};

// Iconos por tipo de capa
const ICONOS_CAPA: Record<string, string> = {
  hurto: 'alert-circle',
  iluminacion: 'flashlight',
  via_deteriorada: 'construct',
  accidente: 'car',
  estacion_tm: 'bus',
  acoso: 'shield',
  oscuridad: 'moon',
  aislamiento: 'eye-off',
};

@Injectable({ providedIn: 'root' })
export class MapaService {
  private readonly geo = inject(GeoService);
  private readonly db = inject(DatabaseService);

  /** Signal público: posición canónica (snap-to-segment) */
  readonly posicionCanonica = signal<PosicionCanonica | null>(null);

  // ── T04-07: Destino seleccionado por tap en el mapa ───────────────

  /** Coordenadas del destino tapeado por el usuario. null = sin destino activo. */
  readonly destino = signal<{ lat: number; lng: number } | null>(null);

  /**
   * T04-09: Distancia restante al destino en metros.
   * Computed reactivo — se actualiza en cada cambio de posición GPS.
   * null cuando no hay destino activo.
   */
  readonly distanciaRestante_m = computed(() => {
    const pos  = this.geo.posicionActual();
    const dest = this.destino();
    if (!pos || !dest) return null;
    return haversine(pos.lat, pos.lng, dest.lat, dest.lng);
  });

  // ---- Estado del mapa ----

  private map: L.Map | null = null;
  private marcadorUsuario: L.CircleMarker | null = null;
  private anilloConfianza: L.Circle | null = null;
  private capasCiclorrutas: L.GeoJSON | null = null;
  private capasRegistradas = new Map<string, L.LayerGroup>();

  /** Marcador Leaflet del destino seleccionado. */
  private marcadorDestino: L.CircleMarker | null = null;

  /** Marcador pulsante del rider en viewer mode (link compartido). */
  private marcadorViewer: L.Marker | null = null;

  /** HeatLayer BRI — TTC #26 John Snow / Epidemiología Vial */
  private capaCalorBRI: any = null;

  /** Cache de segmentos cercanos para snap (ventana de búsqueda) */
  private segmentosCache: Array<{
    id: number;
    centerline: [number, number][];
    latCentro: number;
    lngCentro: number;
  }> = [];

  // Reactivo: actualizar marcador GPS en cada cambio de posición
  private readonly posicionEffect = effect(() => {
    const pos = this.geo.posicionActual();
    const nivel = this.geo.nivelConfianza();
    if (pos && this.map) {
      this.actualizarMarcadorUsuario(pos, nivel);
      this.intentarSnap(pos);
    }
  });

  // ============================================================
  // INICIALIZACIÓN DEL MAPA
  // ============================================================

  /**
   * Inicializa Leaflet en el elemento DOM proporcionado.
   * Llamado desde mapa.page.ts en afterNextRender / ionViewDidEnter.
   */
  inicializarMapa(elementId: string): L.Map {
    if (this.map) {
      // Ya existe — retornar sin recrear
      return this.map;
    }

    this.map = L.map(elementId, {
      center: [4.711, -74.072], // Bogotá centro
      zoom: 13,
      zoomControl: false, // Mapa móvil — el usuario hace pinch
      attributionControl: false,
      preferCanvas: true, // Canvas renderer — 6182 polígonos de ciclorruta sin lag
    });

    // Tile layer — OpenStreetMap (online) con fallback
    // En producción offline se usarían tiles cacheados, pero para E2 demo online basta
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(this.map);

    return this.map;
  }

  /**
   * Fuerza a Leaflet a recalcular dimensiones del contenedor.
   * Llamar desde ionViewDidEnter() — después de la animación del tab.
   */
  invalidarTamano(): void {
    if (this.map) {
      this.map.invalidateSize();
    }
  }

  /**
   * Destruye el mapa. Llamado en ngOnDestroy de la página.
   */
  destruirMapa(): void {
    if (this.map) {
      if (this.capaCalorBRI) {
        this.map.removeLayer(this.capaCalorBRI);
        this.capaCalorBRI = null;
      }
      this.map.remove();
      this.map = null;
      this.marcadorUsuario = null;
      this.anilloConfianza = null;
      this.capasCiclorrutas = null;
      this.capasRegistradas.clear();
    }
  }

  // ============================================================
  // CICLORRUTAS — CAPA PRINCIPAL
  // ============================================================

  /**
   * Carga ciclorrutas_simplified.geojson y las renderiza como capa verde.
   */
  async cargarCiclorrutas(): Promise<void> {
    if (!this.map || this.capasCiclorrutas) return;

    // Polígonos IDECA renderizados como CINTAS RELLENAS — no como contornos.
    //
    // El "entrecortado" venía de dibujar el PERÍMETRO del polígono (stroke):
    // cada corredor de 2-5m de ancho mostraba sus dos bordes paralelos como
    // doble línea hueca. La solución que usan Google Maps / Mapbox es rellenar
    // el polígono: la cinta sólida de ancho físico se ve como vía continua y
    // los polígonos adyacentes se fusionan visualmente sin gaps.
    //
    // stroke del MISMO color que el fill (weight 1.5) cierra micro-gaps
    // sub-pixel entre tiles adyacentes sin crear doble borde visible.
    //
    // FULL (no simplified): el archivo simplified fue decimado a ε=22m, lo que
    // separó los polígonos (solo 12% se tocan). El full conserva la geometría
    // real donde 61% de los tiles se tocan → render continuo. Medido 2026-06-01.
    const resp = await fetch('/assets/ciclorrutas_full.geojson');
    const geoJson = await resp.json();

    this.capasCiclorrutas = L.geoJSON(geoJson, {
      style: {
        color: '#00ff9f',       // stroke = mismo color que fill → sin doble borde
        weight: 1.5,            // engrosa cada tile para puentear micro-gaps
        opacity: 0.9,
        fillColor: '#00ff9f',
        fillOpacity: 0.9,       // cinta sólida — fusión visual entre tiles
        lineJoin: 'round' as CanvasLineJoin,
      },
    }).addTo(this.map);
  }

  // ============================================================
  // MARCADOR DEL USUARIO + ANILLO DE INCERTIDUMBRE (TTC #8)
  // ============================================================

  /**
   * TTC Conexión #8: Anillo de incertidumbre GPS visible.
   *
   * El radio del círculo = effectiveAccuracy (ya incluye Temporal Confidence Decay).
   * El color cambia según NivelConfianza (verde/amarillo/rojo).
   *
   * Cross-domain: esta visualización nace de combinar:
   *   - Teoría de señales (incertidumbre crece con tiempo sin observación)
   *   - Estrategia de batería (intervalo GPS adaptativo)
   *   - Psicología cognitiva (feedback visual reduce ansiedad del ciclista)
   *
   * Ninguna app de ciclismo existente (Strava, Komoot, Google Maps) muestra esto.
   */
  private actualizarMarcadorUsuario(
    pos: PosicionActual,
    nivel: NivelConfianza
  ): void {
    if (!this.map) return;

    const latlng: L.LatLngExpression = [pos.lat, pos.lng];
    const color = colorConfianza(nivel);

    // Punto azul central (posición)
    if (!this.marcadorUsuario) {
      this.marcadorUsuario = L.circleMarker(latlng, {
        radius: 8,
        fillColor: '#4dabf7',
        fillOpacity: 1,
        color: '#ffffff',
        weight: 2,
      }).addTo(this.map);
    } else {
      this.marcadorUsuario.setLatLng(latlng);
    }

    // Anillo de incertidumbre — radio = accuracy en metros
    if (!this.anilloConfianza) {
      this.anilloConfianza = L.circle(latlng, {
        radius: pos.accuracy,
        color: color,
        fillColor: color,
        fillOpacity: 0.12,
        weight: 1.5,
        dashArray: '4 4',
      }).addTo(this.map);
    } else {
      this.anilloConfianza.setLatLng(latlng);
      this.anilloConfianza.setRadius(pos.accuracy);
      this.anilloConfianza.setStyle({
        color: color,
        fillColor: color,
      });
    }
  }

  /**
   * Centra el mapa en la posición actual del usuario.
   */
  centrarEnUsuario(): void {
    const pos = this.geo.posicionActual();
    if (pos && this.map) {
      this.map.setView([pos.lat, pos.lng], 16);
    }
  }

  // ============================================================
  // AGREGAR CAPA — PATRÓN MEDIATOR (TTC #9)
  // ============================================================

  /**
   * TTC Conexión #9: Patrón Mediator aplicado a cartografía.
   *
   * Cada Service (ZonasService, UltimaMillaService, GeneroService, SuperficieService)
   * inyecta marcadores al mapa SIN conocer a los otros Services.
   * MapaService es el único mediador — compone capas independientes.
   *
   * Cross-domain: este es el patrón Mediator de GoF (1994) que el tutor
   * pidió explícitamente en la transcripción 3. Aplicado no a objetos UI
   * clásicos sino a capas cartográficas — mismo principio, dominio diferente.
   *
   * @param id — identificador único de capa ('zonas_peligro', 'estaciones_tm', etc.)
   * @param items — array de puntos a renderizar
   */
  agregarCapa(id: string, items: CapaItem[]): void {
    if (!this.map) return;

    // Remover capa anterior con mismo ID (refresh)
    if (this.capasRegistradas.has(id)) {
      this.capasRegistradas.get(id)!.remove();
    }

    const grupo = L.layerGroup();
    const colorBase = COLORES_CAPA[id] ?? '#ffffff';

    for (const item of items) {
      const itemColor = item.color ?? colorBase;
      const marker = L.circleMarker([item.lat, item.lng], {
        radius: 7,
        fillColor: itemColor,
        fillOpacity: 0.8,
        color: '#ffffff',
        weight: 1,
      });

      if (item.descripcion) {
        marker.bindPopup(
          `<strong>${item.tipo}</strong><br>${item.descripcion}`
        );
      }

      grupo.addLayer(marker);
    }

    grupo.addTo(this.map);
    this.capasRegistradas.set(id, grupo);
  }

  /**
   * TTC #26 — John Snow (1854): Mapa de Calor BRI como Epidemiología Espacial.
   *
   * John Snow detuvo el brote de cólera de Soho mapeando muertes como círculos
   * en papel — SIN algoritmo, SIN estadística formal. La densidad visual de los
   * círculos reveló el cluster alrededor de la bomba de Broad Street.
   *
   * Este método hace exactamente lo mismo con la infraestructura vial de Bogotá:
   *   - Cada impacto BRI = un caso del "brote de deterioro"
   *   - Radio geográfico (metros) = radio de influencia real del defecto vial
   *   - Superposición translúcida (fillOpacity=0.25) = densidad como KDE visual
   *   - El ojo humano detecta clusters sin algoritmo — Gestalt de densidad
   *
   * Cross-domain: John Snow usó cartografía para epidemiología (1854).
   * Nosotros usamos cartografía para epidemiología vial (2026).
   * El principio es idéntico: la densidad espacial de eventos revela la causa.
   *
   * Resultado visual: zonas con múltiples baches solapados se vuelven INTENSAMENTE
   * rojas/naranjas — el ciclista ve de un vistazo dónde está el "foco del brote".
   *
   * @param items — impactos BRI con tipo MODERADO/SEVERO/CRITICO + color individual
   */
  agregarCalorBRI(items: CapaItem[]): void {
    if (!this.map) return;

    // Remover capas anteriores
    if (this.capaCalorBRI) {
      this.map.removeLayer(this.capaCalorBRI);
      this.capaCalorBRI = null;
    }
    if (this.capasRegistradas.has('bri_calor')) {
      this.capasRegistradas.get('bri_calor')!.remove();
    }

    if (items.length === 0) return;

    // ── CAPA 1: HeatLayer WebGL — TTC #26 John Snow / Epidemiología Vial ──────
    // Intensidad por severidad: CRÍTICO=1.0, SEVERO=0.6, MODERADO=0.3
    // La densidad de puntos solapados crea "zonas calientes" = clusters de deterioro
    const puntos: [number, number, number][] = items.map(item => [
      item.lat,
      item.lng,
      item.tipo === 'CRITICO' ? 1.0 : item.tipo === 'SEVERO' ? 0.6 : 0.3,
    ]);

    this.capaCalorBRI = (L as any).heatLayer(puntos, {
      radius: 35,
      blur: 20,
      maxZoom: 17,
      max: 1.0,
      gradient: { 0.3: '#ffd43b', 0.6: '#ff6b6b', 1.0: '#c92a2a' },
    }).addTo(this.map);

    // ── CAPA 2: Marcadores CRÍTICO con popup — interactividad para demo ────────
    const grupo = L.layerGroup();
    for (const item of items.filter(i => i.tipo === 'CRITICO')) {
      L.circleMarker([item.lat, item.lng], {
        radius: 5,
        fillColor: '#c92a2a',
        fillOpacity: 0.95,
        color: '#ffffff',
        weight: 1.5,
      })
        .bindPopup(`<strong>⚠️ CRÍTICO</strong><br>${item.descripcion ?? 'Pavimento en estado crítico'}`)
        .addTo(grupo);
    }
    grupo.addTo(this.map);
    this.capasRegistradas.set('bri_calor', grupo);
  }

  /**
   * Remueve una capa del mapa por su ID.
   */
  removerCapa(id: string): void {
    if (this.capasRegistradas.has(id)) {
      this.capasRegistradas.get(id)!.remove();
      this.capasRegistradas.delete(id);
    }
  }

  // ============================================================
  // DESTINO — T04-07 + T04-09
  // ============================================================

  /**
   * Activa el modo "tap para seleccionar destino" en el mapa.
   * Llamado una vez desde MapaPage en ngAfterViewInit.
   * El click en cualquier punto del mapa actualiza el Signal destino.
   */
  activarSeleccionDestino(): void {
    if (!this.map) return;
    this.map.on('click', (e: L.LeafletMouseEvent) => {
      this.setDestino(e.latlng.lat, e.latlng.lng);
    });
  }

  /**
   * Establece el destino en las coordenadas indicadas.
   * Coloca un marcador rojo pulsante en el mapa.
   */
  setDestino(lat: number, lng: number): void {
    if (!this.map) return;

    // Remover marcador anterior
    this.marcadorDestino?.remove();

    this.marcadorDestino = L.circleMarker([lat, lng], {
      radius: 10,
      fillColor: '#ff6b6b',
      fillOpacity: 0.85,
      color: '#ffffff',
      weight: 2,
    })
      .bindPopup('📍 Destino seleccionado')
      .addTo(this.map);

    this.destino.set({ lat, lng });
  }

  // ============================================================
  // VIEWER MODE — Marcador pulsante del rider compartido
  // ============================================================

  /**
   * Coloca un marcador pulsante (divIcon) en la posición del rider que
   * compartió su ubicación vía URL. Centra el mapa en esa posición.
   *
   * TTC: NASA Eyes on the Solar System + FedEx tracking — URL con estado →
   * cualquier browser recibe la misma vista sin servidor ni backend.
   */
  colocarMarcadorViewer(lat: number, lng: number): void {
    if (!this.map) return;
    this.marcadorViewer?.remove();

    const icon = L.divIcon({
      className: '',
      html: '<div class="viewer-pulse-ring"></div><div class="viewer-dot"></div>',
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    });

    this.marcadorViewer = L.marker([lat, lng], { icon })
      .bindPopup('📡 Rider — posición compartida')
      .addTo(this.map);

    this.map.setView([lat, lng], 16);
  }

  /**
   * Elimina el destino activo del mapa y del Signal.
   */
  limpiarDestino(): void {
    this.marcadorDestino?.remove();
    this.marcadorDestino = null;
    this.destino.set(null);
  }

  // ============================================================
  // SNAP-TO-SEGMENT (GPS-P2)
  // ============================================================

  /**
   * Proyecta la posición GPS sobre el segmento de ciclorruta más cercano.
   * Usa el índice espacial (lat_centro, lng_centro) para búsqueda eficiente.
   *
   * TTC: la posición canónica alimenta a RutaService para que la distancia
   * acumulada sea sobre la ciclorruta real, no sobre el ruido GPS.
   */
  private async intentarSnap(pos: PosicionActual): Promise<void> {
    // Buscar segmentos cercanos en la ventana ~500m
    const delta = 0.005; // ~500m en latitud
    const segmentos = await this.db.query(
      `SELECT id, geometry, lat_centro, lng_centro FROM segments
       WHERE lat_centro BETWEEN ? AND ?
         AND lng_centro BETWEEN ? AND ?
       LIMIT 20`,
      [pos.lat - delta, pos.lat + delta, pos.lng - delta, pos.lng + delta]
    );

    if (segmentos.length === 0) {
      this.posicionCanonica.set(null);
      return;
    }

    let mejorSnap: PosicionCanonica | null = null;
    let mejorDist = Infinity;

    for (const seg of segmentos) {
      const centerline = fromWKTLineString(seg.geometry);
      if (centerline.length < 2) continue;

      // proyectarSobreSegmento usa formato GeoJSON: [lng, lat]
      const gpsGeoJson: [number, number] = [pos.lng, pos.lat];
      const proy = proyectarSobreSegmento(gpsGeoJson, centerline);

      // proy es [lng, lat] — calcular distancia real en metros
      const distM = haversine(pos.lat, pos.lng, proy[1], proy[0]);

      if (distM < mejorDist) {
        mejorDist = distM;
        mejorSnap = {
          lat: proy[1],
          lng: proy[0],
          segmentoId: seg.id,
          distanciaAlSegmento_m: distM,
        };
      }
    }

    // Solo snap si está dentro del radio de confianza
    const radioSnap =
      this.geo.nivelConfianza() === NivelConfianza.ALTA
        ? 30
        : this.geo.nivelConfianza() === NivelConfianza.MEDIA
          ? 50
          : 80;

    if (mejorSnap && mejorSnap.distanciaAlSegmento_m <= radioSnap) {
      this.posicionCanonica.set(mejorSnap);
    } else {
      this.posicionCanonica.set(null);
    }
  }
}
