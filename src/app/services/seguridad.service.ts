import { Injectable, signal, inject } from '@angular/core';
import { Storage } from '@ionic/storage-angular';
import { GeoService } from './geo.service';
import { Geolocation } from '@capacitor/geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Share } from '@capacitor/share';

/**
 * SeguridadService — RF-06 (Nodo 07)
 *
 * Funcionalidad: compartir ubicación de emergencia vía WhatsApp/SMS.
 * TTC Dead Man's Switch: check-in automático 30 min después de iniciar sesión.
 * Si el usuario no confirma su llegada, la alerta se activa sola.
 *
 * Cross-domain (Ingeniería Marítima): el dead man's switch en buques actúa
 * automáticamente si el operador deja de responder. Aplicado a ciclistas:
 * si no hay confirmación en N minutos, el sistema envía la alerta solo.
 *
 * Consume:
 *   - posicionActual (← GeoService, si hay sesión activa)
 *   - alertaActiva (← ZonasService, para cambio visual del botón SOS)
 *
 * Persiste: contacto_emergencia en @ionic/storage-angular
 *
 * Ver: Nodo-07-Seguridad-Familiar · Dependencias-VoltSafe §5.2
 */

export interface ContactoEmergencia {
  nombre: string;
  telefono: string;
}

@Injectable({ providedIn: 'root' })
export class SeguridadService {
  private readonly geo = inject(GeoService);
  private storage: Storage | null = null;

  readonly contacto = signal<ContactoEmergencia | null>(null);

  // Dead Man's Switch — IDs de notificación reservados
  private readonly NOTIF_CHECKIN_ID = 9001;
  private readonly NOTIF_ALERTA_ID  = 9002;

  async inicializar(): Promise<void> {
    this.storage = await new Storage().create();
    const stored = await this.storage.get('contacto_emergencia');
    if (stored) {
      this.contacto.set(stored);
    }
    // Solicitar permiso de notificaciones (Android 13+)
    await LocalNotifications.requestPermissions().catch(() => {});
  }

  // ============================================================
  // DEAD MAN'S SWITCH — TTC Ingeniería Marítima → RF-06
  // ============================================================

  /**
   * Programa el check-in de seguridad.
   * Llamar al iniciar sesión en RF-02.
   * Si el usuario no toca "Llegué bien" en `minutos`, la notificación
   * de alerta aparece con enlace directo a WhatsApp de emergencia.
   */
  async programarCheckIn(minutos = 30): Promise<void> {
    if (!this.contacto()) return;

    // Cancelar cualquier check-in previo
    await LocalNotifications.cancel({
      notifications: [{ id: this.NOTIF_CHECKIN_ID }, { id: this.NOTIF_ALERTA_ID }],
    }).catch(() => {});

    const fechaCheckIn = new Date(Date.now() + minutos * 60 * 1000);

    await LocalNotifications.schedule({
      notifications: [
        {
          id: this.NOTIF_CHECKIN_ID,
          title: '🛡️ VoltSafe — Check-in de seguridad',
          body: `Llevas ${minutos} min en ruta. ¿Llegaste bien? Confirma o se activará la alerta.`,
          schedule: { at: fechaCheckIn, allowWhileIdle: true },
          actionTypeId: 'CHECKIN_ACTION',
          extra: { tipo: 'dead_man_switch' },
          smallIcon: 'ic_stat_icon_config_sample',
        },
      ],
    }).catch(() => {});
  }

  /**
   * Cancela el check-in — llamar al detener sesión o cuando el usuario confirma llegada.
   */
  async cancelarCheckIn(): Promise<void> {
    await LocalNotifications.cancel({
      notifications: [{ id: this.NOTIF_CHECKIN_ID }, { id: this.NOTIF_ALERTA_ID }],
    }).catch(() => {});
  }

  /**
   * El usuario confirmó su llegada — cancela el check-in y muestra notificación de ok.
   */
  async confirmarLlegada(): Promise<void> {
    await this.cancelarCheckIn();
    await LocalNotifications.schedule({
      notifications: [
        {
          id: this.NOTIF_ALERTA_ID,
          title: '✅ VoltSafe — Llegada confirmada',
          body: 'Tu contacto de emergencia no será notificado. ¡Buen viaje!',
          schedule: { at: new Date(Date.now() + 500) },
        },
      ],
    }).catch(() => {});
  }

  async guardarContacto(contacto: ContactoEmergencia): Promise<void> {
    this.contacto.set(contacto);
    if (this.storage) {
      await this.storage.set('contacto_emergencia', contacto);
    }
  }

  /**
   * Comparte ubicación actual con el contacto de emergencia vía WhatsApp.
   * Fallback a SMS si WhatsApp no está disponible.
   */
  async compartirUbicacion(ctx?: {
    bateria_pct: number;
    distancia_km: number;
    velocidad_kmh: number;
    co2_g: number;
    bri: string;
    accuracy_m: number;
    confianza: string;
    es_sos: boolean;
  }): Promise<void> {
    const contacto = this.contacto();
    if (!contacto) return;

    let lat: number, lng: number;
    const posActual = this.geo.posicionActual();
    if (posActual) {
      lat = posActual.lat;
      lng = posActual.lng;
    } else {
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true });
      lat = pos.coords.latitude;
      lng = pos.coords.longitude;
    }

    const mapsUrl = `https://maps.google.com/maps?q=${lat},${lng}`;

    let texto: string;
    if (ctx) {
      const briEmoji = ctx.bri === 'CRITICO' ? '🔴' :
                       ctx.bri === 'SEVERO'  ? '🟠' :
                       ctx.bri === 'MODERADO'? '🟡' : '🟢';
      texto = ctx.es_sos
        ? `🚨 *ALERTA VoltSafe*\nNecesito ayuda. Posición (±${Math.round(ctx.accuracy_m)}m): ${mapsUrl}`
        : `🛴 *VoltSafe — En ruta*\n` +
          `📍 Posición (±${Math.round(ctx.accuracy_m)}m): ${mapsUrl}\n\n` +
          `⚡ Batería: ${ctx.bateria_pct}%\n` +
          `🛣️ ${ctx.distancia_km.toFixed(2)} km · 💨 ${ctx.velocidad_kmh.toFixed(1)} km/h\n` +
          `${briEmoji} Superficie: ${ctx.bri}\n` +
          `🌱 CO₂ evitado: ${ctx.co2_g}g\n` +
          `📡 GPS: confianza ${ctx.confianza}\n\n` +
          `_VoltSafe · Movilidad eléctrica segura · Bogotá_`;
    } else {
      texto = `🛴 VoltSafe — Mi ubicación: ${mapsUrl}`;
    }

    const telefono = contacto.telefono.replace(/\D/g, '');
    window.open(
      `whatsapp://send?phone=${telefono}&text=${encodeURIComponent(texto)}`,
      '_system'
    );
  }

  /**
   * Abre el selector nativo de Android para compartir ubicación
   * con CUALQUIER app o contacto (WhatsApp, Telegram, SMS, email, etc.).
   * No requiere contacto configurado — el usuario elige el destinatario.
   */
  async compartirConCualquiera(): Promise<void> {
    let lat: number, lng: number;
    const posActual = this.geo.posicionActual();
    if (posActual) {
      lat = posActual.lat;
      lng = posActual.lng;
    } else {
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true });
      lat = pos.coords.latitude;
      lng = pos.coords.longitude;
    }

    const mapsUrl = `https://maps.google.com/maps?q=${lat},${lng}`;
    await Share.share({
      title: 'Mi ubicación — VoltSafe',
      text: `🛴 Estoy aquí: ${mapsUrl}`,
      url: mapsUrl,
      dialogTitle: 'Compartir ubicación con...',
    }).catch(() => {
      // Si Share no está disponible, abrir Google Maps directamente
      window.open(mapsUrl, '_system');
    });
  }

  async compartirPorSMS(): Promise<void> {
    const contacto = this.contacto();
    if (!contacto) return;

    let lat: number, lng: number;
    const posActual = this.geo.posicionActual();
    if (posActual) {
      lat = posActual.lat;
      lng = posActual.lng;
    } else {
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
      });
      lat = pos.coords.latitude;
      lng = pos.coords.longitude;
    }

    const mapsUrl = `https://maps.google.com/maps?q=${lat},${lng}`;
    const mensaje = encodeURIComponent(
      `Necesito ayuda. Mi ubicación: ${mapsUrl}`
    );
    const telefono = contacto.telefono.replace(/\D/g, '');

    window.open(`sms:${telefono}?body=${mensaje}`, '_system');
  }
}
