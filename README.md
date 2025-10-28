# WhatsApp Bot (Baileys)

## Pruebas locales

1. Ejecuta `npm i` para instalar dependencias (incluye `@google/generative-ai`).
2. Copia `.env.example` a `.env` y completa `GEMINI_API_KEY=` con tu clave de Gemini.
3. Inicia el bot con `npm start`.
4. Escanea el código QR mostrado con WhatsApp en tu teléfono.
5. Desde otro número envía `/cmds` y verifica que el bot muestre el indicador "escribiendo…" antes de responder.
6. Comprueba que las respuestas lleguen con demoras entre 1 y 2.5 segundos, sin ráfagas ni duplicados.

### Notas sobre la detección de intención

- El bot usa primero la API de Gemini para identificar si el usuario pide precios o un servicio específico.
- Si la llamada a Gemini falla (clave ausente, timeout, etc.), se activa un detector local por sinónimos/regex para mantener la funcionalidad básica.

Estos pasos no se ejecutaron en este entorno; solo se documentan para referencia local.
