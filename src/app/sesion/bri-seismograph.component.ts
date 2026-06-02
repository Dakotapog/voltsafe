import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewInit,
  OnDestroy,
  inject,
  effect,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SuperficieService } from '../services/superficie.service';
import { RutaService } from '../services/ruta.service';

/**
 * BriSeismographComponent — Sismógrafo de pavimento en tiempo real.
 *
 * Visualiza la señal del acelerómetro filtrada (magnitud lineal post-HPF)
 * como una onda continua que se desplaza de derecha a izquierda,
 * exactamente como los sismógrafos de las redes USGS/IRIS/GEOFON.
 *
 * TTC #17 (Red Sismográfica Distribuida):
 *   El mismo principio visual que usan las estaciones sismográficas para
 *   mostrar terremotos — aplicado a "micro-terremotos de pavimento".
 *   Un pico en la onda = un bache. La amplitud del pico = la severidad BRI.
 *   Esta es la firma sismográfica del pavimento de Bogotá, construida en
 *   tiempo real por el acelerómetro del teléfono.
 *
 * TTC #18 (Resonancia Mecánica Kelvin-Voigt):
 *   La señal visualizada ya pasó por el filtro paso alto α=0.8 de
 *   SuperficieService — es la aceleración lineal pura del sistema ciclista,
 *   sin el componente gravitacional. La onda muestra exactamente lo que
 *   el cuerpo del usuario absorbe al rodar sobre el pavimento.
 *
 * Patrón de implementación:
 *   - effect() llena el buffer con cada muestra (~100Hz)
 *   - requestAnimationFrame() dibuja el canvas (~60fps)
 *   - Las dos frecuencias están desacopladas — sin lag en la UI
 *
 * Ver: [[UX-Visual-Innovations]] V7 · [[SuperficieService]] · [[SesionPage]]
 * Ver: [[TTC-Conexiones-Ocultas#Conexión 17|TTC #17]] · [[TTC-Conexiones-Ocultas#Conexión 18|TTC #18]]
 */
@Component({
  selector: 'app-bri-seismograph',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="seismo-wrapper">
      <div class="seismo-header">
        <span class="seismo-label">Señal sismográfica BRI</span>
        <span class="seismo-bri" [style.color]="colorBRI()">{{ bri() }}</span>
      </div>
      <canvas #canvas class="seismo-canvas"></canvas>
      <div class="seismo-escala">
        <span>0</span>
        <span style="color:#ffd43b">2 m/s²</span>
        <span style="color:#ff6b6b">8 m/s²</span>
      </div>
    </div>
  `,
  styles: [`
    .seismo-wrapper {
      margin: 0 16px 8px;
      background: rgba(10, 14, 22, 0.92);
      border-radius: 10px;
      border: 1px solid rgba(77, 171, 247, 0.15);
      overflow: hidden;
    }
    .seismo-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 10px 4px;
    }
    .seismo-label {
      font-size: 0.65rem;
      color: #4a5568;
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }
    .seismo-bri {
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.5px;
      transition: color 0.3s ease;
    }
    .seismo-canvas {
      display: block;
      width: 100%;
      height: 72px;
    }
    .seismo-escala {
      display: flex;
      justify-content: space-between;
      padding: 2px 8px 5px;
      font-size: 0.58rem;
      color: #2d3748;
    }
  `],
})
export class BriSeismographComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') private canvasRef!: ElementRef<HTMLCanvasElement>;

  private readonly superficie = inject(SuperficieService);
  private readonly ruta       = inject(RutaService);

  /** Buffer de magnitudes filtradas — ventana deslizante de 220 puntos */
  private readonly MAX_BUFFER = 220;
  private buffer: number[] = [];
  private ctx!: CanvasRenderingContext2D;
  private rafId = 0;
  private dpr   = 1;

  // ── Signals para el template ─────────────────────────────────────

  readonly bri = computed(() => this.superficie.briActual());

  readonly colorBRI = computed(() => ({
    SUAVE:    '#4dabf7',
    MODERADO: '#ffd43b',
    SEVERO:   '#ff6b6b',
    CRITICO:  '#ff0040',
  }[this.bri()] ?? '#4dabf7'));

  // ── Effect: llena el buffer con cada muestra (~100Hz) ────────────

  private readonly _sampleEffect = effect(() => {
    const mag = this.superficie.magnitudFiltrada();
    if (!this.ruta.sesionActiva()) return;
    this.buffer.push(mag);
    if (this.buffer.length > this.MAX_BUFFER) this.buffer.shift();
  });

  // ── Ciclo de renderizado (RAF, independiente de Angular CD) ──────

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    this.dpr = window.devicePixelRatio || 1;
    this.ctx = canvas.getContext('2d')!;
    this.rafId = requestAnimationFrame(() => this.loop());
  }

  private loop(): void {
    this.draw();
    this.rafId = requestAnimationFrame(() => this.loop());
  }

  private draw(): void {
    const canvas = this.canvasRef.nativeElement;

    // Auto-resize en cada frame — resuelve el bug de canvas width=0
    // cuando el componente renderiza antes de que el layout tenga dimensiones.
    // offsetWidth/Height son síncronos y reflejan el tamaño CSS real en cada frame.
    const cssW = canvas.offsetWidth;
    const cssH = canvas.offsetHeight;
    if (cssW > 0 && cssH > 0) {
      const targetW = Math.round(cssW * this.dpr);
      const targetH = Math.round(cssH * this.dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width  = targetW;
        canvas.height = targetH;
      }
    }

    const w = canvas.width  / this.dpr;
    const h = canvas.height / this.dpr;
    if (w === 0 || h === 0) return; // layout aún no asignado — saltar este frame

    this.ctx.save();
    this.ctx.scale(this.dpr, this.dpr);

    // ── Fondo ────────────────────────────────────────────────────
    this.ctx.clearRect(0, 0, w, h);

    const mid = h / 2;

    // ── Líneas de referencia (umbrales BRI) ──────────────────────
    // Escala: 12 m/s² = altura máxima (SEVERO = 8, CRITICO = 87.3)
    const MAX_MS2 = 12;
    const pad     = 4;
    const amp     = mid - pad;

    // Umbral MODERADO (2 m/s²)
    const yMod = mid - (2 / MAX_MS2) * amp;
    this.ctx.strokeStyle = 'rgba(255, 212, 59, 0.12)';
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([4, 4]);
    this.ctx.beginPath();
    this.ctx.moveTo(0, yMod); this.ctx.lineTo(w, yMod);
    this.ctx.moveTo(0, h - yMod + pad); this.ctx.lineTo(w, h - yMod + pad);
    this.ctx.stroke();

    // Umbral SEVERO (8 m/s²)
    const ySev = mid - (8 / MAX_MS2) * amp;
    this.ctx.strokeStyle = 'rgba(255, 107, 107, 0.15)';
    this.ctx.beginPath();
    this.ctx.moveTo(0, ySev); this.ctx.lineTo(w, ySev);
    this.ctx.moveTo(0, h - ySev + pad); this.ctx.lineTo(w, h - ySev + pad);
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    // ── Línea central de referencia ──────────────────────────────
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, mid); this.ctx.lineTo(w, mid);
    this.ctx.stroke();

    if (this.buffer.length < 2) {
      // ── Modo standby: flatline (TTC Holter cardiaco — corazón en reposo) ──
      // Colores calibrados para contraste sobre fondo #040810 (WCAG AA mínimo)
      const isActive = this.ruta.sesionActiva();

      if (isActive) {
        // Sesión activa pero buffer aún vacío: línea sólida azul plasma
        this.ctx.strokeStyle = 'rgba(0, 200, 255, 0.45)';
        this.ctx.lineWidth   = 1.5;
      } else {
        // Standby: línea punteada cyan oscuro — visible pero discreta
        this.ctx.strokeStyle = 'rgba(0, 144, 224, 0.35)';
        this.ctx.lineWidth   = 1;
        this.ctx.setLineDash([3, 7]);
      }

      this.ctx.beginPath();
      this.ctx.moveTo(0, mid);
      this.ctx.lineTo(w, mid);
      this.ctx.stroke();
      this.ctx.setLineDash([]);

      if (!isActive) {
        // Label STANDBY — fuente legible sobre fondo oscuro
        this.ctx.fillStyle  = 'rgba(0, 144, 224, 0.45)';
        this.ctx.font       = '9px monospace';
        this.ctx.textAlign  = 'center';
        this.ctx.fillText('STANDBY', w / 2, mid - 10);
      }

      this.ctx.restore();
      return;
    }

    // ── Waveform ─────────────────────────────────────────────────
    const color = this.colorBRI();
    const step  = w / (this.MAX_BUFFER - 1);

    // Glow difuso
    this.ctx.shadowColor  = color;
    this.ctx.shadowBlur   = 6;
    this.ctx.strokeStyle  = color;
    this.ctx.lineWidth    = 1.5;
    this.ctx.lineJoin     = 'round';
    this.ctx.beginPath();

    let first = true;
    this.buffer.forEach((v, i) => {
      const x = i * step;
      const y = mid - Math.min(amp, (v / MAX_MS2) * amp);
      if (first) { this.ctx.moveTo(x, y); first = false; }
      else        { this.ctx.lineTo(x, y); }
    });
    this.ctx.stroke();

    // Degradado de "cabeza activa" — el punto más reciente brilla
    const lastX = (this.buffer.length - 1) * step;
    const lastV = this.buffer[this.buffer.length - 1] ?? 0;
    const lastY = mid - Math.min(amp, (lastV / MAX_MS2) * amp);
    this.ctx.shadowBlur = 14;
    this.ctx.fillStyle  = color;
    this.ctx.beginPath();
    this.ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
    this.ctx.fill();

    this.ctx.shadowBlur = 0;
    this.ctx.restore();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
  }
}
