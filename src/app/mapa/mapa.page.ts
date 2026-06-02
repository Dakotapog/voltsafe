import {
  Component,
  OnDestroy,
  inject,
  AfterViewInit,
} from '@angular/core';
import { AlertController } from '@ionic/angular';
import { MapaService } from '../services/mapa.service';
import { ZonasService } from '../services/zonas.service';
import { UltimaMillaService } from '../services/ultima-milla.service';
import { GeneroService } from '../services/genero.service';
import { SuperficieService } from '../services/superficie.service';
import { GeoService } from '../services/geo.service';
import { AutonomiaService } from '../services/autonomia.service';
import { ViewerService } from '../services/viewer.service';
import { LiveTrackingService } from '../services/live-tracking.service';

/**
 * MapaPage — Mapa Leaflet (Tab 3)
 *
 * Funcionalidad:
 *   - Mapa Leaflet con red de ciclorrutas de Bogotá — RF-04
 *   - Marcador GPS en tiempo real + anillo de incertidumbre (TTC #8)
 *   - Capas toggle: zonas peligro (RF-05), estaciones TM (RF-07), género (RF-08)
 *   - API agregarCapa consumida por Services (TTC #9: Mediator)
 *
 * TTC #12 (Epidemiología visual):
 *   La superposición de capa roja + morada ES una KDE visual.
 *   El ojo humano identifica clusters de inseguridad sin algoritmo.
 *   Esto es el dato que la Secretaría de la Mujer de Bogotá necesita.
 *
 * El mapa es "la pantalla más impresionante para el tutor" (Sprint-Entrega2.md).
 *
 * T09-03 — TTC #22 (Gestalt de Proximidad, Wertheimer 1923):
 *   El panel flotante de estaciones TM en la zona inferior del mapa implementa
 *   la ley de proximidad de Gestalt: ítems que co-existen espacialmente con sus
 *   referentes visuales (marcadores azules) se perciben como relacionados sin
 *   esfuerzo cognitivo. Es por eso que Google Maps, Uber y Airbnb usan bottom-sheet.
 *
 * T06-07 — Reporte manual de zona de peligro (RF-05 usuario activo).
 */
@Component({
  selector: 'app-mapa',
  templateUrl: 'mapa.page.html',
  styleUrls: ['mapa.page.scss'],
  standalone: false,
})
export class MapaPage implements AfterViewInit, OnDestroy {
  readonly mapaService    = inject(MapaService);
  readonly ultimaMilla    = inject(UltimaMillaService);
  readonly autonomia      = inject(AutonomiaService);
  readonly viewer         = inject(ViewerService);
  readonly liveTracking   = inject(LiveTrackingService); // público — tarjeta live en template
  private readonly zonas  = inject(ZonasService);
  private readonly genero = inject(GeneroService);
  private readonly superficie   = inject(SuperficieService);
  private readonly geo          = inject(GeoService);
  private readonly alertCtrl    = inject(AlertController);

  mostrarZonas      = true;
  mostrarEstaciones = true;
  mostrarGenero     = true;
  mostrarBRI        = true;

  private capasInicializadas = false;

  async ngAfterViewInit(): Promise<void> {
    // Solo crear el objeto L.map — NO cargar capas todavía (contenedor sin dimensiones aún)
    this.mapaService.inicializarMapa('mapa');
    this.mapaService.activarSeleccionDestino();
  }

  async ionViewDidEnter(): Promise<void> {
    // El tab ya terminó su animación — el contenedor tiene dimensiones reales
    this.mapaService.invalidarTamano();

    const sessionId = this.viewer.liveSessionId(); // contiene sesionId del ?sesion= param
    const vp = this.viewer.params();

    if (sessionId) {
      // Viewer live: suscribir a Firebase, actualizar marcador en tiempo real
      this.liveTracking.suscribirSesion(sessionId, (pos) => {
        this.mapaService.moverMarcadorViewer(pos.lat, pos.lng);
      });
    } else if (vp) {
      // Viewer snapshot: mostrar posición fija de la URL
      this.mapaService.colocarMarcadorViewer(vp.lat, vp.lng);
    } else {
      // Modo normal: Iniciar GPS para mostrar posición en el mapa.
      // geo.iniciar() tiene guard if(activo) return — no duplica si ya corre sesión.
      this.geo.iniciar();
    }

    if (!this.capasInicializadas) {
      this.capasInicializadas = true;
      await this.mapaService.cargarCiclorrutas();
      await Promise.all([
        this.cargarCapaZonas(),
        this.cargarCapaEstaciones(),
        this.cargarCapaGenero(),
        this.cargarCapaBRI(),
      ]);
    }
  }

  ngOnDestroy(): void {
    this.liveTracking.desuscribir();
    this.mapaService.destruirMapa();
    this.capasInicializadas = false;
  }

  centrar(): void {
    // Viewer live: centrar en última posición recibida de Firebase
    const posViva = this.liveTracking.posicionViva();
    if (posViva) {
      this.mapaService.centrarEnPosicion(posViva.lat, posViva.lng);
      return;
    }
    // Viewer snapshot: centrar en posición de URL params
    const vp = this.viewer.params();
    if (vp) {
      this.mapaService.centrarEnPosicion(vp.lat, vp.lng);
      return;
    }
    // Modo normal: GPS propio del usuario
    this.mapaService.centrarEnUsuario();
  }

  async toggleZonas(): Promise<void> {
    this.mostrarZonas = !this.mostrarZonas;
    if (this.mostrarZonas) {
      await this.cargarCapaZonas();
    } else {
      this.mapaService.removerCapa('zonas_peligro');
    }
  }

  async toggleEstaciones(): Promise<void> {
    this.mostrarEstaciones = !this.mostrarEstaciones;
    if (this.mostrarEstaciones) {
      await this.cargarCapaEstaciones();
    } else {
      this.mapaService.removerCapa('estaciones_tm');
    }
  }

  async toggleGenero(): Promise<void> {
    this.mostrarGenero = !this.mostrarGenero;
    if (this.mostrarGenero) {
      await this.cargarCapaGenero();
    } else {
      this.mapaService.removerCapa('reportes_genero');
    }
  }

  // ---- Carga de capas ----

  private async cargarCapaZonas(): Promise<void> {
    await this.zonas.cargarZonas();
    const zonasData = this.zonas.obtenerZonas();
    this.mapaService.agregarCapa(
      'zonas_peligro',
      zonasData.map((z) => ({
        lat: z.lat,
        lng: z.lng,
        tipo: z.tipo,
        descripcion: z.descripcion,
      }))
    );
  }

  private async cargarCapaEstaciones(): Promise<void> {
    await this.ultimaMilla.cargar();
    const estaciones = this.ultimaMilla.estacionesCercanas();
    if (estaciones.length === 0) {
      const response = await fetch('/assets/estaciones_tm.json');
      const data = await response.json();
      const todas = data.estaciones ?? [];
      this.mapaService.agregarCapa(
        'estaciones_tm',
        todas.map((e: { lat: number; lng: number; nombre: string; tipo: string }) => ({
          lat: e.lat,
          lng: e.lng,
          tipo: e.tipo,
          descripcion: e.nombre,
        }))
      );
    } else {
      this.mapaService.agregarCapa(
        'estaciones_tm',
        estaciones.map((e) => ({
          lat: e.lat,
          lng: e.lng,
          tipo: e.tipo,
          descripcion: e.nombre,
        }))
      );
    }
  }

  /**
   * Capa morada — reportes de género.
   * TTC #12: junto con la capa roja, forma una "KDE visual" de inseguridad.
   */
  private async cargarCapaGenero(): Promise<void> {
    await this.genero.cargar();
    // GeneroService ya llama agregarCapa internamente al cargar
  }

  /**
   * Capa BRI — impactos de superficie por clasificación semafórica.
   * TTC #19: evidencia forense objetiva — la capa de mayor jerarquía probatoria.
   * Amarillo = MODERADO · Rojo-naranja = SEVERO · Rojo = CRITICO
   */
  private async cargarCapaBRI(): Promise<void> {
    await this.superficie.cargar();
    // SuperficieService ya llama agregarCapa internamente (patrón GeneroService)
  }

  async toggleBRI(): Promise<void> {
    this.mostrarBRI = !this.mostrarBRI;
    if (this.mostrarBRI) {
      await this.cargarCapaBRI();
    } else {
      this.mapaService.removerCapa('bri_calor');
    }
  }

  // ============================================================
  // VIEWER MODE — helper de template
  // ============================================================

  briColor(bri: string): string {
    switch (bri) {
      case 'SUAVE':    return '#00ff9f';
      case 'MODERADO': return '#ffd43b';
      case 'SEVERO':   return '#ff6b6b';
      case 'CRITICO':  return '#c92a2a';
      default:         return '#868e96';
    }
  }

  // ============================================================
  // T06-07 — REPORTE MANUAL DE ZONA DE PELIGRO (RF-05)
  // ============================================================

  /**
   * Abre AlertController para que el usuario reporte una zona de peligro.
   * La zona se crea en la posición GPS actual y se visualiza de inmediato.
   *
   * Requiere sesión GPS activa (posicionActual != null).
   * Sin GPS: el alert informa al usuario sin lanzar el formulario.
   */
  async reportarZona(): Promise<void> {
    const pos = this.geo.posicionActual();

    if (!pos) {
      const sin = await this.alertCtrl.create({
        header: 'Sin GPS',
        message: 'Activa el GPS para reportar una zona en tu ubicación actual.',
        buttons: ['OK'],
      });
      await sin.present();
      return;
    }

    const alert = await this.alertCtrl.create({
      header: 'Reportar zona de peligro',
      subHeader: 'Selecciona el tipo de riesgo en tu ubicación',
      inputs: [
        {
          type: 'radio',
          label: 'Hurto / Robo',
          value: 'hurto',
          checked: true,
        },
        {
          type: 'radio',
          label: 'Sin iluminación',
          value: 'iluminacion',
        },
        {
          type: 'radio',
          label: 'Vía deteriorada',
          value: 'via_deteriorada',
        },
        {
          type: 'radio',
          label: 'Accidente frecuente',
          value: 'accidente',
        },
      ],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Reportar',
          handler: async (tipo: string) => {
            const etiqueta: Record<string, string> = {
              hurto: 'Hurto',
              iluminacion: 'Sin iluminación',
              via_deteriorada: 'Vía deteriorada',
              accidente: 'Accidente frecuente',
            };
            await this.zonas.reportarZona(
              tipo,
              `${etiqueta[tipo] ?? tipo} — reportado por usuario`,
              pos.lat,
              pos.lng
            );
            // Refrescar capa de zonas en el mapa
            await this.cargarCapaZonas();
          },
        },
      ],
    });
    await alert.present();
  }
}
