const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;

function saveCallToDb(callSid, status, extraData = {}) {
  if (!callSid) return;
  const url = 'https://primarch.eu/update_stats.php'; 
  const payload = { call_sid: callSid, status: status, ...extraData };
  axios.post(url, payload).catch(err => {});
}

async function makeBooking(assistantPhone, dateTime, note) {
    console.log(`[Booking] Request: ${dateTime}`);
    try {
        const response = await axios.post('https://primarch.eu/booking_api.php', {
            phone: assistantPhone, 
            datetime: dateTime,
            note: note
        });
        return response.data;
    } catch (error) {
        return { status: "error", message: "Błąd bazy danych." };
    }
}

async function sendSmsViaPhp(phoneNumber, message) {
    try {
        await axios.post('https://primarch.eu/send_sms.php', {
            phone: phoneNumber,
            message: message
        });
        return true;
    } catch (error) {
        console.error("SMS Error:", error.message);
        return false;
    }
}

// === ОБНОВЛЕННЫЕ ОПИСАНИЯ ИНСТРУМЕНТОВ ===
const toolsDefinition = [
  {
      type: "function",
      name: "send_verification_sms",
      description: "KROK 1 WERYFIKACJI. Wysyła 4-cyfrowy kod SMS na numer dzwoniącego. Uruchom to, gdy ustalicie termin i imię.",
      parameters: { type: "object", properties: {} }
  },
  {
      type: "function",
      name: "check_verification_code",
      description: "KROK 2 WERYFIKACJI. Sprawdza kod podyktowany przez klienta. Zwraca 'success' lub 'error'.",
      parameters: {
          type: "object",
          properties: {
              code: { type: "string", description: "Kod podany przez klienta (np. 1234)." }
          },
          required: ["code"]
      }
  },
  {
    type: "function",
    name: "book_appointment",
    description: "FINALIZACJA. Zapisuje wizytę w bazie. UWAGA: Wolno użyć TYLKO jeśli funkcja 'check_verification_code' zwróciła 'success'.",
    parameters: {
      type: "object",
      properties: {
        datetime: { type: "string", description: "Format ISO: YYYY-MM-DD HH:mm:ss" },
        note: { type: "string", description: "Imię klienta, Nazwisko i Nazwa usługi." }
      },
      required: ["datetime", "note"]
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
  
  let verificationCode = null;
  let smsSentCount = 0;
  const SMS_LIMIT = 2;
  let isVerified = false; // Флаг верификации

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

    const sessionConfig = {
      modalities: ["text", "audio"],
      instructions: callParams.prompt,
      voice: callParams.voice,
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 }
    };

    if (callParams.allowBooking == '1') {
        sessionConfig.tools = toolsDefinition;
        sessionConfig.tool_choice = "auto";
    }

    openaiWs.send(JSON.stringify({ type: "session.update", session: sessionConfig }));

    const initialGreeting = {
        type: "response.create",
        response: {
            modalities: ["text", "audio"],
            instructions: `Please say exact greeting from system prompt.`
        }
    };
    openaiWs.send(JSON.stringify(initialGreeting));
  };

  openaiWs.on("open", () => {
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
                callSid: custom.callSid,
                assistantPhone: custom.assistantPhone, 
                allowBooking: custom.allowBooking,
                from: custom.fromNumber,
                to: custom.toNumber
            };
            currentCallSid = custom.callSid;
            if (openaiWs.readyState === WebSocket.OPEN) startSession();
            
            saveCallToDb(currentCallSid, "started", { 
                from_number: callParams.from, 
                to_number: callParams.to,
                phone_number: callParams.from 
            });
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

      if (data.type === "input_audio_buffer.speech_started") {
          if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid: streamSid }));
          openaiWs.send(JSON.stringify({ type: "response.cancel" }));
      }

      if (data.type === "response.audio.delta" && streamSid) {
        twilioWs.send(JSON.stringify({ event: "media", streamSid: streamSid, media: { payload: data.delta } }));
      }

      if (data.type === "response.function_call_arguments.done") {
          console.log("[Tool] Executing:", data.name);
          let result = { status: "error", message: "Unknown error" };

          // 1. Отправка SMS
          if (data.name === "send_verification_sms") {
              if (smsSentCount >= SMS_LIMIT) {
                  result = { status: "error", message: "Limit SMS wyczerpany." };
              } else {
                  const code = Math.floor(1000 + Math.random() * 9000).toString();
                  verificationCode = code; 
                  smsSentCount++;
                  const message = `Twój kod: ${code}`;
                  sendSmsViaPhp(callParams.from, message);
                  result = { status: "success", message: "Kod wysłany." };
              }
          }

          // 2. Проверка кода
          else if (data.name === "check_verification_code") {
              const args = JSON.parse(data.arguments);
              const userCode = args.code ? args.code.replace(/[^0-9]/g, "") : "";

              if (verificationCode && userCode === verificationCode) {
                  isVerified = true; // СТАВИМ ФЛАГ
                  result = { status: "success", message: "Kod poprawny. Możesz rezerwować." };
              } else {
                  result = { status: "error", message: "Kod nieprawidłowy." };
              }
          }

          // 3. Бронирование (СТРОГАЯ ЗАЩИТА)
          else if (data.name === "book_appointment") {
              if (!isVerified) {
                   // Если бот пытается забронировать БЕЗ проверки
                   result = { status: "error", message: "BLOKADA: Musisz najpierw poprosić klienta o kod SMS i użyć check_verification_code!" };
              } else {
                   const args = JSON.parse(data.arguments);
                   result = await makeBooking(callParams.assistantPhone, args.datetime, args.note);
              }
          }

          const toolOutput = {
              type: "conversation.item.create",
              item: { type: "function_call_output", call_id: data.call_id, output: JSON.stringify(result) }
          };
          openaiWs.send(JSON.stringify(toolOutput));
          openaiWs.send(JSON.stringify({type: "response.create"}));
      }

      if (data.type === "conversation.item.input_audio_transcription.completed") {
        const text = data.transcript.trim();
        if(text) saveCallToDb(currentCallSid, "transcript", { text: "User: " + text });
      }
      if (data.type === "response.audio_transcript.done") {
        const text = data.transcript.trim();
        if(text) saveCallToDb(currentCallSid, "transcript", { text: "AI: " + text });
      }

    } catch (e) { }
  });

  twilioWs.on("close", () => {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

server.listen(PORT, () => console.log(`Listening on ${PORT}`));
