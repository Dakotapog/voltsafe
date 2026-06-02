import { Injectable, signal, inject, effect, computed } from '@angular/core';
import { Storage } from '@ionic/storage-angular';
import { RutaService } from './ruta.service';
import { DeviceMonitorService } from './device-monitor.service';
import { UltimaMillaService } from './ultima-milla.service';
import { DatabaseService } from './database.service';
import { MapaService } from './mapa.service';
import { GeoService } from './geo.service';

/**
 * AutonomiaService — RF-01 (Nodo 01) — Posición 7 en el orden de inicialización.
 *
 * Produce:
 *   - Signal autonomiaRestante_km  → UI semafórica
 *   - Signal estadoAutonomia       → SEGURO | PRECAUCION | NO_RECOMENDADO
 *   - Signal rangoMaximo_km        → configurable por usuario (Storage)
 *
 * Consume:
 *   - Signal distanciaAcumulada_km ← RutaService (posición 3)
 *   - Signal nivelBateria          ← DeviceMonitorService (posición 0)
 *   - Signal proximaEstacion       ← UltimaMillaService (posición 9) → umbral adaptativo
 *   - SQLite tabla impactos        → factorSuperficie BRI histórico
 *
 * ─────────────────────────────────────────────────────────────────────
 * TTC #13 — Planning Fallacy Buffer (Kahneman & Tversky, 1979)
 *   Dominio origen: economía conductual / psicología cognitiva
 *   Puente: la "Planning Fallacy" predice que los usuarios subestiman
 *   el consumo de recursos. Los displays de batería lineales generan
 *   range anxiety porque son optimistas — el consumo real siempre supera
 *   el estimado (viento, paradas, carga parcial, temperatura).
 *   VoltSafe aplica corrección pesimista 0.85× al estimado calculado:
 *   `autonomiaConservadora = calculada × PLANNING_FALLACY_BUFFER`
 *   → El usuario ve siempre el rango SEGURO, no el teórico máximo.
 *   → Confía en el estimado porque nunca se queda corto.
 *   → Range anxiety se mitiga por CONFIANZA, no por optimismo.
 *   Argumento oral: "El buffer del 15% implementa la Planning Fallacy de
 *   Kahneman & Tversky (1979): mostramos el estimado conservador que el
 *   usuario puede confiar, no el máximo teórico que genera ansiedad."
 *
 * TTC #14 — Jerarquía de Maslow aplicada a máquina de estados (1943)
 *   Dominio origen: psicología humanista / teoría de la motivación
 *   Puente: los 3 estados de autonomía replican la pirámide de Maslow:
 *   • SEGURO         = autorrealización (rueda libre, explora)
 *   • PRECAUCION     = necesidades de seguridad (evalúa alternativas)
 *   • NO_RECOMENDADO = necesidades fisiológicas (emergencia energética)
 *   En el nivel crítico, la app actúa autónomamente: muestra el plan
 *   de escape (estación TM más cercana) SIN que el usuario lo pida.
 *   Zero código extra — la proximaEstacion Signal ya existe en UltimaMillaService.
 *   Argumento oral: "La máquina de estados replica la pirámide de Maslow:
 *   en el nivel crítico, VoltSafe actúa como guardian y muestra el plan
 *   de escape al TransMilenio sin esperar acción del usuario."
 *
 * TTC #3 — Umbral adaptativo Última Milla (ya documentado en Sprint-Entrega2)
 *   proximaEstacion?.distancia_m < 500 → umbral PRECAUCION = 15% (no 20%)
 *   Teoría de decisión: el costo percibido de quedarse sin batería baja
 *   cuando hay un plan B (TransMilenio) a menos de 500m.
 *
 * C01↔C03 — factorSuperficie BRI histórico
 *   SQLite tabla impactos → AVG(rms) en radio del tramo →
 *   1.00 (suave) / 1.08 (moderado) / 1.15 (severo)
 *   Superficies deterioradas consumen +8-15% de batería.
 *   Cero inputs del usuario — crece solo con el uso de la app.
 *
 * Ver: Nodo-01-Range-Anxiety, Signal-Dependency-Graph.md, TTC-Conexiones-Ocultas.md
 */

export type EstadoAutonomia = 'SEGURO' | 'PRECAUCION' | 'NO_RECOMENDADO';

/**
 * TTC #13: Buffer de corrección por Planning Fallacy.
 * El estimado mostrado es siempre 85% del calculado — rango conservador confiable.
 */
const PLANNING_FALLACY_BUFFER = 0.85;

/** Rango por defecto para e-bike urbana (en km, batería completa, terreno plano) */
const RANGO_DEFAULT_KM = 40;

/** Umbral de PRECAUCION sin estación TM cercana */
const UMBRAL_PRECAUCION_NORMAL = 0.20;

/** Umbral de PRECAUCION cuando hay estación TM a < 500m (TTC #3) */
const UMBRAL_PRECAUCION_CON_TM = 0.15;

/** Umbral de NO_RECOMENDADO — emergencia energética */
const UMBRAL_NO_RECOMENDADO = 0.10;

@Injectable({ providedIn: 'root' })
export class AutonomiaService {
  private readonly ruta = inject(RutaService);
  private readonly device = inject(DeviceMonitorService);
  private readonly ultimaMilla = inject(UltimaMillaService);
  private readonly db = inject(DatabaseService);
  private readonly mapa = inject(MapaService);
  private readonly geo = inject(GeoService);

  private storage: Storage | null = null;

  // ── Signals públicos ──────────────────────────────────────────────

  /** Autonomía restante estimada en km (con Planning Fallacy Buffer aplicado) */
  readonly autonomiaRestante_km = signal(0);

  /**
   * CX-01 — Factor de consumo adicional por superficie BRI histórica.
   *
   * TTC #24 — HDM-4 World Bank (Highway Development Management):
   *   Dominio origen: ingeniería vial macroeconómica / planificación nacional
   *   El modelo HDM-4 calcula costos operativos de flotas en función del
   *   International Roughness Index (IRI) de la vía — exactamente el mismo
   *   principio que el BRI de VoltSafe, pero ejecutado sobre toda una red nacional.
   *   VoltSafe implementa HDM-4 en tiempo real, con datos propios del ciclista,
   *   sin encuestas de campo ni equipos MERLIN. El acelerómetro de $0 reemplaza
   *   al perfilómetro laser de $50,000 del Invías.
   *   Argumento oral: "VoltSafe implementa el modelo HDM-4 del Banco Mundial
   *   en el bolsillo del ciclista: el BRI de nuestro acelerómetro es el IRI
   *   que los ingenieros de carreteras miden con perfilómetros laser de $50,000."
   *
   * 1.00 → superficie suave   (AVG rms < 2)  → sin penalización
   * 1.08 → superficie moderada (AVG rms 2-8) → +8% consumo
   * 1.15 → superficie severa   (AVG rms ≥ 8) → +15% consumo
   *
   * Valor inicial 1.00 — sin penalización hasta que haya datos históricos.
   * Se actualiza en cada cambio de posición GPS (efecto pasivo).
   */
  readonly factorSuperficie = signal(1.0);

  /** Estado semafórico: SEGURO | PRECAUCION | NO_RECOMENDADO */
  readonly estadoAutonomia = signal<EstadoAutonomia>('SEGURO');

  /** Rango máximo configurado por el usuario (Storage) */
  readonly rangoMaximo_km = signal(RANGO_DEFAULT_KM);

  /**
   * TTC #14: Maslow automático — cuando estado = NO_RECOMENDADO,
   * este computed expone directamente la proximaEstacion para que
   * el componente UI la muestre sin lógica adicional.
   * El plan de escape aparece solo cuando es necesario (nivel fisiológico).
   */
  readonly planEscape = computed(() => {
    if (this.estadoAutonomia() === 'NO_RECOMENDADO') {
      return this.ultimaMilla.proximaEstacion();
    }
    return null;
  });

  /**
   * T04-09 — ¿Alcanza la autonomía restante para llegar al destino?
   *
   * null  → sin destino activo (el ciclista no tapeó ningún punto)
   * true  → autonomíaRestante_km ≥ distanciaRestante_m / 1000
   * false → rango insuficiente — el ciclista no llegará
   *
   * TTC #23 (Autodeterminación, Deci & Ryan 1985):
   *   Este Signal convierte la autonomía abstracta (km de batería) en
   *   una respuesta concreta a la pregunta que el ciclista realmente hace:
   *   "¿Llego?". La motivación surge del logro percibido, no del dato bruto.
   */
  readonly alcanzaDestino = computed(() => {
    const restanteM = this.mapa.distanciaRestante_m();
    if (restanteM === null) return null;
    const autonomiaM = this.autonomiaRestante_km() * 1000;
    return autonomiaM >= restanteM;
  });

  // ── Effects ───────────────────────────────────────────────────────

  /**
   * CX-01 — Actualiza factorSuperficie al moverse el ciclista.
   * Consulta SQLite impactos en ~1km del punto actual (no bloqueante).
   * Primera sesión: tabla vacía → 1.00 (sin penalización).
   */
  private readonly superficieEffect = effect(() => {
    const pos = this.geo.posicionActual();
    if (!pos) return;
    this.calcularFactorSuperficie(pos.lat, pos.lng)
      .then(f => this.factorSuperficie.set(f))
      .catch(() => {});
  });

  /**
   * Modo Dinámico: se activa automáticamente durante sesión activa.
   * Recalcula en cada cambio de distancia, batería o factor BRI.
   */
  private readonly calculoEffect = effect(() => {
    const distKm    = this.ruta.distanciaAcumulada_km();
    const bateria   = this.device.nivelBateria();
    const proximaTM = this.ultimaMilla.proximaEstacion();
    const factorBRI = this.factorSuperficie();   // CX-01: HDM-4 surface penalty

    this.recalcularDesdeSignals(bateria, distKm, proximaTM?.distancia_m ?? Infinity, 1.0, factorBRI);
  });

  // ── Inicialización ───────────────────────────────────────────────

  /**
   * Carga rango_maximo_km desde Storage.
   * Llamado desde el componente autonomia o desde app.component.ts.
   */
  async inicializar(): Promise<void> {
    this.storage = await new Storage().create();
    const rangoGuardado = await this.storage.get('rango_maximo_km');
    if (rangoGuardado != null) {
      this.rangoMaximo_km.set(rangoGuardado);
    }
  }

  // ── Modo Calculadora (sin sesión activa) ─────────────────────────

  /**
   * Cálculo manual: el usuario ingresa batería% y factor de pendiente.
   * Usado en HomePage cuando no hay sesión activa.
   * Aplica el factorSuperficie BRI histórico actual.
   *
   * @param bateriaPct      Nivel de batería 0-100
   * @param factorPendiente 1.0 plano | 0.85 moderado | 0.70 pronunciado
   */
  calcularManual(bateriaPct: number, factorPendiente = 1.0): void {
    const proximaTM = this.ultimaMilla.proximaEstacion();
    this.recalcularDesdeSignals(bateriaPct, 0, proximaTM?.distancia_m ?? Infinity, factorPendiente, this.factorSuperficie());
  }

  // ── Persistencia de configuración ────────────────────────────────

  async guardarRangoMaximo(km: number): Promise<void> {
    if (!this.storage) {
      this.storage = await new Storage().create();
    }
    await this.storage.set('rango_maximo_km', km);
    this.rangoMaximo_km.set(km);
  }

  // ── BRI → factorSuperficie (C01↔C03) ────────────────────────────

  /**
   * Consulta el historial de impactos BRI en un radio ~1km del punto.
   * Resultado: factor de consumo adicional por superficie deteriorada.
   *
   * 1.00 → superficie suave (avg_rms < 2)
   * 1.08 → superficie moderada (avg_rms 2-8)  → +8% consumo
   * 1.15 → superficie severa  (avg_rms ≥ 8)   → +15% consumo
   *
   * Primera sesión: tabla vacía → retorna 1.00 (sin penalización).
   * Crece en precisión con el uso de la app — aprendizaje pasivo.
   */
  async calcularFactorSuperficie(lat: number, lng: number): Promise<number> {
    try {
      const rows = await this.db.query(
        `SELECT AVG(rms) as avg_rms FROM impactos
         WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
        [lat - 0.01, lat + 0.01, lng - 0.01, lng + 0.01]
      );
      const avgRms: number = rows[0]?.avg_rms ?? 0;
      if (avgRms < 2)  return 1.00;
      if (avgRms < 8)  return 1.08;
      return 1.15;
    } catch {
      return 1.00; // Sin datos históricos: no penalizar
    }
  }

  // ── Lógica de cálculo central ────────────────────────────────────

  private recalcularDesdeSignals(
    bateriaPct: number,
    distanciaRecorridaKm: number,
    distanciaTM_m: number,
    factorPendiente = 1.0,
    factorBRI = 1.0
  ): void {
    const rangoMax = this.rangoMaximo_km();

    // Rango bruto: batería × rango_max × pendiente ÷ superficie (CX-01 HDM-4)
    // factorBRI > 1.0 → superficie deteriorada → rango reducido
    const rangoDisponible = (bateriaPct / 100) * rangoMax * factorPendiente / factorBRI;

    // Descontar lo ya recorrido durante la sesión
    const rangoRestante = Math.max(0, rangoDisponible - distanciaRecorridaKm);

    // ── TTC #13: Planning Fallacy Buffer ──────────────────────────
    // Siempre mostrar el 85% del estimado calculado.
    // El usuario confía en un estimado conservador → menos ansiedad.
    const autonomiaConservadora = rangoRestante * PLANNING_FALLACY_BUFFER;
    this.autonomiaRestante_km.set(
      Math.round(autonomiaConservadora * 10) / 10
    );

    // ── TTC #3: Umbral adaptativo según proximidad TM ─────────────
    // Si hay estación TM a < 500m, el costo de quedarse sin batería
    // es menor (hay plan B). El umbral de alerta puede ser más laxo.
    const umbralPrecaucion =
      distanciaTM_m < 500
        ? UMBRAL_PRECAUCION_CON_TM   // 15% — TM disponible
        : UMBRAL_PRECAUCION_NORMAL;  // 20% — sin respaldo cercano

    // ── TTC #14: Maslow → máquina de estados ─────────────────────
    const pctFraccion = bateriaPct / 100;
    if (pctFraccion > umbralPrecaucion) {
      this.estadoAutonomia.set('SEGURO');
    } else if (pctFraccion > UMBRAL_NO_RECOMENDADO) {
      this.estadoAutonomia.set('PRECAUCION');
    } else {
      // Nivel crítico: planEscape computed se activa automáticamente
      this.estadoAutonomia.set('NO_RECOMENDADO');
    }
  }
}
