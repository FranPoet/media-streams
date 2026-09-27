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
const ELEVEN_KEY_ENV = (process.env.ELEVENLABS_API_KEY || "").trim();
const ELEVEN_VOICE_DEFAULT = (process.env.ELEVENLABS_VOICE_ID || "EmspiS7CSUabPeqBcrAP").trim();
const ELEVEN_MODEL = (process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5").trim();
/** Włączone gdy jest klucz (Render lub PHP). USE_ELEVENLABS=0 — wyłącza. */
const ELEVENLABS_AUTO = process.env.USE_ELEVENLABS !== "0" && (process.env.USE_ELEVENLABS === "1" || !!ELEVEN_KEY_ENV);
// Mini Realtime (OpenAI): gpt-realtime-mini lub gpt-realtime-2.1-mini — ustaw OPENAI_REALTIME_MODEL na Render.
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-mini";
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";
// Wyższy próg VAD = mniej reakcji na szum / głosy w tle (0.0–1.0).
// Niższe silence_duration_ms = szybsza reakcja po Twojej wypowiedzi (domyślnie ~1,2 s ciszy).
const VAD_THRESHOLD = Math.min(1, Math.max(0.5, parseFloat(process.env.VAD_THRESHOLD || "0.94") || 0.94));
const VAD_SILENCE_MS = Math.min(4000, Math.max(600, parseInt(process.env.VAD_SILENCE_MS || "900", 10) || 900));
const VAD_PREFIX_MS = Math.min(1200, Math.max(200, parseInt(process.env.VAD_PREFIX_MS || "280", 10) || 280));
// near_field = telefon przy ustach; domyślnie off (niektóre modele Realtime odrzucają pole → cisza)
const INPUT_NOISE_REDUCTION = (process.env.INPUT_NOISE_REDUCTION || "off").trim().toLowerCase();
const BARGE_IN_MIN_MS = Math.min(3000, Math.max(400, parseInt(process.env.BARGE_IN_MIN_MS || "900", 10) || 900));
// Klient może przerwać wypowiedź bota (barge-in). ALLOW_BARGE_IN=0 — wyłącza.
const ALLOW_BARGE_IN = process.env.ALLOW_BARGE_IN !== "0";

const DEFAULT_GREETING = "Jakiej usługi szukasz?";
const DEFAULT_CONSENT =
  "Dzień dobry, tu asystent głosowy BookForDay. Informacja prawna: rozmowa może być nagrywana i przetwarzana w celu obsługi Twojego zapytania. Możemy wysłać Ci SMS z wynikami oraz przekazać firmom z naszej bazy Twoje zapytanie i numer telefonu, aby mogły odpowiedzieć. Szczegóły przetwarzania danych: bookforday.com/polityka-prywatnosci. Pozostając na linii, akceptujesz te warunki i wyrażasz zgodę na powyższe działania. Jeśli nie wyrażasz zgody, rozłącz się teraz. Jeśli zostajesz na linii, za chwilę zapytam, czego szukasz.";
const FALLBACK_PROMPT =
  "Asystent BookForDay. Kroki: usługa → salon vs online → brakujące pola → complete_intake. Krótko po polsku.";

const POLISH_RULES =
  "Tylko polski. Jedna krótka wypowiedź na turę (zwykle jedno pytanie). " +
  "Bez dygresji, bez powtarzania klienta, bez wyjaśniania systemu. " +
  "Pożegnanie wyłącznie: „Do widzenia” lub „Do usłyszenia” na końcu rozmowy. Zakaz angielskiego. " +
  "Off-topic: jedno zdanie „Wróćmy do usługi…” i od razu pytanie z algorytmu. " +
  "Słuchaj wyłącznie rozmówcy przy telefonie — ignoruj rozmowy w tle, telewizor i ciche głosy w oddali. " +
  "Nie odpowiadaj na szum; czekaj na wyraźne zdanie klienta.";

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
    Accept: "application/json",
    "User-Agent": "BookForDay-Voice/22 (Render; bookforday.com)",
    Authorization: `Bearer ${API_SECRET}`,
    "X-BookFor-Voice-Key": API_SECRET,
    "X-BookFor-Signature": signBody(body),
  };
}

function logApi403(label, err) {
  const code = err?.response?.status;
  if (code === 403) {
    const msg = err?.response?.data ? JSON.stringify(err.response.data) : "";
    const imunify = /imunify360|bot-protection/i.test(msg);
    console.error(
      imunify
        ? `[BookForDay] ${label}: 403 Imunify360 — w panelu hostingu dodaj IP Render do whitelist Imunify360 (Security). ${msg}`
        : `[BookForDay] ${label}: 403 — voice_api_secret w secrets.php = server.js (len ${API_SECRET.length}). ${msg}`
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
      return {
        prompt: data.prompt || "",
        greeting: data.greeting || params.greeting,
        consent: data.consent || params.consent || DEFAULT_CONSENT,
        elevenlabsKey: (data.elevenlabs_key || params.elevenlabsKey || "").trim(),
        elevenlabsVoiceId: (data.elevenlabs_voice_id || params.elevenlabsVoiceId || "").trim(),
      };
    }
  } catch (err) {
    logApi403("session_config", err);
    console.error("[BookForDay] session_config:", err.message);
  }
  return {
    prompt: "",
    greeting:
      params.greeting ||
      "Dzień dobry, BookForDay. Jakiej usługi szukasz?",
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
  if (OPENAI_API_KEY) {
    return { model: REALTIME_MODEL, api_key: OPENAI_API_KEY };
  }
  return await fetchOpenAICredential(apiBase);
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
      validateStatus: (s) => s >= 200 && s < 600,
    });
    return data;
  } catch (err) {
    logApi403(path, err);
    if (err.response?.data && typeof err.response.data === "object") {
      return err.response.data;
    }
    console.error("[BookForDay API]", path, err.message);
    return { status: "error", message: err.message };
  }
}

const toolsIntake = [
  {
    type: "function",
    name: "complete_intake",
    description:
      "Wywołaj TYLKO gdy algorytm kompletny. ON_SITE: service_needed, category, service_delivery=on_site, location_scope=local, city, date_wanted, time_from, time_to, needs_today. " +
      "REMOTE: service_delivery=remote_ok, location_scope, service_needed, category, needs_today; city tylko gdy local/both; bez godzin dla online.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "fryzjer, barber, kosmetyka, paznokcie, massage, groomer, inne" },
        city: { type: "string" },
        district: { type: "string" },
        service_needed: { type: "string" },
        service_delivery: { type: "string", enum: ["on_site", "remote_ok", "flexible"] },
        location_scope: { type: "string", enum: ["local", "online", "both"] },
        date_wanted: { type: "string" },
        time_from: { type: "string" },
        time_to: { type: "string" },
        datetime: { type: "string", description: "Kiedy klient chce wizytę" },
        needs_today: { type: "boolean" },
        details: { type: "string" },
        original_request: { type: "string" },
      },
      required: ["category", "service_needed", "service_delivery", "location_scope", "needs_today"],
    },
  },
];

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "bookforday-voice",
        v: 22,
        model: REALTIME_MODEL,
        vad_threshold: VAD_THRESHOLD,
        noise_reduction: INPUT_NOISE_REDUCTION,
        barge_in: ALLOW_BARGE_IN,
        elevenlabs: process.env.USE_ELEVENLABS !== "0",
        elevenlabs_env_key: !!ELEVEN_KEY_ENV,
      })
    );
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
  let useElevenForCall = ELEVENLABS_AUTO;
  let elevenApiKey = ELEVEN_KEY_ENV;
  let elevenVoiceId = ELEVEN_VOICE_DEFAULT;
  let elevenLabsReady = false;
  let elevenTextQueue = [];
  let elevenFlushPending = false;
  let pendingHangup = false;
  let hangupScheduled = false;
  let intakeCompleted = false;
  let configLoaded = false;
  let openaiConnected = false;
  let sessionConfigured = false;
  let firstResponseSent = false;
  let consentCompleted = false;
  let consentInProgress = false;
  let consentResponseSent = false;
  let consentRetryCount = 0;
  let vadAutoResponse = false;
  let hangupInProgress = false;
  let hangupAfterMs = 12000;
  let lastBotAudioAt = 0;
  let awaitingFarewellSpeech = false;
  let farewellPending = false;
  let farewellTranscript = "";
  let goodbyeHangupRetries = 0;
  let goodbyePollTimer = null;
  let firstResponseWatchdog = null;
  let audioChunksToTwilio = 0;
  let botTranscriptBuffer = "";
  const handledFunctionCalls = new Set();
  const GOODBYE_RE = /do\s+(widzenia|usłyszenia|uslyszenia)/i;

  const applyElevenConfig = () => {
    if (callParams?.elevenlabsKey) elevenApiKey = String(callParams.elevenlabsKey).trim();
    if (callParams?.elevenlabsVoiceId) elevenVoiceId = String(callParams.elevenlabsVoiceId).trim();
    if (process.env.USE_ELEVENLABS === "0") useElevenForCall = false;
    else useElevenForCall = process.env.USE_ELEVENLABS === "1" || !!elevenApiKey;
  };

  const fallbackToOpenAIVoice = (reason) => {
    if (!useElevenForCall) return;
    console.warn("[BookForDay] ElevenLabs fallback → OpenAI audio:", reason);
    useElevenForCall = false;
    closeElevenLabsStream();
    consentResponseSent = false;
    consentCompleted = false;
    consentInProgress = false;
    consentRetryCount = 0;
    firstResponseSent = false;
    sessionConfigured = false;
    fullSessionApplied = false;
    greetingRetryCount = 0;
    audioChunksToTwilio = 0;
    audioChunksThisResponse = 0;
    if (openaiWs?.readyState === WebSocket.OPEN) {
      sendSessionUpdate((callParams?.prompt || FALLBACK_PROMPT).trim(), false, { minimal: true });
    }
  };

  const drainElevenTextQueue = () => {
    if (!elevenLabsWs || elevenLabsWs.readyState !== WebSocket.OPEN || !elevenLabsReady) return;
    while (elevenTextQueue.length) {
      const chunk = elevenTextQueue.shift();
      elevenLabsWs.send(JSON.stringify({ text: chunk }));
    }
    if (elevenFlushPending) {
      elevenFlushPending = false;
      try {
        elevenLabsWs.send(JSON.stringify({ text: "" }));
      } catch (_) {}
    }
  };

  const closeElevenLabsStream = () => {
    elevenLabsReady = false;
    elevenTextQueue = [];
    elevenFlushPending = false;
    if (elevenLabsWs?.readyState === WebSocket.OPEN) {
      try {
        elevenLabsWs.send(JSON.stringify({ text: "" }));
      } catch (_) {}
      try {
        elevenLabsWs.close();
      } catch (_) {}
    }
    elevenLabsWs = null;
  };

  const ensureElevenLabsStream = () => {
    if (!useElevenForCall || !elevenApiKey) return;
    if (elevenLabsWs?.readyState === WebSocket.OPEN && elevenLabsReady) return;
    closeElevenLabsStream();
    const q = new URLSearchParams({
      model_id: ELEVEN_MODEL,
      output_format: "ulaw_8000",
      inactivity_timeout: "180",
    });
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenVoiceId)}/stream-input?${q}`;
    const ws = new WebSocket(url, { headers: { "xi-api-key": elevenApiKey } });
    elevenLabsWs = ws;
    ws.on("open", () => {
      elevenLabsReady = true;
      console.log("[BookForDay] ElevenLabs WS open voice=", elevenVoiceId);
      ws.send(
        JSON.stringify({
          text: " ",
          voice_settings: { stability: 0.42, similarity_boost: 0.78, speed: 1.0 },
          generation_config: { chunk_length_schedule: [50, 80, 120, 180] },
        })
      );
      setTimeout(() => drainElevenTextQueue(), 40);
    });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.error) {
          console.error("[ElevenLabs error]", msg.error);
          fallbackToOpenAIVoice(String(msg.error));
          return;
        }
        if (msg.audio) {
          lastBotAudioAt = Date.now();
          audioChunksToTwilio += 1;
          audioChunksThisResponse += 1;
          if (audioChunksToTwilio === 1) {
            console.log("[BookForDay] first audio → Twilio (ElevenLabs)");
          }
          sendTwilioAudio(msg.audio);
        }
      } catch (e) {
        console.error("[ElevenLabs parse]", e.message);
      }
    });
    ws.on("error", (err) => {
      console.error("[ElevenLabs WS error]", err.message);
      fallbackToOpenAIVoice(err.message);
    });
    ws.on("close", () => {
      elevenLabsReady = false;
    });
  };

  const sendElevenText = (text) => {
    if (!useElevenForCall || !text) return;
    elevenTextQueue.push(text);
    ensureElevenLabsStream();
    drainElevenTextQueue();
  };

  const flushElevenLabs = () => {
    if (!useElevenForCall) return;
    if (elevenLabsWs?.readyState === WebSocket.OPEN && elevenLabsReady) {
      try {
        elevenLabsWs.send(JSON.stringify({ text: "" }));
      } catch (_) {}
    } else {
      elevenFlushPending = true;
    }
  };

  const speakElevenFromResponse = (response) => {
    if (!useElevenForCall || !response || !Array.isArray(response.output)) return;
    let bulk = "";
    for (const item of response.output) {
      if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part?.text) bulk += part.text;
        else if (part?.transcript) bulk += part.transcript;
      }
    }
    bulk = bulk.replace(/\s+/g, " ").trim();
    if (bulk.length >= 2) {
      console.log("[BookForDay] ElevenLabs bulk text len", bulk.length);
      sendElevenText(bulk);
      flushElevenLabs();
    }
  };

  const pushTranscript = (role, text) => {
    const t = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (t.length < 2 || !callParams?.callSid) return;
    void apiPost(
      "webhook.php",
      { action: "append_transcript", call_sid: callParams.callSid, role, text: t },
      callParams.apiBase
    );
  };

  const flushBotTranscript = () => {
    const t = botTranscriptBuffer.replace(/\s+/g, " ").trim();
    botTranscriptBuffer = "";
    if (t.length >= 2) pushTranscript("assistant", t);
  };

  const appendFarewellTranscript = (text) => {
    if (!text || !awaitingFarewellSpeech) return;
    farewellTranscript += text;
  };

  const extractFarewellFromResponse = (response) => {
    if (!response || !Array.isArray(response.output)) return;
    for (const item of response.output) {
      if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (!part) continue;
        if (part.transcript) appendFarewellTranscript(part.transcript);
        if (part.text) appendFarewellTranscript(part.text);
      }
    }
  };

  const hasGoodbyePhrase = () => GOODBYE_RE.test(farewellTranscript);

  const scheduleHangupAfterGoodbye = () => {
    if (hangupScheduled || hangupInProgress) return;
    if (!hasGoodbyePhrase()) {
      return;
    }
    hangupScheduled = true;
    const sinceAudio = lastBotAudioAt ? Date.now() - lastBotAudioAt : 5000;
    const tailMs = Math.max(4500, sinceAudio + 3500);
    console.log(
      "[BookForDay] hangup after goodbye in",
      tailMs,
      "ms transcript=",
      farewellTranscript.slice(0, 140)
    );
    setTimeout(() => {
      void endCall("after_goodbye");
    }, tailMs);
  };

  const waitForGoodbyeThenHangup = (attempt = 0) => {
    if (hangupScheduled || hangupInProgress) return;
    if (hasGoodbyePhrase() && Date.now() - lastBotAudioAt >= 1800) {
      scheduleHangupAfterGoodbye();
      return;
    }
    if (attempt >= 80) {
      if (goodbyeHangupRetries < 1 && openaiWs?.readyState === WebSocket.OPEN) {
        goodbyeHangupRetries += 1;
        awaitingFarewellSpeech = true;
        farewellTranscript = "";
        openaiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              output_modalities: useElevenForCall ? ["text"] : ["audio"],
              instructions:
                `${POLISH_RULES} Powiedz wyłącznie jedno zdanie po polsku: „Do widzenia.” albo „Do usłyszenia.” Koniec.`,
            },
          })
        );
        waitForGoodbyeThenHangup(0);
        return;
      }
      return;
    }
    goodbyePollTimer = setTimeout(() => waitForGoodbyeThenHangup(attempt + 1), 400);
  };

  const sendTwilioAudio = (base64Pcmu) => {
    if (!streamSid || !base64Pcmu) return;
    twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Pcmu } }));
  };

  const clearTwilioPlayback = () => {
    if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) return;
    try {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
    } catch (_) {}
    if (useElevenForCall) closeElevenLabsStream();
  };

  const endCall = async (reason) => {
    if (hangupInProgress) return;
    hangupInProgress = true;
    const sinceAudio = lastBotAudioAt ? Date.now() - lastBotAudioAt : 0;
    if (sinceAudio < 4500) {
      await new Promise((r) => setTimeout(r, 4500 - sinceAudio));
    }
    if (callParams?.callSid) {
      const hangup = await apiPost(
        "webhook.php",
        { action: "hangup_call", call_sid: callParams.callSid },
        callParams.apiBase
      );
      console.log("[BookForDay] hangup_call", hangup);
    }
    setTimeout(() => {
      if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
        try {
          twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
          twilioWs.send(JSON.stringify({ event: "stop", streamSid }));
        } catch (_) {}
      }
      if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
      closeElevenLabsStream();
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, reason || "done");
    }, 600);
  };

  const turnDetection = (createResponse) => ({
    type: "server_vad",
    threshold: VAD_THRESHOLD,
    prefix_padding_ms: VAD_PREFIX_MS,
    silence_duration_ms: VAD_SILENCE_MS,
    create_response: createResponse,
    interrupt_response: ALLOW_BARGE_IN,
  });

  let omitNoiseReduction = false;
  let omitInputTranscription = false;
  let sessionMinimalMode = true;
  let sessionUpdateInFlight = false;
  let fullSessionApplied = false;
  let greetingRetryCount = 0;
  let audioChunksThisResponse = 0;
  let sessionUpdateAttempts = 0;
  const MAX_SESSION_ATTEMPTS = 5;

  const buildSessionPayload = (instructions, createResponse, opts = {}) => {
    const minimal = opts.minimal === true || (opts.minimal !== false && sessionMinimalMode && !fullSessionApplied);
    const session = {
      type: "realtime",
      instructions: POLISH_RULES + "\n\n" + (instructions || FALLBACK_PROMPT),
    };
    if (!minimal) {
      session.tools = toolsIntake;
      session.tool_choice = "auto";
    }
    const inputAudio = {
      format: { type: "audio/pcmu" },
      turn_detection: turnDetection(createResponse),
    };
    if (!minimal && !omitInputTranscription) {
      inputAudio.transcription = { model: "whisper-1", language: "pl" };
    }
    if (
      !omitNoiseReduction &&
      INPUT_NOISE_REDUCTION &&
      INPUT_NOISE_REDUCTION !== "off" &&
      INPUT_NOISE_REDUCTION !== "0"
    ) {
      inputAudio.noise_reduction = { type: INPUT_NOISE_REDUCTION === "far_field" ? "far_field" : "near_field" };
    }
    if (useElevenForCall && elevenApiKey) {
      session.output_modalities = ["text"];
      session.audio = {
        input: inputAudio,
      };
    } else {
      session.output_modalities = ["audio"];
      session.audio = {
        input: inputAudio,
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
      instructions = FALLBACK_PROMPT;
    }
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: buildSessionPayload(instructions, true),
      })
    );
  };

  const sendSessionUpdate = (instructions, createResponse, opts = {}) => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    sessionUpdateInFlight = true;
    const payload = buildSessionPayload(instructions, createResponse, opts);
    console.log(
      "[BookForDay] session.update",
      opts.minimal || (sessionMinimalMode && !fullSessionApplied) ? "minimal" : "full",
      "prompt len",
      (instructions || "").length
    );
    openaiWs.send(JSON.stringify({ type: "session.update", session: payload }));
  };

  const applyFullSession = () => {
    if (fullSessionApplied || !callParams || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    fullSessionApplied = true;
    sessionMinimalMode = false;
    let instructions = (callParams.prompt || "").trim();
    if (instructions.length < 80) instructions = FALLBACK_PROMPT;
    sendSessionUpdate(instructions, vadAutoResponse, { minimal: false });
  };

  const tryStartSession = () => {
    if (!configLoaded || !openaiConnected || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (sessionConfigured || sessionUpdateInFlight || !callParams) return;
    if (sessionUpdateAttempts >= MAX_SESSION_ATTEMPTS) {
      console.error("[BookForDay] session.update max attempts — forcing greeting");
      triggerCallOpening();
      return;
    }
    sessionUpdateAttempts += 1;
    let instructions = (callParams.prompt || "").trim();
    if (instructions.length < 80) {
      instructions = FALLBACK_PROMPT;
    }
    sessionMinimalMode = true;
    fullSessionApplied = false;
    sendSessionUpdate(instructions, false, { minimal: true });
    if (firstResponseWatchdog) clearTimeout(firstResponseWatchdog);
    firstResponseWatchdog = setTimeout(() => {
      if (firstResponseSent || consentCompleted) return;
      if (consentResponseSent && !consentInProgress) {
        console.warn("[BookForDay] watchdog: consent bez zakończenia — ponawiam RODO");
        retryConsentNotice("watchdog");
        return;
      }
      if (!consentResponseSent) {
        console.warn("[BookForDay] watchdog: wymuszam informację RODO");
        triggerCallOpening();
      }
    }, 4500);
  };

  const completeConsentPhase = () => {
    if (!consentInProgress) return;
    consentInProgress = false;
    consentCompleted = true;
    setInterruptResponse(ALLOW_BARGE_IN);
    console.log("[BookForDay] consent phase complete — service greeting next");
    if (!firstResponseSent) {
      setTimeout(() => triggerServiceGreeting(), 400);
    }
  };

  const retryConsentNotice = (reason) => {
    if (consentRetryCount >= 4) {
      console.error("[BookForDay] consent failed after retries — continuing with greeting anyway", reason);
      completeConsentPhase();
      return;
    }
    consentRetryCount += 1;
    consentResponseSent = false;
    consentInProgress = false;
    console.warn("[BookForDay] consent retry", consentRetryCount, reason || "");
    setTimeout(() => triggerConsentNotice(), 500);
  };

  const triggerConsentNotice = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || consentResponseSent || consentCompleted) return;
    consentResponseSent = true;
    consentInProgress = true;
    setInterruptResponse(false);
    const consent = (callParams?.consent || "").trim() || DEFAULT_CONSENT;
    console.log("[BookForDay] response.create consent (no barge-in)");
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: useElevenForCall && elevenApiKey ? ["text"] : ["audio"],
          instructions:
            `${POLISH_RULES} To pierwsza wypowiedź w rozmowie — wyłącznie informacja prawna RODO. ` +
            "Przeczytaj DOKŁADNIE słowo w słowo cały poniższy tekst, bez skrótów, bez parafrazy, bez dodatkowych zdań: " +
            `„${consent}” ` +
            "Zakaz pytania o usługę w tej turze. Zakaz complete_intake. Zakaz „do widzenia”.",
        },
      })
    );
  };

  const triggerServiceGreeting = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || firstResponseSent || !consentCompleted) return;
    firstResponseSent = true;
    const greeting = (callParams?.greeting || "").trim() || DEFAULT_GREETING;
    console.log("[BookForDay] response.create greeting");
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: useElevenForCall && elevenApiKey ? ["text"] : ["audio"],
          instructions:
            `${POLISH_RULES} Po informacji prawnej. Powiedz DOKŁADNIE jedno pytanie: „${greeting}” ` +
            "Nie dodawaj miasta ani terminu. Nie kończ rozmowy. Nie wywołuj complete_intake.",
        },
      })
    );
  };

  const triggerCallOpening = () => {
    if (!consentResponseSent) triggerConsentNotice();
    else if (consentCompleted && !firstResponseSent) triggerServiceGreeting();
  };

  const connectOpenAI = (apiBase) =>
    new Promise(async (resolve, reject) => {
      try {
        const credential = await getOpenAICredential(apiBase);
        const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(credential.model)}`, {
          headers: { Authorization: `Bearer ${credential.api_key}` },
        });
        openaiWs = ws;
        ws.on("open", () => {
          openaiConnected = true;
          console.log("[BookForDay] OpenAI WS open model=", credential.model);
          if (configLoaded) tryStartSession();
          resolve();
        });
        ws.on("message", onOpenAIMessage);
        ws.on("error", (err) => {
          console.error("[OpenAI WS error]", err.message);
          reject(err);
        });
        ws.on("close", (code, reason) => {
          console.log("[BookForDay] OpenAI WS close", code, reason?.toString?.() || "");
          openaiConnected = false;
        });
      } catch (e) {
        reject(e);
      }
    });

  let isBotSpeaking = false;
  let botSpeechStartTime = 0;

  const canBargeInNow = () => {
    if (consentInProgress || !consentCompleted) return false;
    if (!ALLOW_BARGE_IN || !isBotSpeaking) return false;
    return Date.now() - botSpeechStartTime >= BARGE_IN_MIN_MS;
  };

  const setInterruptResponse = (allow) => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            input: {
              turn_detection: {
                type: "server_vad",
                threshold: VAD_THRESHOLD,
                prefix_padding_ms: VAD_PREFIX_MS,
                silence_duration_ms: VAD_SILENCE_MS,
                create_response: vadAutoResponse,
                interrupt_response: allow && ALLOW_BARGE_IN,
              },
            },
          },
        },
      })
    );
  };

  const handleFunctionCall = async (name, argsJson, callId) => {
    if (!callId || handledFunctionCalls.has(callId)) return;
    handledFunctionCalls.add(callId);
    let args = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch (e) {
      console.error("[OpenAI] bad function args", e.message);
    }

    let result = { status: "ok", result: "searching" };
    if (name === "complete_intake") {
      intakeCompleted = true;
      farewellPending = true;
      void apiPost(
        "webhook.php",
        {
          action: "complete_intake",
          call_sid: callParams?.callSid,
          from_number: callParams?.from,
          fromNumber: callParams?.from,
          intake: { ...args, client_phone: callParams?.from },
        },
        callParams?.apiBase
      ).then((apiResult) => {
        console.log("[BookForDay] complete_intake", apiResult);
        if (apiResult?.result === "no_firms") {
          result.result = "no_firms";
        }
      });
      if (openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "session.update",
            session: {
              audio: {
                input: {
                  turn_detection: {
                    type: "server_vad",
                    threshold: VAD_THRESHOLD,
                    prefix_padding_ms: VAD_PREFIX_MS,
                    silence_duration_ms: VAD_SILENCE_MS,
                    create_response: false,
                    interrupt_response: ALLOW_BARGE_IN,
                  },
                },
              },
            },
          })
        );
      }
    }

    openaiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
      })
    );
    const askLine =
      (result.ask_client || result.message || "").trim() ||
      "Czego dokładnie szukasz?";
    const afterIntake =
      result.result === "no_firms"
        ? `${POLISH_RULES} Ostatnia wypowiedź rozmowy. Powiedz po polsku, wyraźnie i w całości: „Niestety na razie nie mamy pasującej firmy, ale zapisaliśmy zapytanie. Do widzenia.” Koniec. Bez funkcji.`
        : `${POLISH_RULES} Ostatnia wypowiedź rozmowy. Powiedz po polsku, wyraźnie i w całości: „Wkrótce postaram się znaleźć firmę, która odpowie — dostaniesz SMS z numerami. Opowiedz znajomym i rodzinie o BookForDay. Do widzenia.” albo „Do usłyszenia.” Koniec. Bez funkcji.`;
    if (intakeCompleted) {
      farewellPending = true;
    }
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: useElevenForCall && elevenApiKey ? ["text"] : ["audio"],
          instructions: intakeCompleted
            ? afterIntake
            : `${POLISH_RULES} complete_intake jeszcze NIE gotowe. Powiedz TYLKO to pytanie (jedno zdanie): „${askLine}” Nic więcej. Nie wywołuj complete_intake.`,
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
        const errMsg = data.error?.message || JSON.stringify(data);
        console.error("[OpenAI error]", errMsg);
        void apiPost(
          "log.php",
          { event: "openai_error", call_sid: callParams?.callSid, message: errMsg },
          callParams?.apiBase
        );
        const errLower = String(errMsg).toLowerCase();
        sessionUpdateInFlight = false;
        if (
          !omitNoiseReduction &&
          (errLower.includes("noise_reduction") || errLower.includes("noise reduction"))
        ) {
          omitNoiseReduction = true;
          sessionConfigured = false;
          console.warn("[BookForDay] session.update retry without noise_reduction");
          tryStartSession();
        } else if (!omitInputTranscription && errLower.includes("transcription")) {
          omitInputTranscription = true;
          sessionConfigured = false;
          console.warn("[BookForDay] session.update retry without input transcription");
          tryStartSession();
        } else if (!sessionConfigured && sessionUpdateAttempts < MAX_SESSION_ATTEMPTS) {
          console.warn("[BookForDay] session.update failed — retry minimal");
          sessionMinimalMode = true;
          tryStartSession();
        } else if (!sessionConfigured) {
          triggerCallOpening();
        }
        return;
      }

      if (data.type === "session.updated") {
        sessionUpdateInFlight = false;
        sessionConfigured = true;
        console.log("[BookForDay] session.updated");
        if (!consentResponseSent || (consentCompleted && !firstResponseSent)) triggerCallOpening();
        return;
      }

      if (
        data.type === "conversation.item.input_audio_transcription.completed" ||
        data.type === "input_audio_transcription.completed"
      ) {
        const userText = data.transcript || data.item?.transcript || "";
        if (userText) pushTranscript("user", userText);
      }

      if (data.type === "response.created") {
        flushBotTranscript();
        audioChunksThisResponse = 0;
        isBotSpeaking = true;
        botSpeechStartTime = Date.now();
        if (useElevenForCall && elevenApiKey) {
          ensureElevenLabsStream();
        }
        if (farewellPending && intakeCompleted) {
          farewellPending = false;
          awaitingFarewellSpeech = true;
          farewellTranscript = "";
        }
      }

      const audioDelta =
        (data.type === "response.output_audio.delta" || data.type === "response.audio.delta") && data.delta;
      if (audioDelta) {
        lastBotAudioAt = Date.now();
        audioChunksToTwilio += 1;
        audioChunksThisResponse += 1;
        if (audioChunksToTwilio === 1) {
          console.log("[BookForDay] first audio → Twilio");
        }
        sendTwilioAudio(data.delta);
      }

      if (
        data.delta &&
        (data.type === "response.output_audio_transcript.delta" ||
          data.type === "response.audio_transcript.delta")
      ) {
        botTranscriptBuffer += data.delta;
        if (awaitingFarewellSpeech) appendFarewellTranscript(data.delta);
      }

      const textDelta =
        (data.type === "response.output_text.delta" ||
          data.type === "response.text.delta" ||
          data.type === "response.content_part.delta") &&
        data.delta;
      if (textDelta) {
        appendFarewellTranscript(data.delta);
        if (useElevenForCall) sendElevenText(data.delta);
      }

      if (data.type === "response.done" || data.type === "response.completed" || data.type === "response.cancelled") {
        if (data.type === "response.cancelled") {
          clearTwilioPlayback();
          botTranscriptBuffer = "";
        }
        isBotSpeaking = false;
        if (data.type === "response.done" && data.response) {
          extractFarewellFromResponse(data.response);
          if (!botTranscriptBuffer.trim()) {
            for (const item of data.response.output || []) {
              if (item?.type !== "message" || !Array.isArray(item.content)) continue;
              for (const part of item.content) {
                if (part?.transcript) botTranscriptBuffer += part.transcript;
                else if (part?.text) botTranscriptBuffer += part.text;
              }
            }
          }
        }
        flushBotTranscript();
        if (data.type === "response.done" || data.type === "response.completed") {
          if (useElevenForCall && data.response && audioChunksThisResponse === 0) {
            speakElevenFromResponse(data.response);
          }
          flushElevenLabs();
        }

        if (data.type === "response.done" && consentInProgress) {
          const finalizeConsent = () => {
            if (!consentInProgress) return;
            if (audioChunksThisResponse > 0 || audioChunksToTwilio > 0) {
              completeConsentPhase();
            } else {
              retryConsentNotice("no audio on consent turn");
            }
          };
          if (useElevenForCall && elevenApiKey) {
            setTimeout(finalizeConsent, 2800);
          } else {
            finalizeConsent();
          }
        }

        const maybeSilentTurn = () => {
          if (data.type !== "response.done" || intakeCompleted) return;
          if (audioChunksThisResponse > 0 || audioChunksToTwilio > 0) {
            if (consentInProgress) completeConsentPhase();
            return;
          }
          if (consentInProgress) {
            retryConsentNotice("silent consent turn");
            return;
          }
          if (greetingRetryCount >= 2) return;
          greetingRetryCount += 1;
          console.warn("[BookForDay] brak audio w odpowiedzi — ponawiam", greetingRetryCount);
          if (useElevenForCall && greetingRetryCount >= 2) {
            fallbackToOpenAIVoice("no audio after Eleven retries");
            setTimeout(() => triggerCallOpening(), 600);
            return;
          }
          firstResponseSent = false;
          setTimeout(() => triggerCallOpening(), 500);
        };
        if (data.type === "response.done") {
          if (useElevenForCall && elevenApiKey) {
            setTimeout(maybeSilentTurn, 2500);
          } else {
            maybeSilentTurn();
          }
        }
        if (data.type === "response.done" && data.response?.status === "failed") {
          console.error(
            "[BookForDay] response failed",
            JSON.stringify(data.response?.status_details || data.response?.output || {})
          );
          if (firstResponseSent && audioChunksToTwilio === 0 && greetingRetryCount < 2) {
            greetingRetryCount += 1;
            firstResponseSent = false;
            setTimeout(() => triggerServiceGreeting(), 400);
          }
        }

        let hadFunctionCallThisTurn = false;
        if (data.type === "response.done" && Array.isArray(data.response?.output)) {
          for (const item of data.response.output) {
            if (item.type === "function_call" && item.call_id) {
              hadFunctionCallThisTurn = true;
              await handleFunctionCall(item.name, item.arguments, item.call_id);
            }
          }
        }

        if (audioChunksThisResponse > 0 && !fullSessionApplied && !intakeCompleted) {
          applyFullSession();
        }

        if (firstResponseSent && consentCompleted && !vadAutoResponse && !intakeCompleted && !consentInProgress) {
          enableVadResponses();
          setInterruptResponse(ALLOW_BARGE_IN);
        }

        if (
          data.type === "response.done" &&
          awaitingFarewellSpeech &&
          !hadFunctionCallThisTurn &&
          !responseHasFunctionCall(data.response)
        ) {
          extractFarewellFromResponse(data.response);
          pendingHangup = true;
          if (goodbyePollTimer) clearTimeout(goodbyePollTimer);
          waitForGoodbyeThenHangup(0);
        }
      }

      if (data.type === "input_audio_buffer.speech_started" && canBargeInNow()) {
        clearTwilioPlayback();
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
          consentCompleted = false;
          consentInProgress = false;
          consentResponseSent = false;
          consentRetryCount = 0;
          vadAutoResponse = false;
          intakeCompleted = false;
          pendingHangup = false;
          hangupScheduled = false;
          hangupInProgress = false;
          hangupAfterMs = 12000;
          lastBotAudioAt = 0;
          awaitingFarewellSpeech = false;
          farewellPending = false;
          farewellTranscript = "";
          goodbyeHangupRetries = 0;
          if (goodbyePollTimer) clearTimeout(goodbyePollTimer);
          goodbyePollTimer = null;
          handledFunctionCalls.clear();
          omitNoiseReduction = false;
          omitInputTranscription = false;
          sessionMinimalMode = true;
          sessionUpdateInFlight = false;
          fullSessionApplied = false;
          sessionUpdateAttempts = 0;
          greetingRetryCount = 0;
          audioChunksThisResponse = 0;

          audioChunksToTwilio = 0;
          callParams = {
            prompt: FALLBACK_PROMPT,
            greeting: custom.greeting || DEFAULT_GREETING,
            consent: DEFAULT_CONSENT,
            elevenlabsKey: ELEVEN_KEY_ENV,
            elevenlabsVoiceId: ELEVEN_VOICE_DEFAULT,
            callSid: custom.callSid || data.start.callSid,
            callMode: custom.callMode || "intake",
            from: custom.fromNumber,
            to: custom.toNumber,
            apiBase: API_BASE,
          };
          applyElevenConfig();
          if (custom.apiBase && String(custom.apiBase).replace(/\/$/, "") !== API_BASE) {
            console.warn("[BookForDay] Ignoring Twilio apiBase:", custom.apiBase);
          }

          configLoaded = false;

          (async () => {
            try {
              const configRace = Promise.race([
                fetchSessionConfig(callParams),
                new Promise((resolve) =>
                  setTimeout(
                    () =>
                      resolve({
                        prompt: FALLBACK_PROMPT,
                        greeting: callParams.greeting,
                        consent: callParams.consent,
                        timedOut: true,
                      }),
                    3500
                  )
                ),
              ]);
              const openaiPromise = connectOpenAI(callParams.apiBase).catch((e) => {
                logApi403("realtime_credential", e);
                console.error("[BookForDay] OpenAI connect failed", e.message);
                void apiPost(
                  "log.php",
                  {
                    event: "openai_connect_failed",
                    call_sid: callParams.callSid,
                    message: String(e.message || e),
                    openai_env: OPENAI_API_KEY ? "yes" : "no",
                  },
                  callParams.apiBase
                );
              });

              const loaded = await configRace;
              if (loaded?.prompt) callParams.prompt = loaded.prompt;
              if (loaded?.greeting) callParams.greeting = loaded.greeting;
              if (loaded?.consent) callParams.consent = loaded.consent;
              if (loaded?.elevenlabsKey) callParams.elevenlabsKey = loaded.elevenlabsKey;
              if (loaded?.elevenlabsVoiceId) callParams.elevenlabsVoiceId = loaded.elevenlabsVoiceId;
              applyElevenConfig();
              configLoaded = true;
              if (useElevenForCall && elevenApiKey) {
                ensureElevenLabsStream();
              }
              if (loaded?.timedOut) {
                console.warn("[BookForDay] session_config timeout — fallback prompt");
              } else {
                console.log("[BookForDay] session_config ok prompt len", (callParams.prompt || "").length);
              }
              console.log(
                "[BookForDay] call start",
                callParams.callSid,
                "from",
                callParams.from,
                "openai_key=",
                OPENAI_API_KEY ? "env" : "php",
                "eleven=",
                useElevenForCall ? "yes" : "no",
                "→",
                API_BASE
              );

              await openaiPromise;
              if (openaiConnected && sessionConfigured && openaiWs?.readyState === WebSocket.OPEN) {
                sendSessionUpdate((callParams.prompt || FALLBACK_PROMPT).trim(), vadAutoResponse, { minimal: false });
              } else if (openaiConnected) {
                tryStartSession();
              }
            } catch (e) {
              console.error("[BookForDay] config failed", e.message);
            }
          })();

          void apiPost(
            "webhook.php",
            {
              action: "start_intake",
              call_sid: callParams.callSid,
              client_phone: callParams.from,
              from_number: callParams.from,
            },
            callParams.apiBase
          );
          break;
        }
        case "media":
          if (consentInProgress) break;
          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
          }
          break;
        case "stop":
          flushBotTranscript();
          void apiPost("webhook.php", { action: "call_completed", call_sid: callParams?.callSid }, callParams?.apiBase);
          if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
          closeElevenLabsStream();
          break;
      }
    } catch (e) {
      console.error("[Twilio]", e.message);
    }
  });

  twilioWs.on("close", () => {
    if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
    closeElevenLabsStream();
  });
});

server.listen(PORT, () => {
  console.log(
    `[BookForDay voice] v22 vad=${VAD_THRESHOLD}/${VAD_SILENCE_MS}ms eleven=${process.env.USE_ELEVENLABS === "0" ? "off" : "auto"} model=${REALTIME_MODEL} openai_env=${OPENAI_API_KEY ? "yes" : "no"} → ${API_BASE}`
  );
  void verifyApiAuth();
});
