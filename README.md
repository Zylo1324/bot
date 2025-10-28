# WhatsApp Bot (Baileys)

## Configuración

1. Ejecuta `npm install` para instalar dependencias.
2. Copia `.env.example` a `.env` y completa:
   - `OPENAI_API_KEY` con tu token de AgentRouter.
   - `OPENAI_BASE_URL`, por ejemplo `https://agentrouter.org/v1`.
   - `MODEL` si deseas cambiar el modelo por defecto (se usa `glm-4.5` si está vacío).
3. Inicia el bot con `npm start` y escanea el QR que aparece en consola.

## Diagnóstico

- Ejecuta `npm run doctor` para validar variables de entorno y conectividad contra `/v1/models`.
- También puedes probar manualmente con `curl`:
  ```bash
  curl -H "Authorization: Bearer $OPENAI_API_KEY" "$OPENAI_BASE_URL/v1/models"
  ```
- Si recibes un `401`, regenera el token en AgentRouter, actualiza `.env` y reinicia el bot.

## Flujo de ventas

- El bot conversa en español, con tono cercano y un par de emojis como máximo.
- Usa el nombre del cliente solo al inicio del saludo.
- Detecta si el cliente pregunta por precios o por un servicio concreto para orientar la respuesta.
- Propone pasos siguientes claros (enviar propuesta, agendar llamada, etc.) para acompañar al cierre.
- Mantiene variaciones en las respuestas para evitar repeticiones literales.

## Pruebas locales

1. `npm install`
2. `npm run doctor`
3. `npm start`
