import { Component, OnInit, inject } from '@angular/core';
import { Router } from '@angular/router';
import { DatabaseService } from './services/database.service';
import { DeviceMonitorService } from './services/device-monitor.service';
import { SeguridadService } from './services/seguridad.service';
import { ViewerService } from './services/viewer.service';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: false,
})
export class AppComponent implements OnInit {
  readonly db     = inject(DatabaseService);
  private readonly deviceMonitor = inject(DeviceMonitorService);
  private readonly seguridad     = inject(SeguridadService);
  private readonly viewer        = inject(ViewerService);
  private readonly router        = inject(Router);

  async ngOnInit(): Promise<void> {
    // Viewer mode: alguien abrió un link compartido con ?lat=X&lng=Y
    // En ese caso, ir directo al MAPA sin inicializar plugins nativos.
    const esViewer = this.viewer.parsearDesdeURL();
    if (esViewer) {
      this.db.listo.set(true); // desbloquear spinner
      await this.router.navigate(['/tabs/mapa']);
      return;
    }

    await this.db.inicializar();
    await this.deviceMonitor.iniciar();
    await this.seguridad.inicializar();
  }
}
