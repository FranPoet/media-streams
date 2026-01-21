const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;

// Функция для записи статистики и транскрипции в БД через PHP
function saveCallToDb(callSid, status, extraData = {}) {
  if (!callSid) return;
  
  const url = 'https://primarch.eu/update_stats.php'; 
  
  const payload = {
    call_sid: callSid,
    status: status,
    ...extraData
  };
  
  axios.post(url, payload)
  .then(() => {
    if (status !== 'transcript') console.log(`Stat updated: ${status} for ${callSid}`);
  })
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
  let currentCallSid = null; 
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
        // Включаем транскрипцию входящего аудио от пользователя
        input_audio_transcription: {
            model: "whisper-1"
        },
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
            // 1. Извлекаем параметры конфигурации
            instructions = customParams.prompt || instructions;
            voice = customParams.voice || voice;
            currentCallSid = customParams.callSid; 
            
            // 2. Получаем номера телефонов для идентификации пользователя
            const fromNumber = customParams.fromNumber || 'unknown';
            const toNumber = customParams.toNumber || 'unknown';

            console.log(`Configuring for Call: ${currentCallSid} | From: ${fromNumber} To: ${toNumber}`);

            // 3. Обновляем сессию OpenAI и запускаем приветствие
            if (openaiWs.readyState === WebSocket.OPEN) {
              sendSessionUpdate();

              const triggerGreeting = {
                type: "response.create",
                response: {
                  instructions: "Przywitaj się po polsku, powiedz 'Dzień dobry, w czym mogę pomóc?'"
                }
              };
              openaiWs.send(JSON.stringify(triggerGreeting));
            }
            
            // 4. Записываем начало звонка в БД с передачей номеров
            // Это позволит PHP найти user_id по номеру toNumber
            saveCallToDb(currentCallSid, "started", { 
                from_number: fromNumber, 
                to_number: toNumber 
            });
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
          saveCallToDb(currentCallSid, "completed");
          if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
          break;
      }
    } catch (err) {
      console.error("Error parsing Twilio message:", err);
    }
  });

  // ОБРАБОТКА СООБЩЕНИЙ ОТ OPENAI (Тут ловим текст диалога)
  openaiWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      // 1. Получаем аудио от ИИ и шлем в Twilio
      if (data.type === "response.audio.delta" && streamSid) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid: streamSid,
          media: { payload: data.delta }
        }));
      }

      // 2. Ловим транскрипцию того, что сказал ПОЛЬЗОВАТЕЛЬ
      if (data.type === "conversation.item.input_audio_transcription.completed") {
          const userText = data.transcript.trim();
          if (userText) {
              console.log("User said:", userText);
              saveCallToDb(currentCallSid, "transcript", { text: "User: " + userText });
          }
      }

      // 3. Ловим транскрипцию того, что ответил ИИ
      if (data.type === "response.audio_transcript.done") {
          const aiText = data.transcript.trim();
          if (aiText) {
              console.log("AI said:", aiText);
              saveCallToDb(currentCallSid, "transcript", { text: "AI: " + aiText });
          }
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
      saveCallToDb(currentCallSid, "completed"); 
      openaiWs.close();
    }
  });

  openaiWs.on("error", (err) => console.error("OpenAI WebSocket Error:", err));
});

server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
