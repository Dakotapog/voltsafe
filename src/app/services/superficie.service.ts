import { Injectable, signal, inject, effect } from '@angular/core';
import { SensorService } from './sensor.service';
import { GeoService } from './geo.service';
import { ZonasService } from './zonas.service';
import { DatabaseService } from './database.service';
import { MapaService, CapaItem } from './mapa.service';
import { HapticsService } from './haptics.service';

/**
 * SuperficieService — RF-03 (Nodo 03) — Posición 4 en el orden de inicialización.
 *
 * Produce:
 *   - Signal briActual: 'SUAVE' | 'MODERADO' | 'SEVERO' | 'CRITICO'
 *   - Signal impactoDetectado: {clasificacion, rms, lat, lng} (solo SEVERO/CRITICO)
 *
 * Consume:
 *   - Signal aceleracionRaw ← SensorService (stream 100Hz adaptativo)
 *   - Signal posicionActual  ← GeoService (georeferenciar impacto)
 *
 * Algoritmo:
 *   1. Filtro paso alto alfa=0.8 → remover componente gravitacional
 *   2. Ventana deslizante 50 muestras → calcular RMS
 *   3. Clasificar por umbrales BRI
 *   4. MODERADO+: INSERT SQLite tabla impactos
 *   5. SEVERO+: emitir impactoDetectado → ZonasService.autoSeedDesdeImpacto()
 *
 * ─────────────────────────────────────────────────────────────────────
 * TTC #17 — Red Sismográfica Distribuida (Geofísica → BRI como red colectiva)
 *   SuperficieService es el procesador DSP de cada nodo sísmico urbano.
 *   Como las estaciones IRIS/USGS filtran el ruido sísmico antes de reportar,
 *   SuperficieService filtra la gravedad (filtro paso alto) y calcula la
 *   "magnitud local" del evento (RMS). La clasificación BRI es equivalente
 *   a la escala de Richter: cuantifica la energía del evento vial.
 *   Ver TTC #17 en SensorService para el argumento oral completo.
 *
 * TTC #18 — Resonancia Mecánica del Sistema Ciclista (Física de vibraciones)
 *   Dominio origen: ingeniería mecánica — análisis de vibración de sistemas
 *   masa-resorte-amortiguador (modelo de Kelvin-Voigt para pavimento)
 *   Puente: la ventana de 50 muestras (0.5s a 100Hz) NO es arbitraria.
 *   Es la frecuencia natural del sistema ciclista:
 *   - Frecuencia natural rueda de bici: 10-20 Hz
 *   - Frecuencia natural bici + ciclista (suspensión biológica): 2-5 Hz
 *   - Tiempo de cruce de un bache a 20 km/h (2m ancho): 0.36s ≈ 36 muestras
 *   - Tiempo de decaimiento de la respuesta resonante del sistema: ~0.5s
 *   La ventana de 0.5s captura el CICLO COMPLETO del evento:
 *   impacto inicial + resonancia del cuadro + amortiguamiento muscular.
 *   Una ventana más corta pierde la energía resonante. Una más larga promedia
 *   dos eventos distintos. 50 muestras / 0.5s es la solución óptima.
 *   Argumento oral: "La ventana de 50 muestras no es arbitraria — deriva de
 *   la frecuencia natural del sistema ciclista (2-5 Hz, modelo Kelvin-Voigt).
 *   Captura el ciclo completo: impacto + resonancia + amortiguamiento.
 *   Es la solución de la ecuación diferencial de segundo orden del sistema
 *   masa-resorte ciclista sobre pavimento urbano de Bogotá."
 *
 * C03→C06: impactoDetectado SEVERO+ → ZonasService.autoSeedDesdeImpacto()
 *   Implementa TTC #11 (Ventanas Rotas Computacional, Wilson & Kelling 1982)
 *
 * C03→C01: tabla impactos → AutonomiaService.calcularFactorSuperficie()
 *   Superficies deterioradas aumentan consumo energético +8-15%
 *
 * Ver: Nodo-03-Deteccion-Superficie, Capacitor-Motion.md, TTC-Conexiones-Ocultas.md
 */

export type ClasificacionBRI = 'SUAVE' | 'MODERADO' | 'SEVERO' | 'CRITICO';

export interface ImpactoDetectado {
  clasificacion: ClasificacionBRI;
  rms: number;
  lat: number;
  lng: number;
}

/** Umbrales BRI en m/s² (RMS de aceleración lineal) */
const UMBRAL_MODERADO  =  2.0;
const UMBRAL_SEVERO    =  8.0;
const UMBRAL_CRITICO   = 87.3; // FII — evento excepcional (NotebookLM spec)

/** Ventana deslizante — TTC #18: 50 muestras = 0.5s = ciclo resonante del sistema ciclista */
const VENTANA_MUESTRAS = 50;

/** Filtro paso alto — α=0.8 para remover componente gravitacional (Capacitor-Motion.md §6) */
const ALPHA_FILTRO = 0.8;

@Injectable({ providedIn: 'root' })
export class SuperficieService {
  private readonly sensor  = inject(SensorService);
  private readonly geo     = inject(GeoService);
  private readonly zonas   = inject(ZonasService);
  private readonly db      = inject(DatabaseService);
  private readonly mapa    = inject(MapaService);
  private readonly haptics = inject(HapticsService);

  /**
   * Cache en memoria de impactos para la capa BRI del mapa.
   * Patrón idéntico a GeneroService: cargar() llena desde SQLite,
   * persistirImpacto() agrega en vivo durante sesión activa.
   *
   * TTC #19 — Evidencia Forense (Epistemología Jurídica):
   *   Los impactos BRI son la capa de MAYOR jerarquía probatoria del mapa.
   *   Evidencia objetiva del acelerómetro — no puede ser fabricada ni sesgada.
   *   Ver: TTC-Conexiones-Ocultas.md §19
   */
  private impactosParaMapa: CapaItem[] = [];

  // ── Signals públicos ──────────────────────────────────────────────

  /** Clasificación BRI del momento actual — se actualiza cada 50 muestras (~0.5s) */
  readonly briActual = signal<ClasificacionBRI>('SUAVE');

  /**
   * Emite solo cuando la clasificación es SEVERO o CRITICO.
   * Consumido por ZonasService para auto-seed y por MapaService para capa visual.
   */
  readonly impactoDetectado = signal<ImpactoDetectado | null>(null);

  /**
   * Magnitud filtrada por muestra — actualización a ~100Hz.
   * Consumido exclusivamente por BriSeismographComponent para visualización.
   * Es la aceleración lineal (sin gravedad) post filtro paso alto — la señal
   * cruda que el seismógrafo dibuja como onda continua.
   * NO usar para lógica de clasificación: el RMS ventaneado es más preciso.
   */
  readonly magnitudFiltrada = signal(0);

  /** ID de sesión activa — para vincular impactos en SQLite */
  private sesionId: number | null = null;

  // ── Estado del filtro paso alto (persistente entre muestras) ─────

  private gravity = { x: 0, y: 0, z: 9.8 }; // inicializar en reposo vertical
  private ventana: number[] = [];

  // ── Effect: procesar en cada muestra del acelerómetro ────────────

  /**
   * Effect reactivo: se ejecuta en cada emisión de aceleracionRaw.
   * Zoneless — no accede a zone.js → sin lag a 100Hz.
   */
  private readonly accelEffect = effect(() => {
    const raw = this.sensor.aceleracionRaw();
    if (raw !== null) {
      this.procesarMuestra(raw.ax, raw.ay, raw.az);
    }
  });

  // ── API pública ───────────────────────────────────────────────────

  /**
   * Establece el ID de sesión activa para asociar impactos en SQLite.
   * Llamado desde RutaService al iniciar sesión.
   */
  setSesionId(id: number | null): void {
    this.sesionId = id;
  }

  /**
   * Resetea el estado del filtro al iniciar una nueva sesión.
   */
  reset(): void {
    this.gravity = { x: 0, y: 0, z: 9.8 };
    this.ventana = [];
    this.briActual.set('SUAVE');
    this.impactoDetectado.set(null);
  }

  // ── Procesamiento BRI ─────────────────────────────────────────────

  /**
   * Procesa una muestra de aceleración.
   * TTC #18: ventana de 50 muestras = ciclo resonante del sistema ciclista.
   */
  private procesarMuestra(ax: number, ay: number, az: number): void {
    // ── Paso 1: Filtro paso alto α=0.8 — remover gravedad ──────────
    // El componente lento (gravedad + orientación del teléfono) se estima
    // con un filtro IIR de primer orden y se sustrae.
    this.gravity.x = ALPHA_FILTRO * this.gravity.x + (1 - ALPHA_FILTRO) * ax;
    this.gravity.y = ALPHA_FILTRO * this.gravity.y + (1 - ALPHA_FILTRO) * ay;
    this.gravity.z = ALPHA_FILTRO * this.gravity.z + (1 - ALPHA_FILTRO) * az;

    const linX = ax - this.gravity.x;
    const linY = ay - this.gravity.y;
    const linZ = az - this.gravity.z;

    // ── Paso 2: Magnitud escalar del vector de aceleración lineal ──
    const magnitud = Math.sqrt(linX * linX + linY * linY + linZ * linZ);
    this.magnitudFiltrada.set(magnitud); // alimenta el seismógrafo en tiempo real
    this.ventana.push(magnitud);

    // ── Paso 3: Calcular RMS al completar ventana ──────────────────
    // TTC #18: 50 muestras = 0.5s = frecuencia natural del sistema ciclista
    if (this.ventana.length >= VENTANA_MUESTRAS) {
      const sumasCuadrados = this.ventana.reduce((s, v) => s + v * v, 0);
      const rms = Math.sqrt(sumasCuadrados / this.ventana.length);
      this.ventana = []; // resetear ventana

      this.clasificarRMS(rms);
    }
  }

  /**
   * Clasifica el RMS y emite Signals + persiste en SQLite.
   */
  private clasificarRMS(rms: number): void {
    const clasificacion = this.calcularClasificacion(rms);
    this.briActual.set(clasificacion);

    // SUAVE: no persistir — minimizar escrituras y consumo de batería
    if (clasificacion === 'SUAVE') return;

    const pos = this.geo.posicionActual();
    const lat = pos?.lat ?? 0;
    const lng = pos?.lng ?? 0;

    // ── MODERADO+: INSERT en SQLite tabla impactos ─────────────────
    this.persistirImpacto(clasificacion, rms, lat, lng);

    // ── SEVERO/CRITICO: emitir Signal + auto-seed zona peligro ─────
    // Implementa TTC #11 (Ventanas Rotas) + C03→C06 pipeline
    if (clasificacion === 'SEVERO' || clasificacion === 'CRITICO') {
      this.impactoDetectado.set({ clasificacion, rms, lat, lng });
      // Feedback táctil síncrono al impacto — el ciclista lo siente en el mismo instante
      this.haptics.bacheDetectado().catch(() => {});
      // Auto-seed pasivo: bache SEVERO → zona via_deteriorada (sin UI)
      this.zonas.autoSeedDesdeImpacto(lat, lng, clasificacion).catch(() => {});
    }
  }

  private calcularClasificacion(rms: number): ClasificacionBRI {
    if (rms >= UMBRAL_CRITICO)  return 'CRITICO';
    if (rms >= UMBRAL_SEVERO)   return 'SEVERO';
    if (rms >= UMBRAL_MODERADO) return 'MODERADO';
    return 'SUAVE';
  }

  /** Persiste en SQLite de forma async (no bloquea el effect a 100Hz) */
  private persistirImpacto(
    clasificacion: ClasificacionBRI,
    rms: number,
    lat: number,
    lng: number
  ): void {
    const sesionId = this.sesionId;
    if (sesionId === null) return; // sin sesión activa: no persistir

    this.db
      .run(
        'INSERT INTO impactos (sesion_id, lat, lng, rms, clasificacion, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
        [
          sesionId,
          lat,
          lng,
          Math.round(rms * 100) / 100,
          clasificacion,
          new Date().toISOString(),
        ]
      )
      .then(() => {
        // Agregar al cache en memoria y actualizar capa del mapa en vivo
        this.impactosParaMapa.push({
          lat,
          lng,
          tipo: clasificacion,
          descripcion: `BRI ${clasificacion} — ${Math.round(rms * 100) / 100} m/s²`,
          color: this.colorClasificacion(clasificacion),
        });
        this.actualizarCapaMapa();
      })
      .catch((err) =>
        console.error('[SuperficieService] Error INSERT impacto:', err)
      );
  }

  // ============================================================
  // CAPA BRI EN MAPA — T03-07 (TTC #19: Evidencia Forense)
  // ============================================================

  /**
   * Carga todos los impactos históricos de SQLite y los renderiza en el mapa.
   * Llamado desde MapaPage al abrir la pantalla — igual que ZonasService.cargarZonas().
   *
   * TTC #19 — Jerarquía Probatoria:
   *   Los impactos BRI son evidencia forense — objetiva, no fabricable, reproducible.
   *   Al cargar en el mapa, el ciclista ve el "registro forense" de la infraestructura:
   *   qué segmentos tienen deterioro medido por sensor, no reportado por memoria.
   */
  async cargar(): Promise<void> {
    const rows = await this.db.query(
      `SELECT lat, lng, clasificacion, rms FROM impactos
       WHERE clasificacion IN ('MODERADO','SEVERO','CRITICO')
       ORDER BY id DESC LIMIT 500`  // Límite: 500 puntos máximo en mapa
    );

    this.impactosParaMapa = rows.map((r) => ({
      lat: r.lat,
      lng: r.lng,
      tipo: r.clasificacion,
      descripcion: `BRI ${r.clasificacion} — ${r.rms} m/s²`,
      color: this.colorClasificacion(r.clasificacion),
    }));

    this.actualizarCapaMapa();
  }

  /**
   * Envía la capa de impactos al mapa como mapa de calor BRI (TTC #26 John Snow).
   * Usa agregarCalorBRI() → círculos geográficos translúcidos que se superponen
   * creando densidad visual — la epidemiología espacial de John Snow (1854).
   * Si el mapa no está abierto, la llamada se descarta silenciosamente.
   */
  private actualizarCapaMapa(): void {
    if (this.impactosParaMapa.length === 0) return;
    this.mapa.agregarCalorBRI(this.impactosParaMapa);
  }

  /**
   * Color semafórico por clasificación BRI — consistente con sesion.page.html.
   * TTC #19: el color codifica la "gravedad" del evento forense.
   */
  private colorClasificacion(clasificacion: string): string {
    switch (clasificacion) {
      case 'MODERADO': return '#ffd43b'; // amarillo — deterioro menor
      case 'SEVERO':   return '#ff6b6b'; // rojo-naranja — bache significativo
      case 'CRITICO':  return '#ff4444'; // rojo — impacto excepcional (FII)
      default:         return '#ffa94d';
    }
  }
}
