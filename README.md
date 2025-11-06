# WhatsApp Bot (Baileys + Groq)

Este bot utiliza [Baileys](https://github.com/WhiskeySockets/Baileys) para conectarse a WhatsApp Web y Groq para generar respuestas inteligentes en español.

## Requisitos

- Node.js 18 o superior.
- Una cuenta en [Groq](https://groq.com/) con clave de API válida.

## Configuración

1. Instala dependencias:
   ```bash
   npm install
   ```
2. Duplica `.env.example` como `.env` y completa los valores:
   ```env
   GROQ_API_KEY=sk-XXXXXXXXXXXXXXXXXXXX
   GROQ_BASE_URL=https://api.groq.com/openai/v1
   GROQ_MODEL=llama-3.1-8b-instant
   SYSTEM_PROMPT=Eres un asistente útil, amable y preciso. Responde en español.
   ```
   - `SYSTEM_PROMPT` es opcional; puedes personalizar el tono de la IA.
3. Inicia sesión escaneando el QR:
   ```bash
   npm start
   ```
   También puedes usar recarga automática con:
   ```bash
   npm run dev
   ```

## Uso

- El bot responde automáticamente a mensajes entrantes (no procesa mensajes propios ni de `status@broadcast`).
- Usa Groq para cada turno con memoria corta por chat (últimos 10 mensajes relevantes).
- Hay un rate-limit simple por chat (1 mensaje cada 2 segundos). Si se excede, verás "Estoy procesando tu mensaje, dame un segundo 🙏".
- Si la llamada a Groq falla, responde con un mensaje de fallback sin detener el bot.

### Comandos disponibles

- `/ping` – Muestra latencia aproximada del mensaje.
- `/reset` – Limpia la memoria del chat actual.

## Diagnóstico rápido

- Ejecuta `npm run doctor` para validar conectividad contra la API configurada.

## Desarrollo

- El código principal vive en `index.js`.
- La integración con Groq y la memoria por chat está encapsulada en `lib/groq.js`.
- Las variables de entorno se cargan con un cargador ligero definido en `vendor/dotenv/config.js`.

¡Listo! Tu bot ya puede atender conversaciones con IA desde WhatsApp.
