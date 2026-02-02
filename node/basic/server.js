const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;

function saveCallToDb(callSid, status, extraData = {}) {
  if (!callSid) return;
  const url = 'https://primarch.eu/update_stats.php'; 
  const payload = { call_sid: callSid, status: status, ...extraData };
  axios.post(url, payload).catch(err => { console.error("DB Error:", err.message); });
}

// Funkcja rezerwacji
async function makeBooking(assistantPhone, dateTime, note) {
    console.log(`[Booking] Request for assistant: ${assistantPhone}, time: ${dateTime}`);
    try {
        const response = await axios.post('https://primarch.eu/booking_api.php', {
            phone: assistantPhone, 
            datetime: dateTime,
            note: note
        });
        console.log("[Booking] Response:", response.data);
        return response.data;
    } catch (error) {
        console.error("[Booking] API Error:", error.message);
        return { status: "error", message: "Błąd połączenia z bazą danych." };
    }
}

// Funkcja wysyłki SMS (woła plik PHP)
async function sendSmsViaPhp(phoneNumber, message) {
    try {
        await axios.post('https://primarch.eu/send_sms.php', {
            phone: phoneNumber,
            message: message
        });
        return true;
    } catch (error) {
        console.error("[SMS] Error sending SMS:", error.message);
        return false;
    }
}

// Definicje narzędzi (Tools)
const toolsDefinition = [
  {
    type: "function",
    name: "book_appointment",
    description: "Finalizuje rezerwację PO pomyślnej weryfikacji kodu SMS.",
    parameters: {
      type: "object",
      properties: {
        datetime: { type: "string", description: "Data i godzina w ISO 8601 (np. 2024-05-20 14:00:00)." },
        note: { type: "string", description: "Imię klienta, nazwisko i usługa." }
      },
      required: ["datetime"]
    }
  },
  {
      type: "function",
      name: "send_verification_sms",
      description: "Wysyła kod weryfikacyjny SMS do klienta. Użyj tego, gdy uzgodnicie termin.",
      parameters: {
          type: "object",
          properties: {}, 
      }
  },
  {
      type: "function",
      name: "check_verification_code",
      description: "Sprawdza kod podany przez klienta.",
      parameters: {
          type: "object",
          properties: {
              code: { type: "string", description: "Kod podyktowany przez klienta." }
          },
          required: ["code"]
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
  
  // Zmienne sesji do obsługi SMS
  let verificationCode = null;
  let smsSentCount = 0;
  const SMS_LIMIT = 2;

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

    const greetingText = callParams.greeting || "Halo?";
    const initialGreeting = {
        type: "response.create",
        response: {
            modalities: ["text", "audio"],
            instructions: `Please say this exact phrase verbatim: "${greetingText}"`
        }
    };
    openaiWs.send(JSON.stringify(initialGreeting));
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
                assistantPhone: custom.assistantPhone || custom.toNumber, 
                allowBooking: custom.allowBooking,
                from: custom.fromNumber,
                to: custom.toNumber
            };
            currentCallSid = custom.callSid;
            
            console.log(`[Init] Call started. From: ${callParams.from}, To: ${callParams.to}`);
            
            if (openaiWs.readyState === WebSocket.OPEN) startSession();
            
            // Zapis do bazy z numerami telefonu
            saveCallToDb(currentCallSid, "started", { 
                from_number: callParams.from, 
                to_number: callParams.to,
                phone_number: callParams.from // Zapisz numer klienta w phone_number
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

      // Barge-in (przerywanie)
      if (data.type === "input_audio_buffer.speech_started") {
          console.log("[Interruption] User speaking.");
          if (streamSid) {
              twilioWs.send(JSON.stringify({ event: "clear", streamSid: streamSid }));
          }
          openaiWs.send(JSON.stringify({ type: "response.cancel" }));
          return;
      }

      if (data.type === "response.audio.delta" && streamSid) {
        twilioWs.send(JSON.stringify({ event: "media", streamSid: streamSid, media: { payload: data.delta } }));
      }

      // === OBSŁUGA NARZĘDZI (TOOLS) ===
      if (data.type === "response.function_call_arguments.done") {
          console.log("[Tool] Calling:", data.name);
          
          let result = { status: "error", message: "Unknown error" };

          // 1. Wysyłanie SMS (send_verification_sms)
          if (data.name === "send_verification_sms") {
              if (smsSentCount >= SMS_LIMIT) {
                  result = { status: "error", message: "Przekroczono limit SMS. Nie można wysłać kolejnego kodu." };
              } else {
                  // Generuj kod 4-cyfrowy
                  const code = Math.floor(1000 + Math.random() * 9000).toString();
                  verificationCode = code; // Zapisz w sesji
                  smsSentCount++;

                  const message = `Twój kod weryfikacyjny Primarch: ${code}`;
                  
                  console.log(`[SMS] Sending code ${code} to ${callParams.from}. Attempt: ${smsSentCount}`);
                  sendSmsViaPhp(callParams.from, message); // Wyślij bez czekania na await, by nie blokować

                  result = { status: "success", message: "Kod SMS został wysłany. Poproś klienta o podyktowanie kodu." };
              }
          }

          // 2. Sprawdzanie kodu (check_verification_code)
          else if (data.name === "check_verification_code") {
              const args = JSON.parse(data.arguments);
              const userCode = args.code ? args.code.replace(/[^0-9]/g, "") : "";

              console.log(`[Verify] User: ${userCode}, System: ${verificationCode}`);

              if (verificationCode && userCode === verificationCode) {
                  result = { status: "success", message: "Kod poprawny." };
              } else {
                  result = { status: "error", message: "Kod nieprawidłowy." };
              }
          }

          // 3. Rezerwacja (book_appointment)
          else if (data.name === "book_appointment") {
              const args = JSON.parse(data.arguments);
              // Podwójne zabezpieczenie - sprawdź czy kod był zweryfikowany (opcjonalnie)
              result = await makeBooking(callParams.assistantPhone, args.datetime, args.note);
          }

          // Wysyłanie wyniku do OpenAI
          const toolOutput = {
              type: "conversation.item.create",
              item: {
                  type: "function_call_output",
                  call_id: data.call_id, 
                  output: JSON.stringify(result) 
              }
          };
          openaiWs.send(JSON.stringify(toolOutput));
          openaiWs.send(JSON.stringify({type: "response.create"}));
      }

      // Transkrypcja
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
