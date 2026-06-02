import { Component, inject, signal } from '@angular/core';
import { SeguridadService } from '../services/seguridad.service';
import { ExportService, ResultadoExport } from '../services/export.service';
import { ZonasService } from '../services/zonas.service';
import { AutonomiaService } from '../services/autonomia.service';
import { AlertController, ToastController, ModalController } from '@ionic/angular';
import { EnmeComponent } from './enme.component';

/**
 * PerfilPage — Ajustes y Configuración (Tab 4)
 *
 * Funcionalidad:
 *   - Contacto de emergencia (RF-06)
 *   - Compartir ubicación WhatsApp/SMS (RF-06) — con visual SOS reactivo (T07-04)
 *   - Exportar datos GeoJSON (RF-10) — TTC #15 Biopsia Urbana + TTC #16 Estratificación
 *   - Información ENME (Nodo 19)
 *
 * TTC #20 — Semiótica de Peirce (Lingüística → UX Design):
 *   El botón SOS en estado normal es un Símbolo (Peirce 1903) — su color
 *   verde/gris es convencional, arbitrario, sin conexión causal con el peligro.
 *   Cuando alertaActiva().activa = true, el botón debe transformarse en un
 *   ÍNDICE: un signo causalmente conectado a su referente (el peligro real
 *   detectado por el geofence). La animación roja pulsante no es decorativa —
 *   es la transformación semiótica de Símbolo a Índice.
 *   Argumento oral: "La diferencia entre un botón verde y uno rojo pulsante
 *   no es estética — es la diferencia entre un Símbolo y un Índice de Peirce.
 *   El rojo pulsante ES el peligro, no solo lo anuncia."
 */
@Component({
  selector: 'app-perfil',
  templateUrl: 'perfil.page.html',
  styleUrls: ['perfil.page.scss'],
  standalone: false,
})
export class PerfilPage {
  readonly seguridad  = inject(SeguridadService);
  readonly exportSvc  = inject(ExportService);
  readonly zonas      = inject(ZonasService);
  readonly autonomia  = inject(AutonomiaService);
  private readonly alertCtrl  = inject(AlertController);
  private readonly toastCtrl  = inject(ToastController);
  private readonly modalCtrl  = inject(ModalController);

  /** Toggle consentimiento para incluir reportes de género en el export */
  readonly incluirGenero = signal(false);

  /** Resumen del último export para mostrar en UI */
  readonly ultimoResultado = signal<ResultadoExport | null>(null);

  async ngOnInit(): Promise<void> {
    await this.seguridad.inicializar();
  }

  async editarContacto(): Promise<void> {
    const contacto = this.seguridad.contacto();
    const alert = await this.alertCtrl.create({
      header: 'Contacto de Emergencia',
      inputs: [
        {
          name: 'nombre',
          type: 'text',
          placeholder: 'Nombre',
          value: contacto?.nombre ?? '',
        },
        {
          name: 'telefono',
          type: 'tel',
          placeholder: 'Teléfono (ej: +573001234567)',
          value: contacto?.telefono ?? '',
        },
      ],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Guardar',
          handler: async (data) => {
            if (data.nombre && data.telefono) {
              await this.seguridad.guardarContacto({
                nombre: data.nombre,
                telefono: data.telefono,
              });
              const toast = await this.toastCtrl.create({
                message: 'Contacto guardado',
                duration: 1500,
                position: 'bottom',
                color: 'success',
              });
              await toast.present();
            }
          },
        },
      ],
    });
    await alert.present();
  }

  async compartirWhatsApp(): Promise<void> {
    await this.seguridad.compartirUbicacion();
  }

  async compartirSMS(): Promise<void> {
    await this.seguridad.compartirPorSMS();
  }

  // ── RF-10: Exportación DaaS ─────────────────────────────────────

  async exportarDatos(): Promise<void> {
    try {
      const resultado = await this.exportSvc.generarReporte(this.incluirGenero());
      this.ultimoResultado.set(resultado);

      const toast = await this.toastCtrl.create({
        message: `Reporte guardado — ${resultado.totalFeatures} registros en ${resultado.path}`,
        duration: 3000,
        position: 'bottom',
        color: 'success',
        buttons: [
          {
            text: 'Compartir',
            handler: () => this.exportSvc.compartir(),
          },
        ],
      });
      await toast.present();
    } catch (err) {
      const toast = await this.toastCtrl.create({
        message: 'Error al exportar. Verifica los permisos de almacenamiento.',
        duration: 3000,
        position: 'bottom',
        color: 'danger',
      });
      await toast.present();
    }
  }

  async compartirUltimoReporte(): Promise<void> {
    await this.exportSvc.compartir();
  }

  // ── T19: Pantalla ENME ───────────────────────────────────────────

  /**
   * Abre la pantalla ENME como ion-modal de pantalla completa.
   * TTC #23: regulación normativa → motivación integrada (Deci & Ryan, 1985).
   */
  async abrirEnme(): Promise<void> {
    const modal = await this.modalCtrl.create({
      component: EnmeComponent,
    });
    await modal.present();
  }

  // ── T01-06: Configuración de rango máximo ────────────────────────

  async guardarRango(event: Event): Promise<void> {
    const km = +(event as CustomEvent).detail.value;
    await this.autonomia.guardarRangoMaximo(km);
    const toast = await this.toastCtrl.create({
      message: `Rango máximo guardado: ${km} km`,
      duration: 1500,
      position: 'bottom',
      color: 'success',
    });
    await toast.present();
  }
}
