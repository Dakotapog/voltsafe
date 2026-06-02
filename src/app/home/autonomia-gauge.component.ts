import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { AutonomiaService } from '../services/autonomia.service';
import { DeviceMonitorService } from '../services/device-monitor.service';

/**
 * AutonomiaGaugeComponent — Velocímetro SVG de autonomía eléctrica.
 *
 * Reemplaza las 3 ion-cards de estado (SEGURO/PRECAUCIÓN/NO_RECOMENDADO)
 * con un arco semicircular animado que comunica la posición en el rango
 * ANTES de que el cerebro procese el número.
 *
 * TTC #13 (Planning Fallacy, Kahneman): el arco visualiza el estimado
 *   conservador — el extremo derecho del gauge representa el rango máximo
 *   teórico, pero la escala ya incorpora el buffer del 15%.
 *
 * TTC #14 (Maslow): el color del arco (verde→amarillo→rojo) replica la
 *   transición SEGURO→PRECAUCIÓN→NO_RECOMENDADO de la jerarquía de necesidades.
 *   El ojo procesa el color antes que el número — la urgencia se comunica
 *   en milisegundos, no en lectura consciente.
 *
 * Aplica a ciclas eléctricas Y patinetas eléctricas — lenguaje visual neutro.
 * Ver: [[UX-Visual-Innovations]] V4 · [[AutonomiaService]] · [[HomePage]]
 */
@Component({
  selector: 'app-autonomia-gauge',
  standalone: true,
  imports: [CommonModule, IonicModule],
  template: `
    <div class="gauge-wrapper">

      <svg viewBox="0 0 200 115" class="gauge-svg" aria-label="Indicador de autonomía">

        <!--
          Anillos de confinamiento plasma — TTC Tokamak ITER
          stroke-width 2 + stroke visibles = percibibles en AMOLED físico.
          Pulsan de opacidad real 0 → 1 con desfase de fase como los campos
          magnéticos toroidales del ITER que rotan su energía de confinamiento.
        -->
        <circle cx="100" cy="100" r="56" fill="none"
                stroke="rgba(0,255,159,0.30)" stroke-width="6"
                class="plasma-ring ring-a"/>
        <circle cx="100" cy="100" r="70" fill="none"
                stroke="rgba(0,255,159,0.20)" stroke-width="4"
                class="plasma-ring ring-b"/>
        <circle cx="100" cy="100" r="91" fill="none"
                stroke="rgba(0,255,159,0.12)" stroke-width="2.5"
                class="plasma-ring ring-c"/>

        <!-- Arco de fondo — escala total del vehículo -->
        <path d="M 18 100 A 82 82 0 0 1 182 100"
              fill="none" stroke="#1c2333" stroke-width="18"
              stroke-linecap="round"/>

        <!-- Marcas de referencia: 25%, 50%, 75% -->
        <line x1="41.5" y1="41.5" x2="50.4" y2="50.4"
              stroke="#2a3344" stroke-width="2" stroke-linecap="round"/>
        <line x1="100"  y1="18"   x2="100"  y2="28"
              stroke="#2a3344" stroke-width="2" stroke-linecap="round"/>
        <line x1="158.5" y1="41.5" x2="149.6" y2="50.4"
              stroke="#2a3344" stroke-width="2" stroke-linecap="round"/>

        <!-- Arco de valor animado -->
        @if (ratio() > 0.01) {
          <!-- Halo difuso externo -->
          <path [attr.d]="arcValor()"
                fill="none"
                [attr.stroke]="colorEstado()"
                stroke-width="30"
                stroke-linecap="round"
                opacity="0.07"
                class="gauge-arc-halo"/>
          <!-- Arco principal -->
          <path [attr.d]="arcValor()"
                fill="none"
                [attr.stroke]="colorEstado()"
                stroke-width="18"
                stroke-linecap="round"
                class="gauge-arc-valor"/>
        }

        <!-- Valor numérico centrado -->
        <text x="100" y="78"
              text-anchor="middle"
              class="gauge-km"
              [attr.fill]="colorEstado()">
          {{ km() | number:'1.0-0' }}
        </text>
        <text x="100" y="94"
              text-anchor="middle"
              class="gauge-unidad"
              fill="#3a4a5c">km restantes</text>

        <!--
          Aguja — TTC: Velocímetro analógico → instrumento físico
          Los instrumentos analógicos (altímetro, cuenta-rpm F1, amperímetro)
          usan una aguja sobre el arco para comunicar posición relativa
          ANTES de que el ojo lea el número. El círculo luminoso en el
          extremo del arco es esa aguja. Se mueve con transición CSS
          sincronizada al arco — un único dato leído en dos canales
          simultáneos: posición espacial + valor numérico.
        -->
        <!--
          AGUJA — TTC: Instrumentación analógica (voltímetro, velocímetro, manómetro).
          Todo instrumento analógico usa una línea que PIVOTA desde el centro —
          no un punto que se mueve sobre el arco. El pivote en (100,100) y la
          línea hacia el extremo del arco es el patrón universal de 150 años
          de instrumentación física. La aguja larga hace imposible confundir
          la lectura: su punta siempre señala exactamente la posición en la escala.
        -->
        <g [attr.transform]="'rotate(' + needleDeg() + ', 100, 100)'"
           class="gauge-needle-group">
          <!-- Contrapeso corto (lado opuesto) -->
          <line x1="100" y1="100" x2="72" y2="100"
                [attr.stroke]="colorEstado()" stroke-width="3"
                stroke-linecap="round" opacity="0.4"/>
          <!-- Aguja principal — larga, hacia el arco -->
          <line x1="100" y1="100" x2="178" y2="100"
                [attr.stroke]="colorEstado()" stroke-width="3"
                stroke-linecap="round"/>
          <!-- Punta luminosa en el extremo -->
          <circle cx="178" cy="100" r="4"
                  [attr.fill]="colorEstado()"/>
          <!-- Pivote central: oscuro con borde de color + núcleo blanco -->
          <circle cx="100" cy="100" r="9"
                  fill="#0d1117" [attr.stroke]="colorEstado()" stroke-width="2.5"/>
          <circle cx="100" cy="100" r="4"
                  fill="#ffffff"/>
        </g>

      </svg>

      <!-- Estado con color semafórico -->
      <div class="gauge-estado" [style.color]="colorEstado()">
        <ion-icon [name]="iconoEstado()" style="vertical-align:middle; margin-right:4px;"></ion-icon>
        {{ etiquetaEstado() }}
      </div>

      <!-- Batería como mini-barra + penalización BRI -->
      <div class="gauge-meta">
        <div class="bat-row">
          <span class="bat-label">{{ bateria() }}%</span>
          <div class="bat-track">
            <div class="bat-fill"
                 [style.width]="bateria() + '%'"
                 [class.bat-ok]="bateria() >= 40"
                 [class.bat-warn]="bateria() >= 20 && bateria() < 40"
                 [class.bat-crit]="bateria() < 20">
            </div>
          </div>
        </div>
        @if (superficie() > 1.0) {
          <span class="gauge-bri-penalizacion">
            <ion-icon name="warning-outline"></ion-icon>
            −{{ penalizacionSup() }}% sup.
          </span>
        }
      </div>

    </div>
  `,
  styles: [`
    .gauge-wrapper {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 8px 16px 4px;
    }
    .gauge-svg {
      width: 100%;
      max-width: 260px;
    }
    .gauge-arc-valor {
      transition: d 0.7s cubic-bezier(0.4, 0, 0.2, 1),
                  stroke 0.5s ease;
    }
    .gauge-arc-halo {
      transition: d 0.7s cubic-bezier(0.4, 0, 0.2, 1),
                  stroke 0.5s ease;
    }
    /* Aguja: transición en transform rotate — soporte garantizado WebView */
    .gauge-needle-group {
      transition: transform 0.7s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .gauge-km {
      font-size: 34px;
      font-weight: 800;
      font-family: 'SF Mono', 'Roboto Mono', monospace;
      transition: fill 0.5s ease;
    }
    .gauge-unidad {
      font-size: 9px;
      letter-spacing: 0.8px;
      text-transform: uppercase;
    }
    .gauge-estado {
      font-size: 0.9rem;
      font-weight: 600;
      margin-top: 2px;
      transition: color 0.5s ease;
    }
    .gauge-meta {
      display: flex;
      gap: 14px;
      margin-top: 8px;
      font-size: 0.75rem;
      color: #52637a;
      align-items: center;
    }
    /* Mini-barra de batería */
    .bat-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .bat-label {
      font-size: 0.7rem;
      font-family: monospace;
      color: #52637a;
      width: 28px;
      text-align: right;
    }
    .bat-track {
      width: 90px;
      height: 10px;
      background: rgba(0, 20, 40, 0.8);
      border-radius: 5px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.12);
    }
    .bat-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 1s ease, background 0.5s ease;
      &.bat-ok   { background: linear-gradient(90deg, #00ff9f, #00c8ff); }
      &.bat-warn { background: #ffd43b; }
      &.bat-crit { background: #ff4444; animation: bat-pulse 0.8s infinite alternate; }
    }
    @keyframes bat-pulse {
      from { opacity: 1; } to { opacity: 0.4; }
    }
    .gauge-bri-penalizacion { color: #ffd43b; }
    /* Anillos plasma — pulso correcto: 0 → visible → 0 */
    .plasma-ring {
      animation: plasma-confinement 4s ease-in-out infinite;
    }
    .ring-a { animation-delay: 0s; }
    .ring-b { animation-delay: 1.4s; }
    .ring-c { animation-delay: 2.8s; }
    @keyframes plasma-confinement {
      0%, 100% { opacity: 0;   }
      50%       { opacity: 0.9; }
    }
  `],
})
export class AutonomiaGaugeComponent {

  private readonly autonomia     = inject(AutonomiaService);
  private readonly deviceMonitor = inject(DeviceMonitorService);

  readonly km      = computed(() => this.autonomia.autonomiaRestante_km());
  readonly bateria = computed(() => this.deviceMonitor.nivelBateria());
  readonly estado  = computed(() => this.autonomia.estadoAutonomia());
  readonly superficie = computed(() => this.autonomia.factorSuperficie());

  /** Rango máximo típico de un vehículo eléctrico personal en Bogotá */
  private readonly MAX_KM = 60;

  /** Proporción del arco a rellenar (0.001 → 0.999 para evitar degenerate paths) */
  readonly ratio = computed(() =>
    Math.min(0.999, Math.max(0.001, this.km() / this.MAX_KM))
  );

  /**
   * Path SVG del arco de valor.
   * Arco semicircular: parte del extremo IZQUIERDO (18,100) y avanza
   * en sentido antihorario según la proporción de autonomía restante.
   *
   * Fórmula: ángulo = π × (1 - ratio) — de π (izquierda) a 0 (derecha)
   */
  readonly arcValor = computed(() => {
    const r     = this.ratio();
    const angle = Math.PI * (1 - r);
    const endX  = (100 + 82 * Math.cos(angle)).toFixed(1);
    const endY  = (100 - 82 * Math.sin(angle)).toFixed(1);
    const large = r > 0.5 ? 1 : 0;
    return `M 18 100 A 82 82 0 ${large} 1 ${endX} ${endY}`;
  });

  /**
   * Grados de rotación del grupo aguja alrededor del centro (100,100).
   * ratio=1 → 0° (extremo derecho), ratio=0 → 180° (extremo izquierdo).
   * transform rotate en SVG tiene soporte garantizado en Android WebView.
   */
  readonly needleDeg = computed(() => -180 * (1 - this.ratio()));

  readonly colorEstado = computed(() => ({
    SEGURO:           '#00ff9f',
    PRECAUCION:       '#ffd43b',
    NO_RECOMENDADO:   '#ff6b6b',
  }[this.estado()] ?? '#00ff9f'));

  readonly etiquetaEstado = computed(() => ({
    SEGURO:           'Puedes salir tranquilo',
    PRECAUCION:       'Considera buscar carga',
    NO_RECOMENDADO:   'Carga inmediatamente',
  }[this.estado()] ?? ''));

  readonly iconoEstado = computed(() => ({
    SEGURO:           'checkmark-circle-outline',
    PRECAUCION:       'warning-outline',
    NO_RECOMENDADO:   'alert-circle-outline',
  }[this.estado()] ?? 'battery-half-outline'));

  readonly penalizacionSup = computed(() =>
    Math.round((1 - 1 / this.superficie()) * 100)
  );
}
