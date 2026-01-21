const http = require("http");
const WebSocket = require("ws");
const axios = require("axios"); // Добавлено для статистики

const PORT = process.env.PORT || 3000;

// Функция для записи статистики в твою БД через PHP
function saveCallToDb(callSid, status) {
  if (!callSid) return;
  
  // ЗАМЕНИ НА СВОЙ РЕАЛЬНЫЙ URL
  const url = 'https://primarch.eu/update_stats.php'; 
  
  axios.post(url, {
    call_sid: callSid,
    status: status
  })
  .then(() => console.log(`Stat updated: ${status} for ${callSid}`))
  .catch(err => console.error("DB Stat Error:", err.message));
}

// 1. Создаем HTTP сервер
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
    res.end("Server is running");
  }
});

// 2. Создаем WebSocket сервер
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("Twilio client connected");

  let streamSid = null;
  let currentCallSid = null; // Храним CallSid для этого конкретного соединения
  let instructions = "Ты живой голосовой ассистент. Отвечай коротко и естественно по польски.";
  let voice = "alloy";

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  const sendSessionUpdate = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: instructions,
        voice: voice,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        },
      },
    };
    openaiWs.send(JSON.stringify(sessionUpdate));
  };

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI");
    sendSessionUpdate();
  });

  // ОБРАБОТКА СООБЩЕНИЙ ОТ TWILIO
  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          const customParams = data.start.customParameters;
          
          if (customParams) {
            instructions = customParams.prompt || instructions;
            voice = customParams.voice || voice;
            currentCallSid = customParams.callSid; // Сохраняем CallSid из параметров PHP

            console.log("Configuring for Call:", currentCallSid);

            if (openaiWs.readyState === WebSocket.OPEN) {
              sendSessionUpdate();

              // ЗАСТАВЛЯЕМ ГОВОРИТЬ ПЕРВЫМ (Dzień dobry)
              const triggerGreeting = {
                type: "response.create",
                response: {
                  instructions: "Przywitaj się po polsku, powiedz 'Dzień dobry, w czym mogę pomóc?'"
                }
              };
              openaiWs.send(JSON.stringify(triggerGreeting));
            }
            
            // Записываем начало звонка в статистику
            saveCallToDb(currentCallSid, "started");
          }
          break;

        case "media":
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload
            }));
          }
          break;

        case "stop":
          console.log("Call ended:", currentCallSid);
          // Записываем окончание звонка
          saveCallToDb(currentCallSid, "completed");
          if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
          break;
      }
    } catch (err) {
      console.error("Error parsing Twilio message:", err);
    }
  });

  // ОБРАБОТКА СООБЩЕНИЙ ОТ OPENAI
  openaiWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === "response.audio.delta" && streamSid) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid: streamSid,
          media: { payload: data.delta }
        }));
      }

      if (data.type === "error") {
        console.error("OpenAI API Error:", data.error);
      }
    } catch (err) {
      console.error("Error parsing OpenAI message:", err);
    }
  });

  twilioWs.on("close", () => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      saveCallToDb(currentCallSid, "completed"); // На всякий случай при обрыве связи
      openaiWs.close();
    }
  });

  openaiWs.on("error", (err) => console.error("OpenAI WebSocket Error:", err));
});

server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
