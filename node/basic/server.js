/**

 * BookForDay — voice server for Render.com

 * Twilio Media Streams → OpenAI Realtime (μ-law audio) → Twilio

 * Optional: ELEVENLABS via USE_ELEVENLABS=1 (text modality + TTS)

 */

const http = require("http");

const crypto = require("crypto");

const WebSocket = require("ws");

const axios = require("axios");



const PORT = process.env.PORT || 3000;

const API_BASE = (process.env.BOOKFOR_API_BASE || process.env.STENOR_API_BASE || "").replace(/\/$/, "");

const API_SECRET = process.env.BOOKFOR_API_SECRET || process.env.STENOR_API_SECRET || "";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const USE_ELEVENLABS = process.env.USE_ELEVENLABS === "1";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";

const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "EmspiS7CSUabPeqBcrAP";

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";

const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";



function signBody(body) {

  return crypto.createHmac("sha256", API_SECRET).update(body).digest("hex");

}



function apiHeaders(body) {

  const headers = { "Content-Type": "application/json" };

  if (API_SECRET.length >= 16) {

    headers["X-BookFor-Signature"] = signBody(body);

  }

  return headers;

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

    const { data } = await axios.post(`${base}/session_config.php`, body, {

      headers: apiHeaders(body),

      timeout: 15000,

    });

    if (data.status === "ok") {

      return { prompt: data.prompt || "", greeting: data.greeting || params.greeting };

    }

  } catch (err) {

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

  const { data } = await axios.post(`${base}/realtime_credential.php`, body, {

    headers: apiHeaders(body),

    timeout: 20000,

  });

  if (data.status === "ok" && data.api_key) {

    return { model: data.model || REALTIME_MODEL, api_key: data.api_key };

  }

  throw new Error(data.message || "realtime_credential failed");

}



async function getOpenAICredential(apiBase) {

  if (OPENAI_API_KEY) {

    return { model: REALTIME_MODEL, api_key: OPENAI_API_KEY };

  }

  return fetchOpenAICredential(apiBase);

}



async function apiPost(path, payload, apiBaseOverride) {

  const base = (apiBaseOverride || API_BASE || "").replace(/\/$/, "");

  if (!base) {

    return { status: "error", message: "API base not configured" };

  }

  const body = JSON.stringify(payload);

  try {

    const { data } = await axios.post(`${base}/${path}`, body, {

      headers: apiHeaders(body),

      timeout: 20000,

    });

    return data;

  } catch (err) {

    console.error("[BookForDay API]", path, err.message);

    return { status: "error", message: err.message };

  }

}



const toolsIntake = [

  {

    type: "function",

    name: "complete_intake",

    description: "Zakończ rozmowę po zebraniu danych — wyszukamy firmy i wyślemy SMS klientowi.",

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

  {

    type: "function",

    name: "hangup_call",

    description: "Zakończ po complete_intake.",

    parameters: { type: "object", properties: {} },

  },

];



const server = http.createServer((req, res) => {

  if (req.url === "/health") {

    res.writeHead(200, { "Content-Type": "application/json" });

    res.end(JSON.stringify({ ok: true, service: "bookforday-voice", mode: USE_ELEVENLABS ? "elevenlabs" : "openai-audio" }));

    return;

  }

  if (req.url === "/voice") {

    res.writeHead(200, { "Content-Type": "text/xml" });

    res.end(

      `<Response><Connect><Stream url="wss://${req.headers.host}/media" /></Connect></Response>`

    );

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

  let sessionReady = false;

  let sessionConfigured = false;

  let firstResponseSent = false;

  const handledFunctionCalls = new Set();



  const sendTwilioAudio = (base64Pcmu) => {

    if (!streamSid || !base64Pcmu) return;

    twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Pcmu } }));

  };



  const setupElevenLabs = (initialText = " ") => {

    if (!USE_ELEVENLABS || !ELEVENLABS_API_KEY) return;

    if (elevenLabsWs) elevenLabsWs.close();

    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=eleven_multilingual_v2&output_format=ulaw_8000`;

    elevenLabsWs = new WebSocket(url, { headers: { "xi-api-key": ELEVENLABS_API_KEY } });

    elevenLabsWs.on("open", () => {

      elevenLabsWs.send(

        JSON.stringify({ text: initialText, voice_settings: { stability: 0.5, similarity_boost: 0.8 } })

      );

      if (initialText.trim()) elevenLabsWs.send(JSON.stringify({ text: "", flush: true }));

    });

    elevenLabsWs.on("message", (data) => {

      try {

        const msg = JSON.parse(data);

        if (msg.audio) sendTwilioAudio(msg.audio);

      } catch (e) {}

    });

    elevenLabsWs.on("error", (err) => console.error("[ElevenLabs]", err.message));

  };



  const triggerFirstResponse = () => {

    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || firstResponseSent) return;

    firstResponseSent = true;

    const greeting = (callParams?.greeting || "").trim();

    const payload = {

      type: "response.create",

      response: {

        output_modalities: USE_ELEVENLABS ? ["text"] : ["audio"],

      },

    };

    if (greeting) {

      payload.response.instructions =

        `Przywitaj się po polsku (naturalnie, własnymi słowami, sens: "${greeting}"). ` +

        "Zapytaj, jakiej usługi szuka klient, w jakim mieście i na kiedy chce wizytę.";

    }

    openaiWs.send(JSON.stringify(payload));

  };



  const startSession = () => {

    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || !callParams || sessionConfigured) return;

    let instructions = (callParams.prompt || "").trim();

    if (instructions.length < 80) {

      instructions =

        "Jesteś asystentem BookForDay. Mów po polsku. Zbierz usługę, miasto i termin. Potem complete_intake i hangup_call.";

    }

    const session = {

      type: "realtime",

      model: REALTIME_MODEL,

      instructions,

      tools: toolsIntake,

      tool_choice: "auto",

    };



    if (USE_ELEVENLABS) {

      session.output_modalities = ["text"];

      session.audio = {

        input: {

          format: { type: "audio/pcmu" },

          transcription: { model: "whisper-1", language: "pl" },

          turn_detection: {

            type: "server_vad",

            threshold: 0.8,

            prefix_padding_ms: 300,

            silence_duration_ms: 700,

            create_response: true,

            interrupt_response: true,

          },

        },

      };

    } else {

      session.output_modalities = ["audio"];

      session.audio = {

        input: {

          format: { type: "audio/pcmu" },

          transcription: { model: "whisper-1", language: "pl" },

          turn_detection: {

            type: "server_vad",

            threshold: 0.75,

            prefix_padding_ms: 300,

            silence_duration_ms: 600,

            create_response: true,

            interrupt_response: true,

          },

        },

        output: {

          format: { type: "audio/pcmu" },

          voice: REALTIME_VOICE,

        },

      };

    }



    sessionConfigured = true;

    openaiWs.send(JSON.stringify({ type: "session.update", session }));

  };



  const connectOpenAI = async (apiBase) => {

    const credential = await getOpenAICredential(apiBase);

    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(credential.model)}`, {

      headers: { Authorization: `Bearer ${credential.api_key}` },

    });

    openaiWs = ws;

    ws.on("open", () => {

      if (sessionReady) startSession();

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

      pendingHangup = true;

    } else if (name === "hangup_call") {

      pendingHangup = true;

    }

    openaiWs.send(

      JSON.stringify({

        type: "conversation.item.create",

        item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },

      })

    );

    openaiWs.send(JSON.stringify({ type: "response.create" }));

  };



  const onOpenAIMessage = async (msg) => {

    try {

      const data = JSON.parse(msg);



      if (data.type === "error") {

        console.error("[OpenAI error]", data.error?.message || JSON.stringify(data));

        return;

      }



      if (data.type === "session.updated") {

        triggerFirstResponse();

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

        if (USE_ELEVENLABS && elevenLabsWs?.readyState === WebSocket.OPEN) {

          elevenLabsWs.send(JSON.stringify({ text: "", flush: true }));

        }

        if (data.type === "response.done" && Array.isArray(data.response?.output)) {

          for (const item of data.response.output) {

            if (item.type === "function_call" && item.call_id) {

              await handleFunctionCall(item.name, item.arguments, item.call_id);

            }

          }

        }

        if (pendingHangup) {

          setTimeout(() => {

            if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));

            setTimeout(() => twilioWs.close(), 2000);

          }, 1200);

        }

      }



      if (data.type === "input_audio_buffer.speech_started") {

        const speakDuration = Date.now() - botSpeechStartTime;

        if (!isBotSpeaking || speakDuration > 4000) {

          if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));

          if (openaiWs?.readyState === WebSocket.OPEN) {

            openaiWs.send(JSON.stringify({ type: "response.cancel" }));

          }

          if (USE_ELEVENLABS) setupElevenLabs(" ");

        }

      }



      if (data.type === "response.function_call_arguments.done") {

        await handleFunctionCall(data.name, data.arguments, data.call_id);

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

          sessionReady = false;

          sessionConfigured = false;

          firstResponseSent = false;

          callParams = {

            prompt: "",

            greeting: custom.greeting || "",

            callSid: custom.callSid || data.start.callSid,

            callMode: custom.callMode || "intake",

            from: custom.fromNumber,

            to: custom.toNumber,

            apiBase: custom.apiBase || API_BASE,

          };

          console.log("[BookForDay] call start", callParams.callSid, callParams.from);



          connectOpenAI(callParams.apiBase).catch((e) =>

            console.error("[BookForDay] OpenAI connect failed", e.message)

          );



          (async () => {

            const loaded = await fetchSessionConfig(callParams);

            callParams.prompt = loaded.prompt;

            if (loaded.greeting) callParams.greeting = loaded.greeting;

            sessionReady = true;

            if (openaiWs?.readyState === WebSocket.OPEN) startSession();

            else if (openaiWs?.readyState === WebSocket.CONNECTING) {

              /* startSession runs on open */

            }

          })().catch((e) => console.error("[BookForDay] config failed", e.message));



          if (USE_ELEVENLABS && callParams.greeting) {

            setupElevenLabs(`${callParams.greeting} `);

          }



          apiPost(

            "webhook.php",

            {

              action: "start_intake",

              call_sid: callParams.callSid,

              client_phone: callParams.from,

            },

            callParams.apiBase

          ).catch(() => {});

          break;

        }

        case "media":

          if (openaiWs?.readyState === WebSocket.OPEN) {

            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));

          }

          break;

        case "stop":

          console.log("[BookForDay] call stop", callParams?.callSid);

          apiPost("webhook.php", { action: "call_completed", call_sid: callParams?.callSid }, callParams?.apiBase);

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

  console.log(`[BookForDay voice] Listening on ${PORT} (audio: ${USE_ELEVENLABS ? "elevenlabs" : "openai pcmu"})`);

  if (!API_BASE) console.warn("[BookForDay] Set BOOKFOR_API_BASE=https://bookforday.com/api/voice");

});


