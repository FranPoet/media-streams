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

  let streamSid = null; // Нужно для отправки аудио обратно в Twilio

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Настройка сессии OpenAI
  const initializeSession = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: "Ты живой голосовой ассистент. Отвечай коротко и естественно по-русски.",
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad", // OpenAI сам поймет, когда вы замолчали
        },
      },
    };
    openaiWs.send(JSON.stringify(sessionUpdate));
  };

  openaiWs.on("open", () => {
    console.log("OpenAI connected");
    initializeSession();
  });

  twilioWs.on("message", (msg) => {
    const data = JSON.parse(msg);

    switch (data.event) {
      case "start":
        streamSid = data.start.streamSid;
        console.log("Stream started:", streamSid);
        break;

      case "media":
        // Просто пересылаем аудио в OpenAI без лишних условий
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload
          }));
        }
        break;
        
      case "stop":
        console.log("Twilio stream stopped");
        break;
    }
  });

  openaiWs.on("message", (msg) => {
    const data = JSON.parse(msg);

    // Если OpenAI прислал кусочек аудио — отправляем в Twilio
    if (data.type === "response.audio.delta" && streamSid) {
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: streamSid, // ОБЯЗАТЕЛЬНО
        media: { payload: data.delta }
      }));
    }
  });

  twilioWs.on("close", () => {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    console.log("Twilio disconnected");
  });

  openaiWs.on("error", (error) => {
    console.error("OpenAI Error:", error);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
