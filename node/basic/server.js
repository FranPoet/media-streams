/**

 * BookForDay — Twilio Media Streams → OpenAI Realtime (μ-law) → Twilio

 */

const http = require("http");

const crypto = require("crypto");

const WebSocket = require("ws");

const axios = require("axios");



const PORT = process.env.PORT || 3000;

// Jak public_html/inc/secrets.php — stałe w pliku (Render: tylko wgraj server.js).
const API_BASE = "https://bookforday.com/api/voice".replace(/\/$/, "");
const API_SECRET = "519eded4befccd3e1906cc804c5652beef73c09f52d005a2";

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

const USE_ELEVENLABS = process.env.USE_ELEVENLABS === "1";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";

const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "EmspiS7CSUabPeqBcrAP";

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";

const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";



const POLISH_RULES =

  "KRYTYCZNE: Mów WYŁĄCZNIE po polsku. Zakaz języka angielskiego (nie mów: hello, goodbye, bye). " +

  "Pożegnanie tylko po polsku: „Do widzenia” lub „Dziękuję, do usłyszenia”.";



function signBody(body) {
  return crypto.createHmac("sha256", API_SECRET).update(body).digest("hex");
}

/** voice_key w URL — działa gdy hosting ucina nagłówki Authorization od Render. */
function voiceApiUrl(path) {
  const file = String(path || "").replace(/^\//, "");
  const sep = file.includes("?") ? "&" : "?";
  return `${API_BASE}/${file}${sep}voice_key=${encodeURIComponent(API_SECRET)}`;
}

function apiHeaders(body) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    Authorization: `Bearer ${API_SECRET}`,
    "X-BookFor-Voice-Key": API_SECRET,
    "X-BookFor-Signature": signBody(body),
  };
}

function logApi403(label, err) {

  const code = err?.response?.status;

  if (code === 403) {
    const msg = err?.response?.data ? JSON.stringify(err.response.data) : "";
    console.error(
      `[BookForDay] ${label}: 403 — wgraj voice-api.php; secrets.php voice_api_secret = server.js (len ${API_SECRET.length}). ${msg}`
    );
  }

}

async function verifyApiAuth() {

  const base = API_BASE.replace(/\/$/, "");

  if (!base) return;

  const body = JSON.stringify({ ping: true });

  try {

    await axios.post(voiceApiUrl("ping.php"), body, { headers: apiHeaders(body), timeout: 15000 });

    console.log("[BookForDay] API auth OK →", base);

  } catch (err) {

    logApi403("API auth check", err);

    console.error("[BookForDay] API auth check failed:", err.message);

  }

}



async function fetchSessionConfig(params) {

  const base = (params.apiBase || API_BASE).replace(/\/$/, "");

  if (!base) {

    return { prompt: "", greeting: params.greeting || "" };

  }

  const body = JSON.stringify({

    job_id: params.jobId || "",

    mode: params.callMode || "intake",

    call_sid: params.callSid || "",

  });

  try {

    const { data } = await axios.post(voiceApiUrl("session_config.php"), body, {

      headers: apiHeaders(body),

      timeout: 15000,

    });

    if (data.status === "ok") {

      return { prompt: data.prompt || "", greeting: data.greeting || params.greeting };

    }

  } catch (err) {

    logApi403("session_config", err);

    console.error("[BookForDay] session_config:", err.message);

  }

  return {

    prompt: "",

    greeting:

      params.greeting ||

      "Dzień dobry, tu asystent BookForDay. Jakiej usługi szukasz, w jakim mieście i na kiedy?",

  };

}



async function fetchOpenAICredential(apiBase) {

  const base = (apiBase || API_BASE).replace(/\/$/, "");

  const body = JSON.stringify({ model: REALTIME_MODEL });

  const { data } = await axios.post(voiceApiUrl("realtime_credential.php"), body, {

    headers: apiHeaders(body),

    timeout: 20000,

  });

  if (data.status === "ok" && data.api_key) {

    return { model: data.model || REALTIME_MODEL, api_key: data.api_key };

  }

  throw new Error(data.message || "realtime_credential failed");

}



async function getOpenAICredential(apiBase) {
  try {
    return await fetchOpenAICredential(apiBase);
  } catch (err) {
    if (OPENAI_API_KEY) {
      return { model: REALTIME_MODEL, api_key: OPENAI_API_KEY };
    }
    throw err;
  }
}



async function apiPost(path, payload, apiBaseOverride) {

  const base = (apiBaseOverride || API_BASE || "").replace(/\/$/, "");

  if (!base) {

    return { status: "error", message: "API base not configured" };

  }

  const body = JSON.stringify(payload);

  try {

    const { data } = await axios.post(voiceApiUrl(path), body, {

      headers: apiHeaders(body),

      timeout: 20000,

    });

    return data;

  } catch (err) {

    logApi403(path, err);

    console.error("[BookForDay API]", path, err.message);

    return { status: "error", message: err.message };

  }

}



const toolsIntake = [

  {

    type: "function",

    name: "complete_intake",

    description:

      "Wywołaj DOPIERO gdy masz od klienta: usługę, miasto oraz termin/kiedy. Wtedy wyszukamy firmy i wyślemy SMS.",

    parameters: {

      type: "object",

      properties: {

        category: { type: "string", description: "fryzjer, barber, kosmetyka, paznokcie, massage, groomer, inne" },

        city: { type: "string" },

        district: { type: "string" },

        service_needed: { type: "string" },

        datetime: { type: "string", description: "Kiedy klient chce wizytę" },

        needs_today: { type: "boolean" },

        details: { type: "string" },

        original_request: { type: "string" },

      },

      required: ["category", "city", "service_needed", "needs_today"],

    },

  },

];



function intakeArgsValid(args) {

  const city = String(args.city || "").trim();

  const service = String(args.service_needed || "").trim();

  return city.length >= 2 && service.length >= 2;

}



const server = http.createServer((req, res) => {

  if (req.url === "/health") {

    res.writeHead(200, { "Content-Type": "application/json" });

    res.end(JSON.stringify({ ok: true, service: "bookforday-voice", v: 3 }));

    return;

  }

  if (req.url === "/voice") {

    res.writeHead(200, { "Content-Type": "text/xml" });

    res.end(`<Response><Connect><Stream url="wss://${req.headers.host}/media" /></Connect></Response>`);

    return;

  }

  res.writeHead(200).end("BookForDay voice ready");

});



const wss = new WebSocket.Server({ server, path: "/media" });



wss.on("connection", (twilioWs) => {

  let streamSid = null;

  let callParams = null;

  let openaiWs = null;

  let elevenLabsWs = null;

  let pendingHangup = false;

  let hangupScheduled = false;

  let intakeCompleted = false;

  let configLoaded = false;

  let openaiConnected = false;

  let sessionConfigured = false;

  let firstResponseSent = false;

  let vadAutoResponse = false;

  const handledFunctionCalls = new Set();



  const sendTwilioAudio = (base64Pcmu) => {

    if (!streamSid || !base64Pcmu) return;

    twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Pcmu } }));

  };



  const turnDetection = (createResponse) => ({

    type: "server_vad",

    threshold: 0.82,

    prefix_padding_ms: 350,

    silence_duration_ms: 900,

    create_response: createResponse,

    interrupt_response: true,

  });



  const buildSessionPayload = (instructions, createResponse) => {

    const session = {

      type: "realtime",

      model: REALTIME_MODEL,

      instructions: POLISH_RULES + "\n\n" + instructions,

      tools: toolsIntake,

      tool_choice: "auto",

    };

    if (USE_ELEVENLABS) {

      session.output_modalities = ["text"];

      session.audio = {

        input: {

          format: { type: "audio/pcmu" },

          transcription: { model: "whisper-1", language: "pl" },

          turn_detection: turnDetection(createResponse),

        },

      };

    } else {

      session.output_modalities = ["audio"];

      session.audio = {

        input: {

          format: { type: "audio/pcmu" },

          transcription: { model: "whisper-1", language: "pl" },

          turn_detection: turnDetection(createResponse),

        },

        output: {

          format: { type: "audio/pcmu" },

          voice: REALTIME_VOICE,

        },

      };

    }

    return session;

  };



  const enableVadResponses = () => {

    if (vadAutoResponse || !openaiWs || openaiWs.readyState !== WebSocket.OPEN || !callParams) return;

    vadAutoResponse = true;

    let instructions = (callParams.prompt || "").trim();

    if (instructions.length < 80) {

      instructions =

        "Jesteś asystentem BookForDay. Zbierz usługę, miasto i termin. Potem complete_intake. Mów tylko po polsku.";

    }

    openaiWs.send(

      JSON.stringify({

        type: "session.update",

        session: buildSessionPayload(instructions, true),

      })

    );

  };



  const tryStartSession = () => {

    if (!configLoaded || !openaiConnected || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

    if (sessionConfigured || !callParams) return;

    let instructions = (callParams.prompt || "").trim();

    if (instructions.length < 80) {

      instructions =

        "Jesteś asystentem BookForDay. Zbierz usługę, miasto i termin. Potem complete_intake. Mów tylko po polsku.";

    }

    sessionConfigured = true;

    openaiWs.send(

      JSON.stringify({

        type: "session.update",

        session: buildSessionPayload(instructions, false),

      })

    );

  };



  const triggerFirstResponse = () => {

    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || firstResponseSent) return;

    firstResponseSent = true;

    const greeting =

      (callParams?.greeting || "").trim() ||

      "Dzień dobry, tu asystent BookForDay. Jakiej usługi szukasz, w jakim mieście i na kiedy?";

    openaiWs.send(

      JSON.stringify({

        type: "response.create",

        response: {

          output_modalities: USE_ELEVENLABS ? ["text"] : ["audio"],

          instructions:

            `${POLISH_RULES} To pierwsze zdanie rozmowy. Powiedz po polsku (naturalnie, ok. 2 zdania): "${greeting}" ` +

            "Nie kończ rozmowy. Nie wywołuj complete_intake. Czekaj na odpowiedź klienta.",

        },

      })

    );

  };



  const connectOpenAI = async (apiBase) => {

    const credential = await getOpenAICredential(apiBase);

    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(credential.model)}`, {

      headers: { Authorization: `Bearer ${credential.api_key}` },

    });

    openaiWs = ws;

    ws.on("open", () => {

      openaiConnected = true;

      tryStartSession();

    });

    ws.on("message", onOpenAIMessage);

    ws.on("error", (err) => console.error("[OpenAI WS]", err.message));

  };



  let isBotSpeaking = false;

  let botSpeechStartTime = 0;



  const handleFunctionCall = async (name, argsJson, callId) => {

    if (!callId || handledFunctionCalls.has(callId)) return;

    handledFunctionCalls.add(callId);

    let args = {};

    try {

      args = argsJson ? JSON.parse(argsJson) : {};

    } catch (e) {

      console.error("[OpenAI] bad function args", e.message);

    }



    let result = { status: "ok" };

    if (name === "complete_intake") {

      if (!intakeArgsValid(args)) {

        result = {

          status: "error",

          message: "Brak miasta lub usługi. Dopytaj klienta po polsku — nie kończ rozmowy.",

        };

      } else {

        result = await apiPost(

          "webhook.php",

          {

            action: "complete_intake",

            call_sid: callParams?.callSid,

            intake: { ...args, client_phone: callParams?.from },

          },

          callParams?.apiBase

        );

        console.log("[BookForDay] complete_intake", result);

        if (result.status === "ok") {

          intakeCompleted = true;

        }

      }

    }



    openaiWs.send(

      JSON.stringify({

        type: "conversation.item.create",

        item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },

      })

    );

    openaiWs.send(

      JSON.stringify({

        type: "response.create",

        response: {

          output_modalities: USE_ELEVENLABS ? ["text"] : ["audio"],

          instructions: intakeCompleted

            ? `${POLISH_RULES} Potwierdź po polsku, że szukasz firm w bazie i wyślesz SMS z numerami w ciągu ok. 10 minut. ` +

              "Powiedz „Do widzenia” i nic więcej. Nie wywołuj już funkcji."

            : `${POLISH_RULES} Kontynuuj rozmowę po polsku i dopytaj o brakujące informacje.`,

        },

      })

    );

  };



  const responseHasFunctionCall = (response) => {

    if (!response || !Array.isArray(response.output)) return false;

    return response.output.some((item) => item.type === "function_call");

  };



  const onOpenAIMessage = async (msg) => {

    try {

      const data = JSON.parse(msg);



      if (data.type === "error") {

        console.error("[OpenAI error]", data.error?.message || JSON.stringify(data));

        return;

      }



      if (data.type === "session.updated") {

        if (!firstResponseSent) triggerFirstResponse();

        return;

      }



      if (data.type === "response.created") {

        isBotSpeaking = true;

        botSpeechStartTime = Date.now();

      }



      if (data.type === "response.output_audio.delta" && data.delta) {

        sendTwilioAudio(data.delta);

      }



      const textDelta = data.type === "response.output_text.delta" || data.type === "response.text.delta";

      if (textDelta && data.delta && USE_ELEVENLABS && elevenLabsWs?.readyState === WebSocket.OPEN) {

        elevenLabsWs.send(JSON.stringify({ text: data.delta }));

      }



      if (data.type === "response.done" || data.type === "response.completed" || data.type === "response.cancelled") {

        isBotSpeaking = false;



        if (data.type === "response.done" && Array.isArray(data.response?.output)) {

          for (const item of data.response.output) {

            if (item.type === "function_call" && item.call_id) {

              await handleFunctionCall(item.name, item.arguments, item.call_id);

            }

          }

        }



        if (firstResponseSent && !vadAutoResponse && !intakeCompleted) {

          enableVadResponses();

        }



        if (intakeCompleted && data.type === "response.done" && !responseHasFunctionCall(data.response)) {

          pendingHangup = true;

        }



        if (pendingHangup && !hangupScheduled) {

          hangupScheduled = true;

          setTimeout(() => {

            if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));

            setTimeout(() => twilioWs.close(), 2500);

          }, 3500);

        }

      }



      if (data.type === "input_audio_buffer.speech_started") {

        const speakDuration = Date.now() - botSpeechStartTime;

        if (isBotSpeaking && speakDuration < 2500) {

          return;

        }

        if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));

        if (openaiWs?.readyState === WebSocket.OPEN) {

          openaiWs.send(JSON.stringify({ type: "response.cancel" }));

        }

      }

    } catch (e) {

      console.error("[OpenAI handler]", e.message);

    }

  };



  twilioWs.on("message", (msg) => {

    try {

      const data = JSON.parse(msg);

      switch (data.event) {

        case "start": {

          streamSid = data.start.streamSid;

          const custom = data.start.customParameters || {};

          configLoaded = false;

          openaiConnected = false;

          sessionConfigured = false;

          firstResponseSent = false;

          vadAutoResponse = false;

          intakeCompleted = false;

          pendingHangup = false;

          hangupScheduled = false;

          handledFunctionCalls.clear();



          callParams = {

            prompt: "",

            greeting: custom.greeting || "",

            callSid: custom.callSid || data.start.callSid,

            callMode: custom.callMode || "intake",

            from: custom.fromNumber,

            to: custom.toNumber,

            apiBase: API_BASE,

          };

          if (custom.apiBase && String(custom.apiBase).replace(/\/$/, "") !== API_BASE) {
            console.warn("[BookForDay] Ignoring Twilio apiBase:", custom.apiBase);
          }

          console.log("[BookForDay] call start", callParams.callSid, "→", API_BASE);



          connectOpenAI(callParams.apiBase).catch((e) => {

            logApi403("realtime_credential", e);

            console.error("[BookForDay] OpenAI connect failed", e.message);

          });



          (async () => {

            const loaded = await fetchSessionConfig(callParams);

            callParams.prompt = loaded.prompt;

            if (loaded.greeting) callParams.greeting = loaded.greeting;

            configLoaded = true;

            tryStartSession();

          })().catch((e) => console.error("[BookForDay] config failed", e.message));



          void apiPost(

            "webhook.php",

            {

              action: "start_intake",

              call_sid: callParams.callSid,

              client_phone: callParams.from,

            },

            callParams.apiBase

          );

          break;

        }

        case "media":

          if (openaiWs?.readyState === WebSocket.OPEN) {

            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));

          }

          break;

        case "stop":

          void apiPost("webhook.php", { action: "call_completed", call_sid: callParams?.callSid }, callParams?.apiBase);

          if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();

          if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();

          break;

      }

    } catch (e) {

      console.error("[Twilio]", e.message);

    }

  });



  twilioWs.on("close", () => {

    if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();

    if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();

  });

});



server.listen(PORT, () => {

  console.log(`[BookForDay voice] v5 on ${PORT} → ${API_BASE} (secret len ${API_SECRET.length})`);

  void verifyApiAuth();

});


