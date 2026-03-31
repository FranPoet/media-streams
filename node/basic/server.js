const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;

// === ELEVENLABS CREDENTIALS ===
const ELEVENLABS_API_KEY = "sk_499fda9e2d79d9ceba6357d176f52612252cc965bc4473d9";
const ELEVENLABS_VOICE_ID = "EmspiS7CSUabPeqBcrAP";

function saveCallToDb(callSid, status, extraData = {}) {
  if (!callSid) return;
  const url = 'https://aintigo.pl/update_stats.php'; 
  const payload = { call_sid: callSid, status: status, ...extraData };
  axios.post(url, payload).catch(err => {});
}

// === FUNKCJA REZERWACJI ===
async function makeBooking(assistantPhone, clientPhone, clientName, serviceName, employeeName, dateTime) {
    console.log(`[Booking] ${clientName} do ${employeeName || 'Kogokolwiek'} na ${serviceName} @ ${dateTime}`);
    try {
        const response = await axios.post('https://aintigo.pl/booking_api.php', {
            phone: assistantPhone,         
            client_phone: clientPhone,      
            title: clientName,              
            service_name: serviceName,      
            employee_name: employeeName, 
            note: `Usługa: ${serviceName}, Specjalista: ${employeeName || 'Dowolny'}`,
            datetime: dateTime
        });
        return response.data;
    } catch (error) {
        console.error("[Booking] API Error:", error.message);
        return { status: "error", message: "Błąd bazy danych." };
    }
}

// === WYSYŁKA SMS ===
async function sendSmsViaPhp(phoneNumber, message) {
    try {
        await axios.post('https://aintigo.pl/send_sms.php', {
            phone: phoneNumber,
            message: message
        });
        return true;
    } catch (error) {
        console.error("SMS Error:", error.message);
        return false;
    }
}

// === NARZĘDZIA KALENDARZ (wizyty) ===
const toolsCalendar = [
  { type: "function", name: "send_verification_sms", description: "KROK 1. Wysyła kod SMS.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "check_verification_code", description: "KROK 2. Sprawdza kod.", parameters: { type: "object", properties: { code: { type: "string", description: "Kod od klienta." } }, required: ["code"] } },
  { type: "function", name: "book_appointment", description: "FINALIZACJA. Zapisuje wizytę. Użyj PO weryfikacji SMS.", parameters: { type: "object", properties: { datetime: { type: "string", description: "ISO: YYYY-MM-DD HH:mm:ss" }, client_name: { type: "string" }, service_name: { type: "string" }, employee_name: { type: "string", description: "Imię specjalisty lub 'anyone'." } }, required: ["datetime", "client_name", "service_name", "employee_name"] } }
];

// === NARZĘDZIA RESTAURACJA (stoliki) ===
const toolsRestaurant = [
  { type: "function", name: "send_verification_sms", description: "KROK 1. Wysyła kod weryfikacyjny SMS przed rezerwacją stolika.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "check_verification_code", description: "KROK 2. Sprawdza kod podany przez klienta.", parameters: { type: "object", properties: { code: { type: "string", description: "Kod od klienta." } }, required: ["code"] } },
  { type: "function", name: "book_restaurant_table", description: "FINALIZACJA. Rezerwacja stolika. Użyj PO weryfikacji kodu SMS.", parameters: { type: "object", properties: { table_number: { type: "integer", description: "Numer stolika z listy." }, date: { type: "string", description: "Data YYYY-MM-DD" }, time: { type: "string", description: "Godzina np. 18:00" }, client_name: { type: "string" } }, required: ["table_number", "date", "time", "client_name"] } }
];

// === NARZĘDZIA GLOBALNE ===
const toolsGlobal = [
  { type: "function", name: "send_verification_sms", description: "Wysyła kod SMS. Użyj przed rezerwacją.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "check_verification_code", description: "Sprawdza kod od klienta.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
  { type: "function", name: "book_appointment", description: "Rezerwacja wizyty w salonie.", parameters: { type: "object", properties: { booking_phone: { type: "string" }, datetime: { type: "string" }, client_name: { type: "string" }, service_name: { type: "string" }, employee_name: { type: "string" } }, required: ["booking_phone", "datetime", "client_name", "service_name", "employee_name"] } },
  { type: "function", name: "book_restaurant_table", description: "Rezerwacja stolika.", parameters: { type: "object", properties: { booking_phone: { type: "string" }, table_number: { type: "integer" }, date: { type: "string" }, time: { type: "string" }, client_name: { type: "string" } }, required: ["booking_phone", "table_number", "date", "time", "client_name"] } }
];

async function bookRestaurantTable(assistantPhone, clientPhone, tableNumber, date, time, clientName) {
    try {
        const response = await axios.post("https://aintigo.pl/restaurant_booking_ai.php", {
            phone: assistantPhone, client_phone: clientPhone, client_name: clientName,
            table_number: tableNumber, date: date, time: time
        });
        return response.data;
    } catch (err) {
        return { status: "error", message: "Błąd rezerwacji stolika." };
    }
}

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
  let elevenLabsWs = null; 
  let verificationCode = null;
  let smsSentCount = 0;
  const SMS_LIMIT = 2;
  let isVerified = false; 

  let botSpeechStartTime = 0;
  let isBotSpeaking = false;

  // === FUNKCJA ŁĄCZĄCA Z ELEVENLABS ===
  const setupElevenLabs = (initialText = " ") => {
      if (elevenLabsWs) elevenLabsWs.close(); 
      
     const url = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=eleven_multilingual_v2&output_format=ulaw_8000`;
      
      elevenLabsWs = new WebSocket(url, {
          headers: { "xi-api-key": ELEVENLABS_API_KEY }
      });

      elevenLabsWs.on("open", () => {
          // Natychmiastowe wysłanie tekstu powitalnego do ElevenLabs
          elevenLabsWs.send(JSON.stringify({
              text: initialText,
              voice_settings: { stability: 0.5, similarity_boost: 0.8 }
          }));
          
          if (initialText.trim() !== "") {
              elevenLabsWs.send(JSON.stringify({ text: "", flush: true }));
          }
      });

      elevenLabsWs.on("message", (data) => {
          try {
              const msg = JSON.parse(data);
              if (msg.audio && streamSid) {
                  twilioWs.send(JSON.stringify({
                      event: "media",
                      streamSid: streamSid,
                      media: { payload: msg.audio }
                  }));
              }
          } catch (e) {}
      });

      elevenLabsWs.on("error", (err) => console.error("[ElevenLabs] Error:", err.message));
  };

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
      modalities: ["text"], // Tylko tekst od OpenAI
      instructions: callParams.prompt,
      input_audio_format: "g711_ulaw",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: { type: "server_vad", threshold: 0.8, prefix_padding_ms: 300, silence_duration_ms: 700 }
    };

    if (callParams.allowBooking == '1') {
        if (callParams.isGlobal === '1') {
            sessionConfig.tools = toolsGlobal;
        } else {
            sessionConfig.tools = (callParams.bookingType === 'restaurant') ? toolsRestaurant : toolsCalendar;
        }
        sessionConfig.tool_choice = "auto";
    }

    // Wysyłamy konfigurację do OpenAI
    openaiWs.send(JSON.stringify({ type: "session.update", session: sessionConfig }));

    // Dodajemy do historii rozmowy powitanie, które ElevenLabs już wypowiedziało
    const greetingText = callParams.greeting || "Dzień dobry.";
    const fakeAssistantMessage = {
        type: "conversation.item.create",
        item: {
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: greetingText }]
        }
    };
    openaiWs.send(JSON.stringify(fakeAssistantMessage));
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
                bookingType: custom.bookingType || "calendar",
                isGlobal: custom.isGlobal || "0",
                from: custom.fromNumber,
                to: custom.toNumber
            };
            currentCallSid = custom.callSid;

            // Uruchamiamy ElevenLabs od razu z tekstem powitalnym!
            const greetingToSay = callParams.greeting || "Dzień dobry.";
            setupElevenLabs(greetingToSay + " "); 

            if (openaiWs.readyState === WebSocket.OPEN) startSession();
            
            saveCallToDb(currentCallSid, "started", { 
                from_number: callParams.from, 
                to_number: callParams.to,
                phone_number: callParams.from 
            });
          } else {
             setupElevenLabs(" "); 
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
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
          break;
      }
    } catch (e) { }
  });

  openaiWs.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === "response.created") {
          isBotSpeaking = true;
          botSpeechStartTime = Date.now();
      }
      
      // === WYSYŁANIE TEKSTU Z OPENAI DO ELEVENLABS ===
      if (data.type === "response.text.delta") {
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
              elevenLabsWs.send(JSON.stringify({ text: data.delta }));
          }
      }

      if (data.type === "response.done" || data.type === "response.cancel") {
          isBotSpeaking = false;
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
              elevenLabsWs.send(JSON.stringify({ text: "", flush: true }));
          }
      }

      if (data.type === "input_audio_buffer.speech_started") {
          const speakDuration = Date.now() - botSpeechStartTime;
          
          if (!isBotSpeaking || speakDuration > 5000) {
              console.log(`[Interruption] Przerwano bota. Czas mówienia: ${speakDuration}ms`);
              if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid: streamSid }));
              openaiWs.send(JSON.stringify({ type: "response.cancel" }));
              
              setupElevenLabs(" "); // Resetujemy ElevenLabs, by uciszyć bota
          } else {
              console.log(`[Interruption] Zignorowano. Bot mówi za krótko: ${speakDuration}ms`);
          }
      }

      if (data.type === "response.function_call_arguments.done") {
          console.log("[Tool] Executing:", data.name);
          let result = { status: "error", message: "Unknown error" };

          if (data.name === "send_verification_sms") {
              if (smsSentCount >= SMS_LIMIT) {
                  result = { status: "error", message: "Limit SMS wyczerpany." };
              } else {
                  const code = Math.floor(1000 + Math.random() * 9000).toString();
                  verificationCode = code; 
                  smsSentCount++;
                  sendSmsViaPhp(callParams.from, `Twój kod: ${code}`);
                  result = { status: "success", message: "Kod SMS wysłany." };
              }
          }

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

          else if (data.name === "book_restaurant_table") {
              if (!isVerified) {
                  result = { status: "error", message: "BLOKADA: Najpierw wyślij kod SMS (send_verification_sms), poczekaj na kod od klienta i zweryfikuj (check_verification_code)." };
              } else {
                  const args = JSON.parse(data.arguments);
                  const phoneForBooking = (args.booking_phone && String(args.booking_phone).trim()) ? String(args.booking_phone).trim() : callParams.assistantPhone;
                  const tableNum = parseInt(args.table_number, 10) || 1;
                  const dateStr = (args.date || "").trim();
                  const timeStr = (args.time || "").trim().replace(/\s*$/, "").match(/^\d{1,2}:\d{2}/) ? args.time.trim() : (args.time || "12:00");
                  result = await bookRestaurantTable(phoneForBooking, callParams.from, tableNum, dateStr, timeStr, (args.client_name || "").trim());
              }
          }
          else if (data.name === "book_appointment") {
              if (!isVerified) {
                   result = { status: "error", message: "BLOKADA: Zweryfikuj najpierw kod SMS." };
              } else {
                   const args = JSON.parse(data.arguments);
                   const phoneForBooking = (args.booking_phone && String(args.booking_phone).trim()) ? String(args.booking_phone).trim() : callParams.assistantPhone;
                   result = await makeBooking(
                       phoneForBooking, callParams.from, args.client_name, args.service_name, args.employee_name, args.datetime
                   );
                   if (result.status === "success" && result.payment_url) {
                       sendSmsViaPhp(callParams.from, `Dziekujemy za rezerwacje. Link do platnosci: ${result.payment_url}`);
                       result.message = "Rezerwacja zapisana. Wyslano link do platnosci SMS. Po oplaceniu rezerwacja bedzie aktywna.";
                   }
              }
          }

          const toolOutput = {
              type: "conversation.item.create",
              item: { type: "function_call_output", call_id: data.call_id, output: JSON.stringify(result) }
          };
          openaiWs.send(JSON.stringify(toolOutput));
          openaiWs.send(JSON.stringify({type: "response.create", response: { modalities: ["text"] }}));
      }

      if (data.type === "conversation.item.input_audio_transcription.completed") {
        const text = data.transcript.trim();
        if(text) saveCallToDb(currentCallSid, "transcript", { text: "User: " + text });
      }
      
      if (data.type === "response.text.done") {
        const text = data.text ? data.text.trim() : "";
        if(text) saveCallToDb(currentCallSid, "transcript", { text: "AI: " + text });
      }

    } catch (e) { }
  });

  twilioWs.on("close", () => {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
  });
});

server.listen(PORT, () => console.log(`Listening on ${PORT}`));
