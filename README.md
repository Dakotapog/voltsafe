# VoltSafe

Plataforma inteligente de movilidad eléctrica personal para Bogotá. Aplicación móvil Ionic + Angular + Capacitor que funciona **100% offline**.

Proyecto académico — Módulo Énfasis en Programación Móvil  
Institución Universitaria Politécnico Grancolombiano · Junio 2026  
Autor: David Alberto Coronado Tabares

---

## Requisitos previos

| Herramienta | Versión mínima | Notas |
|---|---|---|
| Node.js | 22.x | https://nodejs.org |
| pnpm | 9.x | `npm install -g pnpm` |
| Angular CLI | 20.x | `npm install -g @angular/cli` |
| JDK | 21.x | Eclipse Temurin recomendado — **NO usar JDK 25** |
| Android Studio | Ladybug+ | SDK 34, Build Tools 34.0.0 |

---

## Instalación rápida (APK precompilado)

El APK de producción ya está firmado y listo para instalar:

```
android/app/build/outputs/apk/release/app-release.apk
```

1. Copiar el APK al dispositivo Android (7.0+).
2. En el dispositivo: **Ajustes → Seguridad → Instalar apps desconocidas**.
3. Abrir el archivo APK e instalar.
4. Conceder permisos: **Ubicación (siempre activa)**, Movimiento y Almacenamiento.

---

## Compilar desde código fuente

```bash
# 1. Clonar el repositorio
git clone https://github.com/Dakotapog/voltsafe.git
cd voltsafe

# 2. Instalar dependencias
pnpm install

# 3. Compilar la app web
pnpm run build

# 4. Sincronizar con Android
pnpm exec cap sync android
```

### APK de debug (sin firma)

```powershell
cd android
.\gradlew assembleDebug
```

Salida: `android\app\build\outputs\apk\debug\app-debug.apk`

### APK de producción (firmado)

```powershell
cd android
.\gradlew assembleRelease `
  -Pandroid.injected.signing.store.file=C:\ruta\absoluta\a\voltsafe\android\voltsafe.keystore `
  -Pandroid.injected.signing.store.password=CONTRASEÑA `
  -Pandroid.injected.signing.key.alias=voltsafe `
  -Pandroid.injected.signing.key.password=CONTRASEÑA
```

> **Nota:** usar siempre la ruta **absoluta** al keystore. La ruta relativa falla con `validateSigningRelease FAILED`.

Salida: `android\app\build\outputs\apk\release\app-release.apk`

---

## Servidor de desarrollo (navegador)

```bash
pnpm run start
```

Abrir `http://localhost:4200` en Chrome o Edge.

> Los módulos de GPS, acelerómetro y SQLite solo funcionan en el APK instalado en dispositivo físico.

---

## Funcionalidades implementadas

| RF | Funcionalidad | Estado |
|---|---|---|
| RF-01 | Cálculo de autonomía de batería (curva Li-ion + topografía) | ✅ |
| RF-02 | Registro de ruta con GPS y foto EXIF | ✅ |
| RF-03 | Detección de superficie BRI (acelerómetro 100 Hz) | ✅ |
| RF-04 | Mapa offline con ciclorrutas IDECA (6,182 segmentos) | ✅ |
| RF-05 | Zonas de peligro con alertas hápticas | ✅ |
| RF-06 | SOS familiar por WhatsApp / SMS | ✅ |
| RF-07 | Última milla — estaciones TransMilenio cercanas | ✅ |
| RF-08 | Seguridad de género — denuncia rápida en 2 taps | ✅ |
| RF-09 | Externalidades positivas (CO₂, ahorro, calorías) | ✅ |
| RF-10 | Exportación DaaS — GeoJSON RFC 7946 anónimo | ✅ |

---

## Stack tecnológico

- **Ionic 8** + **Angular 20** + **Capacitor 8.3.4**
- **TypeScript 5.9** con `strict: true`
- **SQLite** vía `@capacitor-community/sqlite v8.1` (6 tablas locales)
- **Leaflet.js 1.9.4** con datos GeoJSON offline (sin tile server)
- **Angular Signals** como sistema de estado (sin RxJS para UI)

---

## Estructura del proyecto

```
src/
├── app/
│   ├── models/          # Interfaces TypeScript puras
│   ├── services/        # Lógica de negocio (13 servicios — uno por RF)
│   ├── pages/
│   │   ├── home/        # Dashboard autonomía + gauge
│   │   ├── sesion/      # Cockpit GPS + BRI + SOS + Género
│   │   ├── mapa/        # Leaflet offline + zonas + última milla
│   │   └── perfil/      # Impacto ambiental + exportación DaaS
│   └── utils/           # haversine.ts, bri-calculator.ts
├── assets/
│   └── data/
│       └── ciclovias.geojson   # Red ciclorrutas Bogotá (IDECA)
└── theme/
    └── variables.scss   # Paleta F1 McLaren Telemetría
```

---

## Verificado en

- **Dispositivo:** Motorola Moto G54 5G (serial ZY22HN592S)
- **Android:** 14 (API 34)
- **Modo avión:** ✅ todas las funcionalidades offline verificadas

---

## Licencia

Proyecto académico — uso educativo. Los datos de ciclorrutas pertenecen a IDECA (Bogotá).
