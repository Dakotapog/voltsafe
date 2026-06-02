import { Component, inject, effect, signal } from '@angular/core';
import { ActionSheetController, ToastController } from '@ionic/angular';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { NivelConfianza } from '../models/confidence-ring';
import { RutaService } from '../services/ruta.service';
import { ExternalidadesService } from '../services/externalidades.service';
import { DeviceMonitorService } from '../services/device-monitor.service';
import { GeoService } from '../services/geo.service';
import { ZonasService } from '../services/zonas.service';
import { SensorService } from '../services/sensor.service';
import { SuperficieService } from '../services/superficie.service';
import { UltimaMillaService } from '../services/ultima-milla.service';
import { AutonomiaService } from '../services/autonomia.service';
import {
  GeneroService,
  TipoReporteGenero,
} from '../services/genero.service';
import { SeguridadService } from '../services/seguridad.service';
import { HapticsService } from '../services/haptics.service';
import { LiveTrackingService } from '../services/live-tracking.service';

/**
 * SesionPage — Registro de Ruta (Tab 2)
 *
 * Funcionalidad:
 *   - Botón START/STOP sesión — RF-02
 *   - Distancia + duración en tiempo real
 *   - Externalidades en vivo (CO2, dinero, calorías) — RF-09
 *   - Banner alerta zona peligro — RF-05
 *   - FAB morado "Denuncia Rápida" — RF-08 (GeneroService)
 *
 * TTC #10 (Bystander Effect inversion):
 *   Cuando alertaActiva = true, el FAB morado pulsa. La app es el
 *   "espectador digital" que rompe el ciclo de pasividad de Darley & Latané.
 *   La animación no obliga, invita — en el momento exacto de mayor relevancia.
 *
 * TTC #21 — Escala Peatonal de Jan Gehl (Urbanismo → UX trigger):
 *   Jan Gehl, "Cities for People" (2010): 500m es el radio canónico de
 *   captación peatonal de estaciones de transporte masivo, validado en
 *   40 años de Transit-Oriented Development (TOD). Por debajo de 500m,
 *   la estación está en "zona de convergencia" — la transferencia modal
 *   es viable y cómoda. El toast se activa exactamente en ese umbral,
 *   no por conveniencia de implementación sino porque Gehl lo demostró.
 *   Argumento oral: "Los 500m no son arbitrarios — son el umbral de Jan
 *   Gehl, el mismo que usan Bogotá, TransMilenio y el ITDP para diseñar
 *   zonas de captación de estaciones."
 */
@Component({
  selector: 'app-sesion',
  templateUrl: 'sesion.page.html',
  styleUrls: ['sesion.page.scss'],
  standalone: false,
})
export class SesionPage {
  /** Expuesto al template para comparaciones con el enum */
  readonly NivelConfianza = NivelConfianza;

  readonly ruta           = inject(RutaService);
  readonly externalidades = inject(ExternalidadesService);
  readonly deviceMonitor  = inject(DeviceMonitorService);
  readonly geo            = inject(GeoService);
  readonly zonas          = inject(ZonasService);
  readonly genero         = inject(GeneroService);
  readonly sensor         = inject(SensorService);
  readonly superficie     = inject(SuperficieService);
  readonly ultimaMilla    = inject(UltimaMillaService);
  private readonly autonomia       = inject(AutonomiaService);
  private readonly seguridad       = inject(SeguridadService);
  private readonly haptics         = inject(HapticsService);
  private readonly liveTracking    = inject(LiveTrackingService);
  private readonly actionSheetCtrl = inject(ActionSheetController);
  private readonly toastCtrl       = inject(ToastController);

  /** Expone al template para el indicador "EN VIVO" */
  readonly liveSessionId = this.liveTracking.sessionId;

  /**
   * Resumen de la última sesión finalizada.
   * TTC #23 (Autodeterminación, Deci & Ryan): mostrar el impacto personal
   * inmediatamente al terminar la ruta cierra el loop motivacional:
   * esfuerzo → logro percibido → motivación intrínseca para la próxima sesión.
   * null = sin sesión previa finalizada en esta vista.
   */
  readonly resumenSesion = signal<{
    km: number;
    duracion_s: number;
    co2_g: number;
    ahorro_cop: number;
    cal: number;
    impactos_bri: number;
  } | null>(null);

  /**
   * Flag para evitar toasts repetidos al permanecer dentro del radio.
   * Reset automático cuando el ciclista se aleja > 500m de la estación.
   */
  private toastTM500mMostrado = false;

  /**
   * Effect reactivo — TTC #21 (Escala Gehl): toast cuando la estación TM
   * más cercana entra en radio de 500m durante una sesión activa.
   * Se activa una sola vez por "evento de entrada" al radio.
   */
  private readonly _toastTMEffect = effect(() => {
    const proxima = this.ultimaMilla.proximaEstacion();
    const activa  = this.ruta.sesionActiva();

    if (!activa) {
      this.toastTM500mMostrado = false;
      return;
    }

    if (proxima && proxima.distancia_m < 500) {
      if (!this.toastTM500mMostrado) {
        this.toastTM500mMostrado = true;
        this.haptics.estacionCercana().catch(() => {});
        this.mostrarToastTM(proxima.estacion.nombre, proxima.distancia_m);
      }
    } else {
      // Al salir del radio: resetear para detectar la próxima entrada
      this.toastTM500mMostrado = false;
    }
  });

  /** Muestra el toast de última milla sin bloquear el effect. */
  private mostrarToastTM(nombre: string, distanciaM: number): void {
    this.toastCtrl
      .create({
        message: `Estación cercana: ${nombre} — ${Math.round(distanciaM)} m`,
        duration: 4000,
        position: 'bottom',
        color: 'primary',
        icon: 'bus-outline',
      })
      .then((t) => t.present());
  }

  async toggleSesion(): Promise<void> {
    if (this.ruta.sesionActiva()) {
      // Capturar métricas ANTES de detener (los Signals se resetean al parar)
      const km         = this.ruta.distanciaAcumulada_km();
      const duracion   = this.ruta.duracion_s();
      const ext        = this.externalidades.externalidadesSesion();

      // Feedback háptico — "completado" (antes de detener para que se sienta al tocar)
      this.haptics.sesionDetenida().catch(() => {});

      // Cancelar Dead Man's Switch al detener sesión
      await this.seguridad.cancelarCheckIn();

      // Detener acelerómetro antes de cerrar sesión
      await this.sensor.detener();
      this.superficie.reset();
      await this.ruta.detenerSesion();
      await this.externalidades.actualizarAcumulado();

      // T17-06: resumen de sesión con impacto personal (TTC #23 SDT)
      // Solo mostrar si hay distancia registrada — silencioso en taps accidentales
      if (km > 0.01) {
        this.resumenSesion.set({
          km,
          duracion_s: duracion,
          co2_g:      ext.co2_g,
          ahorro_cop: ext.dinero_cop,
          cal:        ext.calorias,
          impactos_bri: 0, // actualizado al cargar capa BRI; aproximación aquí
        });
      }
    } else {
      // Feedback háptico — doble pulso "arrancamos"
      this.haptics.sesionIniciada().catch(() => {});

      // Limpiar resumen previo al iniciar nueva sesión
      this.resumenSesion.set(null);
      await this.zonas.cargarZonas();
      // T17-06: pasar autonomía predicha al SQLite para range anxiety gap
      await this.ruta.iniciarSesion(
        this.deviceMonitor.nivelBateria(),
        this.autonomia.autonomiaRestante_km()
      );
      // Iniciar acelerómetro BRI en paralelo con última milla
      await Promise.all([
        this.sensor.iniciar(),
        this.ultimaMilla.cargar(),  // T09-04: habilita el effect de 500m (TTC #21)
      ]);
      this.superficie.setSesionId(this.ruta.sesionId());

      // Dead Man's Switch: check-in en 30 min — silencioso si no hay contacto
      this.seguridad.programarCheckIn(30).catch(() => {});
    }
  }

  // ============================================================
  // FAB MORADO — DENUNCIA RÁPIDA (RF-08)
  // ============================================================

  /**
   * Abre el action-sheet de denuncia rápida.
   * ≤ 2 taps, ≤ 3 segundos — el ciclista NO puede detenerse.
   *
   * TTC #10: si alertaActiva = true en este momento, el FAB ya estaba
   * pulsando. El usuario respondió a la "intervención de espectador digital".
   * El reporte completa el ciclo de acción que rompió la pasividad.
   */
  async abrirDenunciaRapida(): Promise<void> {
    const actionSheet = await this.actionSheetCtrl.create({
      header: 'Reporte de seguridad',
      buttons: [
        {
          text: 'Acoso / Intimidación',
          icon: 'alert-circle-outline',
          handler: () => this.registrar('acoso'),
        },
        {
          text: 'Zona oscura / Sin iluminación',
          icon: 'moon-outline',
          handler: () => this.registrar('oscuridad'),
        },
        {
          text: 'Aislamiento / Sin personas',
          icon: 'eye-off-outline',
          handler: () => this.registrar('aislamiento'),
        },
        {
          text: 'Cancelar',
          role: 'cancel',
          icon: 'close-outline',
        },
      ],
    });
    await actionSheet.present();
  }

  private async registrar(tipo: TipoReporteGenero): Promise<void> {
    await this.genero.registrarReporte(tipo);
    const toast = await this.toastCtrl.create({
      message: `${this.genero.etiquetaTipo(tipo)} registrado`,
      duration: 1500,
      position: 'bottom',
      color: 'tertiary',
      icon: 'shield-checkmark-outline',
    });
    await toast.present();
  }

  // ============================================================
  // T02-07 — CÁMARA DURANTE SESIÓN (RF-02)
  // ============================================================

  /**
   * Toma una foto y la georreferencia con la posición GPS actual.
   * Silencioso si el usuario cancela o deniega permiso.
   *
   * TTC #25 (Cadena de Custodia Forense): la foto queda vinculada a
   * lat/lng/timestamp/sesion_id en puntos_ruta. Evidencia ciudadana
   * con el mismo valor probatorio que un informe de infraestructura.
   */
  async tomarFoto(): Promise<void> {
    const pos = this.geo.posicionActual();
    if (!pos) return; // GPS no disponible — no fotografiar sin coordenadas

    try {
      const foto = await Camera.getPhoto({
        quality: 80,
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera,
      });

      if (foto.webPath) {
        await this.ruta.registrarFoto(foto.webPath, pos.lat, pos.lng);
        this.toastCtrl
          .create({
            message: 'Foto registrada en la ruta',
            duration: 1500,
            position: 'bottom',
            color: 'warning',
            icon: 'camera-outline',
          })
          .then((t) => t.present());
      }
    } catch {
      // Usuario canceló o denegó permiso — sin acción
    }
  }

  // ============================================================
  // DEAD MAN'S SWITCH — RF-06 (TTC Ingeniería Marítima)
  // ============================================================

  /**
   * Comparte ubicación GPS actual vía WhatsApp — un tap desde el cockpit.
   * No requiere salir de la sesión. Usa SeguridadService que ya tiene
   * el contacto cargado desde AppComponent.ngOnInit().
   */
  async compartirUbicacion(): Promise<void> {
    if (!this.seguridad.contacto()) {
      const toast = await this.toastCtrl.create({
        message: 'Configura un contacto de emergencia en Perfil primero',
        duration: 3000,
        position: 'bottom',
        color: 'warning',
        icon: 'person-outline',
      });
      await toast.present();
      return;
    }
    const pos = this.geo.posicionActual();
    await this.seguridad.compartirUbicacion({
      bateria_pct:   this.deviceMonitor.nivelBateria(),
      distancia_km:  this.ruta.distanciaAcumulada_km(),
      velocidad_kmh: this.geo.velocidadMS() * 3.6,
      co2_g:         this.externalidades.externalidadesSesion().co2_g,
      bri:           this.superficie.briActual(),
      accuracy_m:    pos?.accuracy ?? 10,
      confianza:     this.geo.nivelConfianza(),
      es_sos:        this.zonas.alertaActiva().activa,
    });
  }

  /** Abre selector nativo — comparte ubicación con cualquier app o contacto */
  async compartirConCualquiera(): Promise<void> {
    await this.seguridad.compartirConCualquiera();
  }

  /**
   * Inicia tracking en vivo vía Firebase y comparte el link de seguimiento.
   * Si ya hay una sesión activa, muestra el link para copiarlo de nuevo.
   */
  async compartirEnVivo(): Promise<void> {
    let sessionId = this.liveTracking.sessionId();

    if (!sessionId) {
      sessionId = this.liveTracking.generarSessionId();
      await this.liveTracking.iniciarPublicacion(sessionId);
    }

    const url = this.liveTracking.generarURLViewer(sessionId);
    const texto = `📡 Sígueme en tiempo real:\n${url}`;

    const { Share } = await import('@capacitor/share');
    await Share.share({
      title: 'VoltSafe — Seguimiento en vivo',
      text: texto,
      url,
      dialogTitle: 'Compartir link de seguimiento',
    }).catch(() => {
      // Fallback: abrir WhatsApp con el link
      window.open(
        `https://wa.me/?text=${encodeURIComponent(texto)}`,
        '_system'
      );
    });
  }

  /** Detiene el tracking en vivo si está activo */
  detenerEnVivo(): void {
    this.liveTracking.detenerPublicacion();
  }

  async confirmarLlegada(): Promise<void> {
    await this.seguridad.confirmarLlegada();
    const toast = await this.toastCtrl.create({
      message: '✅ Llegada confirmada — alerta de seguridad cancelada',
      duration: 3000,
      position: 'bottom',
      color: 'success',
      icon: 'shield-checkmark-outline',
    });
    await toast.present();
  }

  /** Formatea segundos a MM:SS */
  formatearDuracion(segundos: number): string {
    const min = Math.floor(segundos / 60);
    const sec = segundos % 60;
    return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  /**
   * Pace en min:ss / km — tercer instrumento del cluster F1.
   * TTC #31 (Strava → F1 sector times): el "pace" de ciclismo/running
   * es el equivalente directo del sector time en F1 — cuánto cuesta
   * cada unidad de distancia. En Fórmula E, el dato equivalente es
   * la energía consumida por km (Wh/km). VoltSafe lo expresa en tiempo.
   */
  getPace(): string {
    const km = this.ruta.distanciaAcumulada_km();
    const s  = this.ruta.duracion_s();
    if (km < 0.1 || s < 10) return '--:--';
    const secPerKm = s / km;
    const min = Math.floor(secPerKm / 60);
    const sec = Math.floor(secPerKm % 60);
    return `${min}:${sec.toString().padStart(2, '0')}`;
  }
}
