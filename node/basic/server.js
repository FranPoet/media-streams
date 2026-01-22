const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;

function saveCallToDb(callSid, status, extraData = {}) {
  if (!callSid) return;
  const url = 'https://primarch.eu/update_stats.php'; 
  const payload = { call_sid: callSid, status: status, ...extraData };
  
  axios.post(url, payload)
  .then(() => {
    if (status !== 'transcript') console.log(`Stat updated: ${status} for ${callSid}`);
  })
  .catch(err => console.error("DB Stat Error:", err.message));
}

const server = http.createServer((req, res) => {
  if (req.url === "/voice") {
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`<Response><Connect><Stream url="wss://${req.headers.host}/media" /></Connect></Response>`);
  } else {
    res.writeHead(200).end("Server is running");
  }
});

const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("Twilio client connected");

  let streamSid = null;
  let currentCallSid = null;
  // Дефолтные настройки (на случай сбоя)
  let instructions = "Jesteś pomocnym asystentem. Mów po polsku.";
  let voice = "alloy";
  
  // Флаги готовности
  let isOpenAIConnected = false;
  let isTwilioParamsReceived = false;
  let isSessionInitialized = false;

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Главная функция запуска диалога
  const initializeSession = () => {
    // Запускаем только если оба готовы и еще не запускали
    if (!isOpenAIConnected || !isTwilioParamsReceived || isSessionInitialized) return;

    console.log("Initialization: Updating session with specific prompt...");

    // 1. Обновляем сессию (Промпт и Голос)
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: instructions, // Тут уже будет правильный промпт от PHP
        voice: voice,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
      },
    };
    openaiWs.send(JSON.stringify(sessionUpdate));

    // 2. ПРИНУДИТЕЛЬНОЕ ПРИВЕТСТВИЕ (Greeting)
    // Мы отправляем команду боту "Скажи привет"
    const triggerGreeting = {
        type: "response.create",
        response: {
            modalities: ["text", "audio"],
            instructions: "Przywitaj się krótko po polsku (np. Dzień dobry, w czym mogę pomóc?)."
        }
    };
    openaiWs.send(JSON.stringify(triggerGreeting));

    isSessionInitialized = true;
  };

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI");
    isOpenAIConnected = true;
    initializeSession(); // Пробуем запустить (если параметры уже есть)
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
            // Применяем параметры из PHP
            instructions = customParams.prompt || instructions;
            voice = customParams.voice || voice;
            currentCallSid = customParams.callSid;
            
            const fromNumber = customParams.fromNumber || 'unknown';
            const toNumber = customParams.toNumber || 'unknown';

            console.log(`Call Params Received. ID: ${currentCallSid}, Voice: ${voice}, To: ${toNumber}`);
            
            // Сохраняем в БД
            saveCallToDb(currentCallSid, "started", { from_number: fromNumber, to_number: toNumber });

            // Отмечаем, что параметры получены, и пробуем запустить сессию
            isTwilioParamsReceived = true;
            initializeSession();
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

      if (data.type === "conversation.item.input_audio_transcription.completed") {
          const userText = data.transcript.trim();
          if (userText) saveCallToDb(currentCallSid, "transcript", { text: "User: " + userText });
      }

      if (data.type === "response.audio_transcript.done") {
          const aiText = data.transcript.trim();
          if (aiText) saveCallToDb(currentCallSid, "transcript", { text: "AI: " + aiText });
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
