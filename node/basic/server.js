const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

// HTTP server для Render + Twilio webhook
const server = http.createServer((req, res) => {
  if (req.url === "/voice") {
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media" />
  </Connect>
</Response>
    `);
  } else {
    res.writeHead(200);
    res.end("OK");
  }
});

// WebSocket сервер для Twilio
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  let openaiReady = false;
  let responseStarted = false;

  // WebSocket к OpenAI Realtime
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Когда OpenAI подключился
  openaiWs.on("open", () => {
    console.log("OpenAI connected");
    openaiReady = true;
  });

  // Принимаем события от Twilio
  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg);

    // Аудио от Twilio
    if (data.event === "media" && openaiReady) {

      // Создаём ответ ТОЛЬКО ОДИН РАЗ — при первом звуке
      if (!responseStarted) {
        responseStarted = true;

        openaiWs.send(JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio"],
            instructions: "Ты живой голосовой ассистент. Говори коротко, естественно, по-русски.",
            audio: {
              voice: "alloy",
              format: "mulaw"
            }
          }
        }));
      }

      // Отправляем аудио в OpenAI
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: data.media.payload
      }));
    }

    // Новый звонок — отменяем старый ответ
    if (data.event === "start" && openaiReady) {
      responseStarted = false;
      openaiWs.send(JSON.stringify({ type: "response.cancel" }));
    }
  });

  // Получаем аудио от OpenAI и отправляем в Twilio
  openaiWs.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.type === "response.audio.delta") {
      twilioWs.send(JSON.stringify({
        event: "media",
        media: { payload: data.delta }
      }));
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio disconnected");
    openaiWs.close();
  });
});

// Запуск сервера
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
