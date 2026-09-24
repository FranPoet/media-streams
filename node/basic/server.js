/**
 * BookForDay — voice server for Render.com
 * Twilio Media Streams → OpenAI Realtime (text) → ElevenLabs TTS → Twilio
 *
 * Env on Render:
 *   BOOKFOR_API_BASE     — https://bookforday.com/api/voice
 *   BOOKFOR_API_SECRET   — same as voice_api_secret in inc/secrets.php
 *   OPENAI_API_KEY       — optional if realtime_credential.php works
 *   ELEVENLABS_API_KEY
 *   ELEVENLABS_VOICE_ID
 *   PORT=3000
 */
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;
const API_BASE = (process.env.BOOKFOR_API_BASE || process.env.STENOR_API_BASE || "").replace(/\/$/, "");
const API_SECRET = process.env.BOOKFOR_API_SECRET || process.env.STENOR_API_SECRET || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY ||
  "sk_499fda9e2d79d9ceba6357d176f52612252cc965bc4473d9";
const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "EmspiS7CSUabPeqBcrAP";
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";

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
    greeting: params.greeting || "Dzień dobry. W czym mogę pomóc?",
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
    res.end(JSON.stringify({ ok: true, service: "bookforday-voice" }));
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

  const setupElevenLabs = (initialText = " ") => {
    if (elevenLabsWs) elevenLabsWs.close();
    if (!ELEVENLABS_API_KEY) {
      console.error("[ElevenLabs] ELEVENLABS_API_KEY missing");
      return;
    }
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=eleven_multilingual_v2&output_format=ulaw_8000`;
    elevenLabsWs = new WebSocket(url, { headers: { "xi-api-key": ELEVENLABS_API_KEY } });
    elevenLabsWs.on("open", () => {
      elevenLabsWs.send(JSON.stringify({ text: initialText, voice_settings: { stability: 0.5, similarity_boost: 0.8 } }));
      if (initialText.trim()) elevenLabsWs.send(JSON.stringify({ text: "", flush: true }));
    });
    elevenLabsWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.audio && streamSid) {
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: msg.audio } }));
        }
      } catch (e) {}
    });
  };

  const startSession = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || !callParams) return;
    let instructions = (callParams.prompt || "").trim();
    if (instructions.length < 80) {
      instructions =
        "Jesteś asystentem BookForDay. Mów po polsku. Zbierz usługę, miasto i termin. Potem complete_intake i hangup_call.";
    }
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          instructions,
          output_modalities: ["text"],
          tools: toolsIntake,
          tool_choice: "auto",
          audio: {
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
          },
        },
      })
    );
    const greetingText = callParams.greeting || " ";
    if (greetingText.trim()) {
      openaiWs.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: greetingText }],
          },
        })
      );
    }
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
    ws.on("error", (err) => console.error("[OpenAI]", err.message));
  };

  let isBotSpeaking = false;
  let botSpeechStartTime = 0;

  const onOpenAIMessage = async (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "response.created") {
        isBotSpeaking = true;
        botSpeechStartTime = Date.now();
      }
      const textDelta = data.type === "response.output_text.delta" || data.type === "response.text.delta";
      if (textDelta && data.delta && elevenLabsWs?.readyState === WebSocket.OPEN) {
        elevenLabsWs.send(JSON.stringify({ text: data.delta }));
      }
      if (data.type === "response.done" || data.type === "response.completed" || data.type === "response.cancel") {
        isBotSpeaking = false;
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.send(JSON.stringify({ text: "", flush: true }));
        }
        if (pendingHangup) {
          setTimeout(() => {
            if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
            setTimeout(() => twilioWs.close(), 1500);
          }, 800);
        }
      }
      if (data.type === "input_audio_buffer.speech_started") {
        const speakDuration = Date.now() - botSpeechStartTime;
        if (!isBotSpeaking || speakDuration > 5000) {
          if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
          openaiWs.send(JSON.stringify({ type: "response.cancel" }));
          setupElevenLabs(" ");
        }
      }
      if (data.type === "response.function_call_arguments.done") {
        const args = data.arguments ? JSON.parse(data.arguments) : {};
        let result = { status: "ok" };
        if (data.name === "complete_intake") {
          result = await apiPost(
            "webhook.php",
            {
              action: "complete_intake",
              call_sid: callParams?.callSid,
              intake: { ...args, client_phone: callParams?.from },
            },
            callParams?.apiBase
          );
          pendingHangup = true;
        } else if (data.name === "hangup_call") {
          pendingHangup = true;
        }
        openaiWs.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: data.call_id, output: JSON.stringify(result) },
          })
        );
        openaiWs.send(JSON.stringify({ type: "response.create" }));
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
          callParams = {
            prompt: "",
            greeting: custom.greeting || "Dzień dobry.",
            callSid: custom.callSid,
            callMode: custom.callMode || "intake",
            from: custom.fromNumber,
            to: custom.toNumber,
            apiBase: custom.apiBase || API_BASE,
          };
          (async () => {
            const loaded = await fetchSessionConfig(callParams);
            callParams.prompt = loaded.prompt;
            if (loaded.greeting) callParams.greeting = loaded.greeting;
            await connectOpenAI(callParams.apiBase);
            setupElevenLabs((callParams.greeting || "").trim() + " ");
            await apiPost(
              "webhook.php",
              {
                action: "start_intake",
                call_sid: callParams.callSid,
                client_phone: callParams.from,
              },
              callParams.apiBase
            );
            sessionReady = true;
            if (openaiWs?.readyState === WebSocket.OPEN) startSession();
          })().catch((e) => console.error("[BookForDay] start failed", e.message));
          break;
        }
        case "media":
          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
          }
          break;
        case "stop":
          apiPost("webhook.php", { action: "call_completed", call_sid: callParams?.callSid }, callParams?.apiBase);
          if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
          if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
          break;
      }
    } catch (e) {}
  });

  twilioWs.on("close", () => {
    if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
    if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
  });
});

server.listen(PORT, () => {
  console.log(`[BookForDay voice] Listening on ${PORT}`);
  if (!API_BASE) console.warn("[BookForDay] Set BOOKFOR_API_BASE=https://bookforday.com/api/voice");
});
