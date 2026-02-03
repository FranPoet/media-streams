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

// === FUNKCJA REZERWACJI Z DANYMI KLIENTA ===
async function makeBooking(assistantPhone, clientPhone, clientName, serviceName, dateTime) {
    console.log(`[Booking] Klient: ${clientName} (${clientPhone}), Usługa: ${serviceName}, Czas: ${dateTime}`);
    try {
        const response = await axios.post('https://primarch.eu/booking_api.php', {
            phone: assistantPhone,         // Numer asystenta (identyfikator kalendarza)
            client_phone: clientPhone,     // Numer klienta (do zapisu w bazie)
            title: clientName,             // Imię i Nazwisko jako tytuł w kalendarzu
            service_name: serviceName,     // Nazwa usługi
            note: `Usługa: ${serviceName}`,// Dodatkowa notatka
            datetime: dateTime
        });
        console.log("[Booking] Response:", response.data);
        return response.data;
    } catch (error) {
        console.error("[Booking] API Error:", error.message);
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

// === DEFINICJE NARZĘDZI (TOOLS) ===
const toolsDefinition = [
  {
      type: "function",
      name: "send_verification_sms",
      description: "KROK 1 WERYFIKACJI. Wysyła kod SMS. Użyj, gdy masz już datę i imię.",
      parameters: { type: "object", properties: {} }
  },
  {
      type: "function",
      name: "check_verification_code",
      description: "KROK 2 WERYFIKACJI. Sprawdza kod od klienta.",
      parameters: {
          type: "object",
          properties: {
              code: { type: "string", description: "Kod podyktowany przez klienta." }
          },
          required: ["code"]
      }
  },
  {
    type: "function",
    name: "book_appointment",
    description: "FINALIZACJA. Zapisuje wizytę. Wymaga Imienia i Nazwy Usługi. Działa TYLKO po SMS.",
    parameters: {
      type: "object",
      properties: {
        datetime: { type: "string", description: "Data i godzina ISO: YYYY-MM-DD HH:mm:ss" },
        client_name: { type: "string", description: "Imię i Nazwisko klienta (do tytułu wizyty)." },
        service_name: { type: "string", description: "Nazwa wybranej usługi." }
      },
      required: ["datetime", "client_name", "service_name"]
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
  
  // Stan weryfikacji
  let verificationCode = null;
  let smsSentCount = 0;
  const SMS_LIMIT = 2;
  let isVerified = false; 

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

    // === POPRAWKA NA POWITANIE ===
    // Wymuszamy, by AI powiedziało tekst z bazy jako pierwsze.
    const greetingText = callParams.greeting || "Dzień dobry.";
    const initialGreeting = {
        type: "response.create",
        response: {
            modalities: ["text", "audio"],
            instructions: `Please say exactly this phrase immediately: "${greetingText}"`
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
                greeting: custom.greeting,
                callSid: custom.callSid,
                assistantPhone: custom.assistantPhone || custom.toNumber, 
                allowBooking: custom.allowBooking,
                from: custom.fromNumber, // Tutaj jest numer klienta
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

      // === OBSŁUGA NARZĘDZI ===
      if (data.type === "response.function_call_arguments.done") {
          console.log("[Tool] Executing:", data.name);
          let result = { status: "error", message: "Unknown error" };

          // 1. Wysyłka SMS
          if (data.name === "send_verification_sms") {
              if (smsSentCount >= SMS_LIMIT) {
                  result = { status: "error", message: "Limit SMS wyczerpany." };
              } else {
                  const code = Math.floor(1000 + Math.random() * 9000).toString();
                  verificationCode = code; 
                  smsSentCount++;
                  const message = `Twój kod weryfikacyjny: ${code}`;
                  sendSmsViaPhp(callParams.from, message);
                  result = { status: "success", message: "Kod SMS wysłany." };
              }
          }

          // 2. Sprawdzenie kodu
          else if (data.name === "check_verification_code") {
              const args = JSON.parse(data.arguments);
              const userCode = args.code ? args.code.replace(/[^0-9]/g, "") : "";
              if (verificationCode && userCode === verificationCode) {
                  isVerified = true;
                  result = { status: "success", message: "Kod poprawny." };
              } else {
                  result = { status: "error", message: "Kod nieprawidłowy." };
              }
          }

          // 3. Rezerwacja (Z NOWYMI POLAMI)
          else if (data.name === "book_appointment") {
              if (!isVerified) {
                   result = { status: "error", message: "BLOKADA: Najpierw zweryfikuj kod SMS." };
              } else {
                   const args = JSON.parse(data.arguments);
                   
                   // Wywołanie API z poprawnymi danymi
                   result = await makeBooking(
                       callParams.assistantPhone, 
                       callParams.from,    // Numer telefonu klienta
                       args.client_name,   // Imię i Nazwisko (tytuł)
                       args.service_name,  // Usługa
                       args.datetime       // Data
                   );
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
