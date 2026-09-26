/**
 * BookForDay — Twilio Media Streams → OpenAI Realtime (μ-law) → Twilio
 * Deploy on Render. Env: OPENAI_API_KEY, BOOKFOR_API_SECRET ( = voice_api_secret on PHP )
 */
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;
const API_BASE = (process.env.BOOKFOR_API_BASE || "https://bookforday.com/api/voice").replace(/\/$/, "");
const API_SECRET = (process.env.BOOKFOR_API_SECRET || "").trim();

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
      `[BookForDay] ${label}: 403 — voice_api_secret na PHP = BOOKFOR_API_SECRET na Render (len ${API_SECRET.length}). ${msg}`
    );
  }
}

async function verifyApiAuth() {
  if (!API_SECRET || API_SECRET.length < 16) {
    console.error("[BookForDay] BOOKFOR_API_SECRET missing or too short (min 16)");
    return;
  }
  const body = JSON.stringify({ ping: true });
  try {
    await axios.post(voiceApiUrl("ping.php"), body, { headers: apiHeaders(body), timeout: 15000 });
    console.log("[BookForDay] API auth OK →", API_BASE);
  } catch (err) {
    logApi403("API auth check", err);
    console.error("[BookForDay] API auth check failed:", err.message);
  }
}

async function fetchSessionConfig(params) {
  const base = (params.apiBase || API_BASE).replace(/\/$/, "");
  if (!base) {
    return { prompt: "", greeting: params.greeting || "", afterIntake: {} };
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
        afterIntake: data.after_intake || {},
        smsConfigured: !!data.sms_configured,
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
      "Dzień dobry, tu asystent BookForDay. Jakiej usługi szukasz?",
    afterIntake: { hangup_after_ms: 2500, hangup_call: true },
    smsConfigured: false,
  };
}

async function fetchOpenAICredential(apiBase) {
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
      validateStatus: (s) => s >= 200 && s < 500,
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
      "Wywołaj gdy masz komplet danych. ON_SITE (fryzjer itd.): usługa, miasto, date_wanted, time_from, time_to, service_delivery=on_site, location_scope=local. " +
      "REMOTE (strona WWW itd.): service_delivery=remote_ok, location_scope=online|local|both; dla online miasto puste; bez godzin.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "fryzjer, barber, kosmetyka, paznokcie, massage, groomer, inne" },
        service_needed: { type: "string" },
        service_delivery: { type: "string", enum: ["on_site", "remote_ok", "flexible"] },
        location_scope: { type: "string", enum: ["local", "online", "both"] },
        city: { type: "string" },
        district: { type: "string" },
        date_wanted: { type: "string" },
        time_from: { type: "string" },
        time_to: { type: "string" },
        datetime: { type: "string" },
        needs_today: { type: "boolean" },
        details: { type: "string" },
        original_request: { type: "string" },
      },
      required: ["category", "service_needed", "service_delivery", "location_scope", "needs_today"],
    },
  },
];

function buildCompleteIntakePayload(args, callParams) {
  return {
    action: "complete_intake",
    call_sid: callParams?.callSid,
    from_number: callParams?.from,
    fromNumber: callParams?.from,
    intake: {
      ...args,
      client_phone: callParams?.from,
    },
  };
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "bookforday-voice", v: 6 }));
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
  let intakeCompleted = false;
  let configLoaded = false;
  let openaiConnected = false;
  let sessionConfigured = false;
  let firstResponseSent = false;
  let vadAutoResponse = false;
  let hangupInProgress = false;
  const handledFunctionCalls = new Set();

  const sendTwilioAudio = (base64Pcmu) => {
    if (!streamSid || !base64Pcmu) return;
    twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64Pcmu } }));
  };

  const hangupDelayMs = () => callParams?.afterIntake?.hangup_after_ms || 2500;

  const endCall = async (reason) => {
    if (hangupInProgress) return;
    hangupInProgress = true;
    console.log("[BookForDay] endCall", reason, callParams?.callSid);

    if (callParams?.callSid) {
      const r = await apiPost(
        "webhook.php",
        { action: "hangup_call", call_sid: callParams.callSid },
        callParams.apiBase
      );
      if (r.status !== "ok") {
        console.warn("[BookForDay] hangup_call:", r.message || r);
      }
    }

    if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
      try {
        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      } catch (_) {}
    }

    setTimeout(() => {
      if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
      if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.close(1000, reason || "done");
      }
    }, 400);
  };

  const scheduleHangupAfterGoodbye = () => {
    const total = hangupDelayMs() + 2000;
    setTimeout(() => {
      void endCall("after_goodbye");
    }, total);
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
        "Jesteś asystentem BookForDay. Rozpoznaj usługę na miejscu vs zdalną. Potem complete_intake. Mów tylko po polsku.";
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
        "Jesteś asystentem BookForDay. Rozpoznaj usługę na miejscu vs zdalną. Potem complete_intake. Mów tylko po polsku.";
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
      "Dzień dobry, tu asystent BookForDay. Jakiej usługi szukasz?";
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
  let goodbyeResponseStarted = false;

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
      const payload = buildCompleteIntakePayload(args, callParams);
      result = await apiPost("webhook.php", payload, callParams?.apiBase);
      console.log("[BookForDay] complete_intake", JSON.stringify(result));

      if (result.status === "ok") {
        intakeCompleted = true;
        if (result.sms_warning) {
          console.warn("[BookForDay] SMS warning:", result.sms_warning);
        }
        if (result.sms_configured === false) {
          console.error("[BookForDay] SMS nie skonfigurowane na PHP (sms_fly_api_key)");
        }
      }
    }

    openaiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
      })
    );

    const okMsg =
      `${POLISH_RULES} Potwierdź po polsku, że szukasz firm w bazie i wyślesz SMS z numerami w ciągu ok. 10 minut. ` +
      "Powiedz „Do widzenia” i nic więcej. Nie wywołuj już funkcji.";
    const errMsg =
      `${POLISH_RULES} Backend zwrócił błąd: ${result.message || "brak danych"}. ` +
      "Dopytaj po polsku o brakujące pola (patrz service_delivery / location_scope). Nie kończ rozmowy.";

    goodbyeResponseStarted = intakeCompleted;
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: USE_ELEVENLABS ? ["text"] : ["audio"],
          instructions: intakeCompleted ? okMsg : errMsg,
        },
      })
    );

    if (intakeCompleted) {
      scheduleHangupAfterGoodbye();
    }
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

        if (
          intakeCompleted &&
          goodbyeResponseStarted &&
          data.type === "response.done" &&
          !responseHasFunctionCall(data.response) &&
          !hangupInProgress
        ) {
          scheduleHangupAfterGoodbye();
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
          goodbyeResponseStarted = false;
          hangupInProgress = false;
          handledFunctionCalls.clear();

          callParams = {
            prompt: "",
            greeting: custom.greeting || "",
            callSid: custom.callSid || data.start.callSid,
            callMode: custom.callMode || "intake",
            from: custom.fromNumber || data.start.from || "",
            to: custom.toNumber || data.start.to || "",
            apiBase: API_BASE,
            afterIntake: { hangup_after_ms: 2500 },
          };

          console.log("[BookForDay] call start", callParams.callSid, "from", callParams.from, "→", API_BASE);

          connectOpenAI(callParams.apiBase).catch((e) => {
            logApi403("realtime_credential", e);
            console.error("[BookForDay] OpenAI connect failed", e.message);
          });

          (async () => {
            const loaded = await fetchSessionConfig(callParams);
            callParams.prompt = loaded.prompt;
            if (loaded.greeting) callParams.greeting = loaded.greeting;
            callParams.afterIntake = loaded.afterIntake || callParams.afterIntake;
            if (!loaded.smsConfigured) {
              console.warn("[BookForDay] PHP: sms_fly nie skonfigurowane — SMS nie wyjdą");
            }
            configLoaded = true;
            tryStartSession();
          })().catch((e) => console.error("[BookForDay] config failed", e.message));

          void apiPost(
            "webhook.php",
            {
              action: "start_intake",
              call_sid: callParams.callSid,
              from_number: callParams.from,
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
          void apiPost(
            "webhook.php",
            { action: "call_completed", call_sid: callParams?.callSid },
            callParams?.apiBase
          );
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
  console.log(`[BookForDay voice] v6 on ${PORT} → ${API_BASE} (secret len ${API_SECRET.length})`);
  void verifyApiAuth();
});
