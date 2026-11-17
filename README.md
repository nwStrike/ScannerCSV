# ScannerCSV

PWA para escanear **códigos de barras / QR** y **texto (OCR)** con la cámara del móvil y exportarlo a **CSV** listo para Excel.
Funciona en Safari iOS 16+ y Chrome Android, en el navegador o instalada en la pantalla de inicio.

## Uso

La app tiene tres pestañas abajo: **Escanear**, **Lista** y **Ajustes**.

1. **Código de barras**: «Activar cámara» (la próxima vez se activa sola) y apunta al código. Se guarda solo; abajo aparece el último código con «Deshacer». El botón central pausa/reanuda el escaneo.
2. **Texto (OCR)**: cambia a «Texto», encuadra el documento y pulsa el disparador. Se abre el editor a pantalla completa para elegir los datos:
   - Crea tus **campos** con «+ Campo» (p. ej. «Nº factura», «Cliente», «Total», «Lote», «Caducidad»). Se recuerdan para la próxima vez; se quitan en Ajustes › Campos del OCR.
   - Elige un campo en la barra inferior y **toca las palabras** en la foto (o arrastra un recuadro para coger varias). Tocar otra vez una palabra la quita. **Dos dedos** amplían y mueven la imagen (o botones +/−).
   - Corrige el valor a mano si hace falta; «›» pasa al siguiente campo vacío. Pulsa **«Guardar»**: cada documento es una fila y cada campo, una columna del CSV.
   - El botón/gesto «atrás» de Android cierra el editor (pide confirmación si hay datos).
   - En «Texto completo» sigue disponible guardar todo el texto (una fila o una fila por línea).
3. **Galería** (botón de la izquierda): analiza una foto ya hecha (código u OCR, según el modo).
4. **Lista › Exportar CSV**: abre el menú Compartir del sistema (guardar en Archivos, enviar por correo, WhatsApp, Drive…). «Descargar» guarda el archivo directamente.

Toca un escaneo para editarlo, añadirle una nota o borrarlo.

## Publicación

Es un sitio estático, sin compilación. La cámara y el service worker **solo funcionan con HTTPS** (o `localhost`).
Sirve la carpeta tal cual con cualquier hosting HTTPS (GitHub Pages, Netlify, Cloudflare Pages…). Todas las rutas son relativas,
así que funciona también en un subdirectorio (p. ej. `https://usuario.github.io/ScannerCSV/`).

Prueba local:

```bash
python3 -m http.server 8080
```

Al publicar cambios, sube la constante `VERSION` de `sw.js` para que los clientes reciban la versión nueva.

## Compatibilidad iOS / Android

| Requisito | Implementación |
|---|---|
| Lectura de códigos | ZXing-js (`vendor/zxing`) en un Web Worker, en todas las plataformas. `BarcodeDetector` solo se usa como optimización si existe (Chrome Android); en Safari iOS no existe y no hace falta. |
| Cámara | `getUserMedia` con `facingMode: "environment"`; `<video playsinline muted autoplay>`. Se detiene al pasar a segundo plano y se reanuda al volver. |
| Linterna / enfoque táctil | Solo se muestran si `track.getCapabilities()` informa `torch` / `focusMode: single-shot` o `pointsOfInterest`. Si no (iOS), se ocultan sin errores. |
| OCR | Tesseract.js 7 (ya ejecuta en un Web Worker) con barra de progreso. La imagen se reduce a ≤1600 px de lado largo antes del OCR y los canvas se liberan después. El worker se cierra tras 90 s sin uso. |
| Almacenamiento | IndexedDB + `navigator.storage.persist()`. Si no es persistente se muestra un aviso. |
| Instalación | Android: botón «Instalar» (`beforeinstallprompt`). iOS: aviso con los pasos Compartir → Añadir a pantalla de inicio. |
| Exportar | `navigator.share` con un `File` si `canShare` lo permite; si no, descarga con enlace `blob:`. UTF-8 con BOM, CRLF, todos los campos entre comillas. |
| Interfaz | `viewport-fit=cover` + `env(safe-area-inset-*)`, botones ≥48 px, sin `:hover`, sin atajos de teclado, campos a 16 px (evita el zoom de iOS). |
| APIs no soportadas en Safari | `navigator.vibrate`, `BarcodeDetector`, `beforeinstallprompt`, `getCapabilities` se usan solo tras detectar que existen. No se usa Web Bluetooth. |

### CSV y Excel

- Columnas fijas: `Fecha;Tipo;Formato;Valor;Nota`, y después **una columna por cada campo** usado (en el orden de tu lista de campos). Los documentos con campos tienen `Tipo = Documento` y `Valor` vacío.

- Separador por defecto `;` (Excel con configuración regional española). En Ajustes se puede cambiar a `,`.
- Opción «Conservar ceros iniciales y códigos largos»: los códigos numéricos de ≥12 dígitos o con cero inicial se escriben como `="0123…"` para que Excel no los convierta a `1,23E+12` ni quite los ceros.
- Los textos que empiezan por `=`, `+`, `-` o `@` se prefijan con `'` para evitar la inyección de fórmulas.

## OCR sin conexión

El motor de Tesseract (wasm) y los datos de idioma se descargan de `cdn.jsdelivr.net` la primera vez que se usa el OCR
(unos 4 MB de motor + ~2 MB por idioma) y quedan en caché (service worker + IndexedDB).
En Ajustes, «Preparar OCR sin conexión» los descarga por adelantado. La lectura de códigos funciona sin conexión desde el primer momento.

Para no depender del CDN, copia `tesseract.js-core@7.0.0` y `@tesseract.js-data/<idioma>/4.0.0_best_int` a tu servidor y cambia
`CORE_PATH` y añade `langPath` en `js/ocr.js`.

## Estructura

```
index.html              interfaz
css/app.css             estilos (claro/oscuro, safe-area)
js/app.js               lógica principal
js/camera.js            cámara, linterna, enfoque
js/barcode-worker.js    lector de códigos (ZXing + BarcodeDetector opcional)
js/ocr.js               Tesseract.js y reducción de imagen
js/fields.js            selección de campos sobre la imagen del OCR
js/csv.js               generación y exportación del CSV
js/db.js                IndexedDB y almacenamiento persistente
sw.js                   service worker (sin conexión)
vendor/                 @zxing/library 0.23.0 y tesseract.js 7.0.0 (licencia Apache-2.0)
```
