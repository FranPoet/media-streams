const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;

// === 1. Функция сохранения в БД ===
// Сохраняет статусы и транскрипцию разговора
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
    // Логируем в консоль только смену статусов, чтобы не мусорить текстом
    if (status !== 'transcript') console.log(`[DB] Saved status: ${status} for call ${callSid}`);
  })
  .catch(err => console.error(`[DB Error] Could not save stats: ${err.message}`));
}

// === 2. Создание HTTP сервера для Twilio ===
const server = http.createServer((req, res) => {
  if (req.url === "/voice") {
    // Twilio стучится сюда, чтобы получить XML для подключения стрима
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`
      <Response>
        <Connect>
          <Stream url="wss://${req.headers.host}/media" />
        </Connect>
      </Response>
    `);
  } else {
    res.writeHead(200).end("Primarch AI Server Running");
  }
});

// === 3. Создание WebSocket сервера ===
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("[Connection] Twilio client connected");

  let streamSid = null;
  let currentCallSid = null;
  let callParams = null; // Здесь будут лежать инструкции из PHP
  let openaiWs = null;

  // Подключаемся к OpenAI Realtime API
  openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // --- ФУНКЦИЯ ЗАПУСКА СЕССИИ ---
  // Запускается ТОЛЬКО когда у нас есть и соединение с OpenAI, и данные от клиента (PHP)
  const startSession = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (!callParams) return;

    console.log(`[Session] Initializing for ${callParams.toNumber}. Voice: ${callParams.voice}`);
    console.log(`[Session] System Prompt Length: ${callParams.prompt.length} chars`);

    // 1. Отправляем ГЛАВНУЮ ИНСТРУКЦИЮ (Context)
    // Именно здесь AI узнает, что он врач, секретарь или механик.
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: callParams.prompt, // <--- САМОЕ ВАЖНОЕ: Текст из базы данных (роль + календарь + инфо)
        voice: callParams.voice,         // <--- Голос из базы
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
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

    // 2. Отправляем ПРИВЕТСТВИЕ (Greeting)
    // Мы приказываем AI прочитать текст приветствия, а не генерировать его.
    const greetingText = callParams.greeting || "Dzień dobry.";
    
    const initialGreeting = {
        type: "response.create",
        response: {
            modalities: ["text", "audio"],
            // Жесткая инструкция: "Скажи именно это"
            instructions: `Twoim pierwszym zadaniem jest wypowiedzenie tego zdania na głos: "${greetingText}"`
        }
    };
    openaiWs.send(JSON.stringify(initialGreeting));
    console.log(`[Session] Greeting triggered: "${greetingText}"`);
  };

  // Когда OpenAI готов
  openaiWs.on("open", () => {
    console.log("[OpenAI] Connected to API");
    if (callParams) startSession(); // Если параметры от Twilio уже пришли - стартуем
  });

  // --- СООБЩЕНИЯ ОТ TWILIO ---
  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          const custom = data.start.customParameters;
          
          if (custom) {
            // Получаем ВСЮ информацию о бизнесе из PHP
            callParams = {
                prompt: custom.prompt,     // Полный текст (Роль + Инфо + Календарь)
                voice: custom.voice,       // Голос
                greeting: custom.greeting, // Приветствие
                callSid: custom.callSid,
                fromNumber: custom.fromNumber,
                toNumber: custom.toNumber
            };
            currentCallSid = custom.callSid;

            console.log(`[Twilio] Call Started. From: ${callParams.fromNumber} -> To: ${callParams.toNumber}`);
            
            // Если OpenAI уже подключился - стартуем сессию прямо сейчас
            if (openaiWs.readyState === WebSocket.OPEN) {
                startSession();
            }
            
            // Фиксируем звонок в базе
            saveCallToDb(currentCallSid, "started", { 
                from_number: callParams.fromNumber, 
                to_number: callParams.toNumber 
            });
          }
          break;

        case "media":
          // Пересылаем аудио от человека в OpenAI
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload
            }));
          }
          break;

        case "stop":
          console.log(`[Twilio] Call ended: ${currentCallSid}`);
          saveCallToDb(currentCallSid, "completed");
          if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
          break;
      }
    } catch (err) {
      console.error("[Twilio Error]", err);
    }
  });

  // --- СООБЩЕНИЯ ОТ OPENAI ---
  openaiWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      // 1. Аудио ответ от AI -> отправляем в Twilio (в телефон)
      if (data.type === "response.audio.delta" && streamSid) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid: streamSid,
          media: { payload: data.delta }
        }));
      }

      // 2. Транскрипция слов ЧЕЛОВЕКА -> сохраняем в базу
      if (data.type === "conversation.item.input_audio_transcription.completed") {
          const userText = data.transcript.trim();
          if (userText) {
            saveCallToDb(currentCallSid, "transcript", { text: "User: " + userText });
          }
      }

      // 3. Транскрипция слов AI -> сохраняем в базу
      if (data.type === "response.audio_transcript.done") {
          const aiText = data.transcript.trim();
          if (aiText) {
            saveCallToDb(currentCallSid, "transcript", { text: "AI: " + aiText });
          }
      }

      // Логирование ошибок
      if (data.type === "error") {
        console.error("[OpenAI API Error]", data.error);
      }

    } catch (err) {
      console.error("[OpenAI Message Error]", err);
    }
  });

  // Закрытие соединения
  twilioWs.on("close", () => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      saveCallToDb(currentCallSid, "completed");
      openaiWs.close();
    }
    console.log("[Connection] Twilio client disconnected");
  });

  openaiWs.on("error", (err) => console.error("[OpenAI WebSocket Error]", err));
});

// Запуск сервера
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
