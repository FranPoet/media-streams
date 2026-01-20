const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

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

const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  let openaiReady = false;
  let listening = false;

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // 🔹 OPENAI CONNECTED
  openaiWs.on("open", () => {
    openaiReady = true;
    console.log("OpenAI connected");

    // 🔊 ПРИВЕТСТВИЕ — СРАЗУ
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio"],
        instructions:
          "Слава Україні! Я — Primarch, твій персональний ШІ-помічник. Я готовий допомогти тобі з будь-якими питаннями. Просто скажи, що тобі потрібно.",
        audio: { voice: "alloy", format: "mulaw" }
      }
    }));

    // Через паузу начинаем слушать
    setTimeout(() => {
      listening = true;
    }, 2000);
  });

  // 🔹 TWILIO AUDIO
  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "media" && openaiReady && listening) {
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: data.media.payload
      }));
    }

    if (data.event === "stop" && openaiReady && listening) {
      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions: "Отвечай коротко, естественно, по-русски.",
          audio: { voice: "alloy", format: "mulaw" }
        }
      }));
    }
  });

  // 🔹 OPENAI → TWILIO
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

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
