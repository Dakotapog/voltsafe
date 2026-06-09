import { Component, OnInit, inject } from '@angular/core';
import { DatabaseService } from './services/database.service';
import { DeviceMonitorService } from './services/device-monitor.service';
import { SeguridadService } from './services/seguridad.service';

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

  async ngOnInit(): Promise<void> {
    await this.db.inicializar();
    await this.deviceMonitor.iniciar();
    await this.seguridad.inicializar();
  }
}
