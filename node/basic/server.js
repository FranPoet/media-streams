const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;
// Klucz OpenAI NIE jest w tym pliku (GitHub go unieważnia). Serwer bierze go z aintigo.pl.
const VOICE_KEY_URL = "https://aintigo.pl/voice_openai_key.php";
const VOICE_SECRET = "aintigo-voice-7f3c9a2e1b84d6c0";
let cachedOpenAIKey = "";

async function getOpenAIKey() {
  if (cachedOpenAIKey) return cachedOpenAIKey;
  const { data } = await axios.get(VOICE_KEY_URL, {
    headers: { "X-Aintigo-Voice": VOICE_SECRET },
    timeout: 15000,
  });
  if (!data || data.status !== "ok" || !data.api_key) {
    throw new Error(data?.message || "openai key refused");
  }
  cachedOpenAIKey = data.api_key;
  return cachedOpenAIKey;
}

// Realtime czyta cyfry po angielsku, jeśli zostaną w tekście. Wymuszamy polskie słowa.
const POLISH_NUMBERS =
  "WYMOWA LICZB: w głosie zero cyfr i zero angielskich liczebników. " +
  "Godziny, daty, ceny i liczby osób mów słowami po polsku " +
  "(14:30 = czternasta trzydzieści, 120 zł = sto dwadzieścia złotych, 4 osoby = cztery osoby). " +
  "Telefon i kod SMS: każda cyfra osobno — zero, jeden, dwa, trzy, cztery, pięć, sześć, siedem, osiem, dziewięć — grupy po trzy. ";

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
            employee_name: employeeName, // Nowe pole!
            note: `Usługa: ${serviceName}, Specjalista: ${employeeName || 'Dowolny'}`,
            datetime: dateTime
        });
        console.log("[Booking] Response:", response.data);
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

// === NARZĘDZIA RESTAURACJA (stoliki) — z weryfikacją SMS przed rezerwacją ===
const toolsRestaurant = [
  { type: "function", name: "send_verification_sms", description: "KROK 1. Wysyła kod weryfikacyjny SMS przed rezerwacją stolika.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "check_verification_code", description: "KROK 2. Sprawdza kod podany przez klienta.", parameters: { type: "object", properties: { code: { type: "string", description: "Kod od klienta." } }, required: ["code"] } },
  { type: "function", name: "book_restaurant_table", description: "FINALIZACJA. Rezerwacja stolika. Użyj PO weryfikacji kodu SMS. Parametry: table_number (z listy), date, time, client_name.", parameters: { type: "object", properties: { table_number: { type: "integer", description: "Numer stolika z listy (1 = pierwszy stolik)." }, date: { type: "string", description: "Data YYYY-MM-DD" }, time: { type: "string", description: "Godzina np. 18:00" }, client_name: { type: "string", description: "Imię i nazwisko klienta." } }, required: ["table_number", "date", "time", "client_name"] } }
];

// === NARZĘDZIA GLOBALNE (wizyty + stoliki + booking_phone) ===
const toolsGlobal = [
  { type: "function", name: "send_verification_sms", description: "Wysyła kod SMS. Użyj przed rezerwacją.", parameters: { type: "object", properties: {} } },
  { type: "function", name: "check_verification_code", description: "Sprawdza kod od klienta.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
  { type: "function", name: "book_appointment", description: "Rezerwacja wizyty w salonie. OBOWIĄZKOWO podaj booking_phone = numer rezerwacji wybranego salonu (z listy w kontekście).", parameters: { type: "object", properties: { booking_phone: { type: "string", description: "Numer rezerwacji salonu (z listy SALON... Numer rezerwacji: X)." }, datetime: { type: "string" }, client_name: { type: "string" }, service_name: { type: "string" }, employee_name: { type: "string" } }, required: ["booking_phone", "datetime", "client_name", "service_name", "employee_name"] } },
  { type: "function", name: "book_restaurant_table", description: "Rezerwacja stolika. OBOWIĄZKOWO podaj booking_phone = numer rezerwacji wybranej restauracji (z listy w kontekście).", parameters: { type: "object", properties: { booking_phone: { type: "string", description: "Numer rezerwacji restauracji (z listy RESTAURACJA... Numer rezerwacji: X)." }, table_number: { type: "integer" }, date: { type: "string" }, time: { type: "string" }, client_name: { type: "string" } }, required: ["booking_phone", "table_number", "date", "time", "client_name"] } }
];

async function bookRestaurantTable(assistantPhone, clientPhone, tableNumber, date, time, clientName) {
    try {
        const response = await axios.post("https://aintigo.pl/restaurant_booking_ai.php", {
            phone: assistantPhone,
            client_phone: clientPhone,
            client_name: clientName,
            table_number: tableNumber,
            date: date,
            time: time
        });
        return response.data;
    } catch (err) {
        console.error("[Restaurant Booking] Error:", err.message);
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
  let responseActive = false;
  let rodoLocked = true;
  let rodoAudioBytes = 0;
  let rodoAudioStartedAt = 0;
  let rodoRetries = 0;
  let rodoUnlockTimer = null;
  let verificationCode = null;
  let smsSentCount = 0;
  const SMS_LIMIT = 2;
  let isVerified = false; 

  let onOpenAIMessage = async () => {};
  const attachOpenAI = (key) => {
    openaiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      { headers: { Authorization: `Bearer ${key}` } }
    );
    openaiWs.on("error", (err) => console.error("[OpenAI]", err.message));
    openaiWs.on("open", () => {
      if (callParams) startSession();
    });
    openaiWs.on("message", (msg) => onOpenAIMessage(msg));
  };

  const startSession = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (!callParams) return;

    const voice = (callParams.voice || "alloy").trim() || "alloy";
    const sessionConfig = {
      type: "realtime",
      instructions: POLISH_NUMBERS + "\n\n" + (callParams.prompt || ""),
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: { model: "whisper-1", language: "pl" },
          turn_detection: null,
        },
        output: {
          format: { type: "audio/pcmu" },
          voice,
        },
      },
    };

    if (callParams.allowBooking == '1') {
        if (callParams.isGlobal === '1') {
            sessionConfig.tools = toolsGlobal;
        } else {
            sessionConfig.tools = (callParams.bookingType === 'restaurant') ? toolsRestaurant : toolsCalendar;
        }
        sessionConfig.tool_choice = "auto";
    }

    openaiWs.send(JSON.stringify({ type: "session.update", session: sessionConfig }));
    sendRodoGreeting();
  };

  const sendRodoGreeting = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || !callParams) return;
    const greetingText = String(callParams.greeting || "Dzień dobry.").replace(/[`$]/g, "");
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: `Powiedz w całości, jednym ciągiem, bez skracania i bez reagowania na głos klienta: „${greetingText}” Nic nie pomijaj.`,
      },
    }));
  };

  const unlockRodo = () => {
    if (!rodoLocked) return;
    rodoLocked = false;
    if (rodoUnlockTimer) {
      clearTimeout(rodoUnlockTimer);
      rodoUnlockTimer = null;
    }
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              interrupt_response: true,
            },
          },
        },
      },
    }));
    console.log("[RODO] odblokowano przerywanie");
  };

  const finishRodoAfterPlayback = () => {
    const elapsed = rodoAudioStartedAt ? Date.now() - rodoAudioStartedAt : 0;
    const durationMs = Math.ceil((rodoAudioBytes / 8000) * 1000);
    const waitMs = Math.max(800, durationMs - elapsed + 700);
    if (rodoUnlockTimer) clearTimeout(rodoUnlockTimer);
    rodoUnlockTimer = setTimeout(unlockRodo, waitMs);
    console.log("[RODO] koniec generowania, czekam na dogranie", waitMs, "ms");
  };

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
            if (openaiWs?.readyState === WebSocket.OPEN) startSession();
            
            saveCallToDb(currentCallSid, "started", { 
                from_number: callParams.from, 
                to_number: callParams.to,
                phone_number: callParams.from 
            });
          }
          break;
        case "media":
          if (rodoLocked) break;
          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
          }
          break;
        case "stop":
          saveCallToDb(currentCallSid, "completed");
          if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
          break;
      }
    } catch (e) { }
  });

  onOpenAIMessage = async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === "response.created") responseActive = true;
      if (data.type === "response.done" || data.type === "response.cancelled") {
          responseActive = false;
          if (rodoLocked) {
            const tooShort = rodoAudioBytes < 8000;
            if ((data.type === "response.cancelled" || tooShort) && rodoRetries < 2) {
              rodoRetries += 1;
              rodoAudioBytes = 0;
              rodoAudioStartedAt = 0;
              sendRodoGreeting();
            } else if (data.type === "response.done") {
              finishRodoAfterPlayback();
            }
          }
      }

      if (data.type === "input_audio_buffer.speech_started" && !rodoLocked) {
          if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid: streamSid }));
          if (responseActive && openaiWs?.readyState === WebSocket.OPEN) {
            responseActive = false;
            openaiWs.send(JSON.stringify({ type: "response.cancel" }));
          }
      }

      if (data.type === "error" && data.error?.code !== "response_cancel_not_active") {
        console.error("[OpenAI error]", JSON.stringify(data.error || data));
      }

      if ((data.type === "response.output_audio.delta" || data.type === "response.audio.delta") && streamSid) {
        if (rodoLocked && data.delta) {
          if (!rodoAudioStartedAt) rodoAudioStartedAt = Date.now();
          rodoAudioBytes += Buffer.from(data.delta, "base64").length;
        }
        twilioWs.send(JSON.stringify({ event: "media", streamSid: streamSid, media: { payload: data.delta } }));
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
                  const message = `Twój kod: ${code}`;
                  sendSmsViaPhp(callParams.from, message);
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
                       phoneForBooking,
                       callParams.from,
                       args.client_name,
                       args.service_name,
                       args.employee_name,
                       args.datetime
                   );
                   if (result.status === "success" && result.payment_url) {
                       const smsPayment = "Dziekujemy za rezerwacje. Link do platnosci (przedplata): " + result.payment_url + " Po oplaceniu rezerwacja bedzie aktywna.";
                       sendSmsViaPhp(callParams.from, smsPayment);
                       result.message = "Rezerwacja zapisana. Wyslano link do platnosci SMS. Po oplaceniu rezerwacja bedzie aktywna.";
                   }
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
      if (data.type === "response.output_audio_transcript.done" || data.type === "response.audio_transcript.done") {
        const text = data.transcript.trim();
        if(text) saveCallToDb(currentCallSid, "transcript", { text: "AI: " + text });
      }

    } catch (e) { }
  };

  getOpenAIKey()
    .then(attachOpenAI)
    .catch((err) => console.error("[OpenAI] key", err.message));

  twilioWs.on("close", () => {
    if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

server.listen(PORT, () => console.log(`Listening on ${PORT}`));
