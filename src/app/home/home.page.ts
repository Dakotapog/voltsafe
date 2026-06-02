import { Component, inject, OnInit } from '@angular/core';
import { ExternalidadesService } from '../services/externalidades.service';
import { DeviceMonitorService } from '../services/device-monitor.service';
import { AutonomiaService } from '../services/autonomia.service';

/**
 * HomePage — Dashboard principal (Tab 1)
 *
 * Muestra:
 *   - Dashboard de autonomía RF-01: batería → rango estimado, estado semafórico
 *   - Plan de escape automático (TM cercana) cuando batería crítica — TTC #14 Maslow
 *   - Externalidades acumuladas (CO2, dinero, calorías) — RF-09
 *
 * TTC: primera impresión para el tutor.
 *   - Planning Fallacy Buffer visible en el rango conservador — TTC #13
 *   - Jerarquía de Maslow en la máquina de estados — TTC #14
 *   - 3 ion-cards externalidades demuestran RF-09 sin sesión activa
 */
@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false,
})
export class HomePage implements OnInit {
  readonly externalidades = inject(ExternalidadesService);
  readonly deviceMonitor  = inject(DeviceMonitorService);
  readonly autonomia      = inject(AutonomiaService);

  async ngOnInit(): Promise<void> {
    await this.autonomia.inicializar();
  }
}
