const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;

// Функция для сохранения статистики
function saveCallToDb(callSid, status, extraData = {}) {
  if (!callSid) return;
  const url = 'https://primarch.eu/update_stats.php'; 
  const payload = { call_sid: callSid, status: status, ...extraData };
  axios.post(url, payload).catch(err => console.error("[DB] Error:", err.message));
}

// Функция реального бронирования через PHP
async function makeBooking(phoneNumber, dateTime, note) {
    try {
        const response = await axios.post('https://primarch.eu/booking_api.php', {
            phone: phoneNumber,
            datetime: dateTime,
            note: note
        });
        return response.data; // { status: "success", message: "..." }
    } catch (error) {
        return { status: "error", message: "Błąd serwera rezerwacji" };
    }
}

// Определение инструмента для OpenAI
const toolsDefinition = [
  {
    type: "function",
    name: "book_appointment",
    description: "Rezerwuje wizytę w kalendarzu na podaną datę i godzinę.",
    parameters: {
      type: "object",
      properties: {
        datetime: {
          type: "string",
          description: "Data i godzina wizyty w formacie ISO 8601 (np. 2024-05-20 14:00:00). Rok bieżący to 2024."
        },
        note: {
          type: "string",
          description: "Krótka notatka o celu wizyty lub imię klienta."
        }
      },
      required: ["datetime"]
    }
  }
];

const server = http.createServer((req, res) => {
  if (req.url === "/voice") {
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`<Response><Connect><Stream url="wss://${req.headers.host}/media" /></Connect></Response>`);
  } else {
    res.writeHead(200).end("Server Ready");
  }
});

const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("[Twilio] Connected");

  let streamSid = null;
  let currentCallSid = null;
  let callParams = null;
  let openaiWs = null;

  openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  const startSession = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (!callParams) return;

    console.log(`[Init] Prompt length: ${callParams.prompt.length} chars. Voice: ${callParams.voice}`);

    // Формируем конфиг сессии
    const sessionConfig = {
      modalities: ["text", "audio"],
      instructions: callParams.prompt,
      voice: callParams.voice,
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 }
    };

    // Если в PHP разрешили бронирование (is_booking_active=1), добавляем инструменты
    if (callParams.allowBooking == '1') {
        sessionConfig.tools = toolsDefinition;
        sessionConfig.tool_choice = "auto";
        console.log("[Init] Booking tools enabled.");
    }

    // 1. Обновляем сессию
    openaiWs.send(JSON.stringify({ type: "session.update", session: sessionConfig }));

    // 2. Приветствие
    const greetingText = callParams.greeting || "Halo?";
    openaiWs.send(JSON.stringify({
        type: "response.create",
        response: {
            modalities: ["text", "audio"],
            instructions: `Przeczytaj to zdanie dokładnie: "${greetingText}"`
        }
    }));
  };

  openaiWs.on("open", () => {
    console.log("[OpenAI] Connected");
    if (callParams) startSession();
  });

  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          const custom = data.start.customParameters;
          if (custom) {
            callParams = {
                prompt: custom.prompt,
                voice: custom.voice,
                greeting: custom.greeting,
                callSid: custom.callSid,
                fromNumber: custom.fromNumber,
                toNumber: custom.toNumber,
                allowBooking: custom.allowBooking // Получаем флаг бронирования
            };
            currentCallSid = custom.callSid;
            console.log(`[Twilio] Call to: ${callParams.toNumber}`);
            if (openaiWs.readyState === WebSocket.OPEN) startSession();
            saveCallToDb(currentCallSid, "started", { from_number: callParams.fromNumber, to_number: callParams.toNumber });
          }
          break;
        case "media":
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
          }
          break;
        case "stop":
          saveCallToDb(currentCallSid, "completed");
          if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
          break;
      }
    } catch (e) { }
  });

  openaiWs.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);

      // 1. Аудио
      if (data.type === "response.audio.delta" && streamSid) {
        twilioWs.send(JSON.stringify({ event: "media", streamSid: streamSid, media: { payload: data.delta } }));
      }

      // 2. Обработка ВЫЗОВА ИНСТРУМЕНТА (Booking)
      if (data.type === "response.function_call_arguments.done") {
          console.log("[Tool] AI wants to book:", data.name, data.arguments);
          
          if (data.name === "book_appointment") {
              const args = JSON.parse(data.arguments);
              
              // Вызываем PHP API для записи в базу
              const result = await makeBooking(callParams.toNumber, args.datetime, args.note);
              
              console.log("[Tool] Booking result:", result);

              // Отправляем результат обратно AI
              const toolOutput = {
                  type: "conversation.item.create",
                  item: {
                      type: "function_call_output",
                      call_id: data.call_id, 
                      output: JSON.stringify(result) 
                  }
              };
              openaiWs.send(JSON.stringify(toolOutput));
              
              // Заставляем AI ответить на основе результата ("Успешно записано!")
              openaiWs.send(JSON.stringify({type: "response.create"}));
          }
      }

      // 3. Транскрипция (логи)
      if (data.type === "conversation.item.input_audio_transcription.completed") {
        const text = data.transcript.trim();
        if(text) saveCallToDb(currentCallSid, "transcript", { text: "User: " + text });
      }
      if (data.type === "response.audio_transcript.done") {
        const text = data.transcript.trim();
        if(text) saveCallToDb(currentCallSid, "transcript", { text: "AI: " + text });
      }

    } catch (e) { console.error("[OpenAI Error]", e); }
  });

  twilioWs.on("close", () => {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

server.listen(PORT, () => console.log(`Listening on ${PORT}`));
