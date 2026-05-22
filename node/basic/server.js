/**
 * Stenor.pl — голосовий сервер для Render
 * Twilio Media Streams → OpenAI Realtime (текст) → ElevenLabs TTS → Twilio
 *
 * Змінні середовища на Render:
 *   OPENAI_API_KEY — НЕ потрібен (ключ лише в stenor.pl/config.php → api/realtime_token.php)
 *   ELEVENLABS_API_KEY — на Render або fallback у коді
 *   ELEVENLABS_VOICE_ID
 *   STENOR_API_BASE     — https://stenor.pl/api  (корінь домену)
 *   STENOR_API_SECRET   — = api_secret з stenor.pl/config.php
 *   PORT=3000
 */
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;
const API_BASE = (process.env.STENOR_API_BASE || "").replace(/\/$/, "");
const API_SECRET = process.env.STENOR_API_SECRET || "";
// Опційно на Render; за замовчуванням токен береться з https://stenor.pl/api/realtime_token.php
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ELEVENLABS_API_KEY =
  process.env.ELEVENLABS_API_KEY || "sk_499fda9e2d79d9ceba6357d176f52612252cc965bc4473d9";
const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "EmspiS7CSUabPeqBcrAP";
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

function signBody(body) {
  return crypto.createHmac("sha256", API_SECRET).update(body).digest("hex");
}

async function fetchSessionConfig(params) {
  const base = (params.apiBase || API_BASE).replace(/\/$/, "");
  if (!base) {
    console.error("[Stenor] apiBase missing for session_config");
    return { prompt: "", greeting: params.greeting || "" };
  }
  const body = JSON.stringify({
    job_id: params.jobId || "",
    mode: params.callMode || "intake",
    provider_idx: parseInt(params.providerIdx || params.clinicIdx || "0", 10),
    call_sid: params.callSid || "",
  });
  const headers = { "Content-Type": "application/json" };
  if (API_SECRET.length >= 32) {
    headers["X-Stenor-Signature"] = signBody(body);
  }
  try {
    const { data } = await axios.post(`${base}/session_config.php`, body, {
      headers,
      timeout: 15000,
    });
    if (data.status === "ok") {
      return { prompt: data.prompt || "", greeting: data.greeting || params.greeting };
    }
    console.error("[Stenor] session_config:", data.message || data.status);
  } catch (err) {
    console.error("[Stenor] session_config fetch:", err.message, err.response?.status);
    remoteLog("ERROR", "session_config fetch failed", {
      error: err.message,
      status: err.response?.status,
      base,
    }, base);
  }
  return {
    prompt: "",
    greeting: params.greeting || "Доброго дня. Що саме вам потрібно?",
  };
}

async function fetchRealtimeToken(apiBase) {
  const base = (apiBase || API_BASE).replace(/\/$/, "");
  if (!base) {
    throw new Error("apiBase missing for realtime_token");
  }
  const body = JSON.stringify({ model: REALTIME_MODEL });
  const headers = { "Content-Type": "application/json" };
  if (API_SECRET.length >= 32) {
    headers["X-Stenor-Signature"] = signBody(body);
  }
  const { data } = await axios.post(`${base}/realtime_token.php`, body, {
    headers,
    timeout: 20000,
  });
  if (data.status === "ok" && data.client_secret) {
    return data.client_secret;
  }
  throw new Error(data.message || "realtime_token failed");
}

async function getOpenAICredential(apiBase) {
  if (OPENAI_API_KEY) {
    return OPENAI_API_KEY;
  }
  return fetchRealtimeToken(apiBase);
}

async function remoteLog(level, message, context = {}, apiBase) {
  const base = (apiBase || API_BASE || "").replace(/\/$/, "");
  if (!base) {
    console.log(`[Stenor][${level}]`, message, context);
    return;
  }
  const body = JSON.stringify({
    level,
    message,
    context,
    source: "render",
  });
  const headers = { "Content-Type": "application/json" };
  if (API_SECRET.length >= 32) {
    headers["X-Stenor-Signature"] = signBody(body);
  }
  try {
    await axios.post(`${base}/log.php`, body, { headers, timeout: 8000 });
  } catch (e) {
    const status = e.response?.status;
    console.log(`[Stenor][${level}]`, message, context, e.message, status || "");
    if (status === 403) {
      console.error(
        "[Stenor] log.php 403 — на Render задайте STENOR_API_SECRET = api_secret з config.php"
      );
    }
  }
}

async function apiPost(path, payload, apiBaseOverride) {
  const base = (apiBaseOverride || callParams?.apiBase || API_BASE || "").replace(/\/$/, "");
  if (!base) {
    console.error("[Stenor] STENOR_API_BASE missing");
    console.error("[Stenor] API base missing", path);
    return { status: "error", message: "API base not configured" };
  }
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (API_SECRET.length >= 32) {
    headers["X-Stenor-Signature"] = signBody(body);
  }
  try {
    const { data } = await axios.post(`${base}/${path}`, body, {
      headers,
      timeout: 20000,
    });
    return data;
  } catch (err) {
    const status = err.response?.status;
    console.error("[Stenor API]", path, err.message, status || "");
    remoteLog("ERROR", `API ${path} failed`, {
      path,
      error: err.message,
      http_status: status,
    }, base).catch(() => {});
    return { status: "error", message: err.message, http_status: status };
  }
}

function saveCall(callSid, status, extra = {}) {
  if (!callSid) return;
  apiPost("update_stats.php", { call_sid: callSid, status, ...extra }).catch(() => {});
}

const toolsIntake = [
  {
    type: "function",
    name: "complete_intake",
    description:
      "Завершити збір даних після фрази «шукаю найкращий варіант». category — технічний id сфери з промпту.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "id сфери зі списку Stenor (stomatologia, kosmetologia, fryzjer тощо)",
        },
        city: { type: "string" },
        service_needed: { type: "string", description: "Що потрібно клієнту" },
        needs_today: { type: "boolean" },
        details: { type: "string", description: "Деталі запиту" },
        original_request: { type: "string", description: "Слова клієнта коротко" },
        max_price: { type: "number" },
        client_name: { type: "string" },
      },
      required: ["category", "city", "service_needed", "needs_today", "details"],
    },
  },
  {
    type: "function",
    name: "hangup_call",
    description: "Завершити дзвінок ТІЛЬКИ після complete_intake або відмови клієнту. Не викликай на початку розмови.",
    parameters: { type: "object", properties: {} },
  },
];

const toolsProvider = [
  {
    type: "function",
    name: "save_provider_result",
    description: "Зберегти відповідь закладу (Stenor).",
    parameters: {
      type: "object",
      properties: {
        provider_id: { type: "integer" },
        provider_name: { type: "string" },
        available: { type: "boolean" },
        price: { type: "number" },
        datetime: { type: "string" },
        address: { type: "string" },
        notes: { type: "string" },
        partnership_ok: { type: "boolean" },
      },
      required: ["provider_id", "provider_name", "available"],
    },
  },
  { type: "function", name: "hangup_call", description: "Завершити дзвінок.", parameters: { type: "object", properties: {} } },
];

const toolsClient = [
  {
    type: "function",
    name: "save_client_choice",
    description: "Вибір клієнта: accepted, rejected, alternative_2, alternative_3",
    parameters: {
      type: "object",
      properties: {
        choice: { type: "string", enum: ["accepted", "rejected", "alternative_2", "alternative_3"] },
        comment: { type: "string" },
      },
      required: ["choice"],
    },
  },
  { type: "function", name: "hangup_call", description: "Завершити дзвінок.", parameters: { type: "object", properties: {} } },
];

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "stenor" }));
    return;
  }
  if (req.url === "/voice") {
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(
      `<Response><Connect><Stream url="wss://${req.headers.host}/media" /></Connect></Response>`
    );
    return;
  }
  res.writeHead(200).end("Stenor server ready");
});

const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("[Stenor] Twilio connected");

  let streamSid = null;
  let currentCallSid = null;
  let callParams = null;
  let openaiWs = null;
  let elevenLabsWs = null;
  let pendingHangup = false;
  let sessionReady = false;

  const setupElevenLabs = (initialText = " ") => {
    if (elevenLabsWs) elevenLabsWs.close();

    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=eleven_multilingual_v2&output_format=ulaw_8000`;

    elevenLabsWs = new WebSocket(url, {
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
    });

    elevenLabsWs.on("open", () => {
      elevenLabsWs.send(
        JSON.stringify({
          text: initialText,
          voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        })
      );
      if (initialText.trim() !== "") {
        elevenLabsWs.send(JSON.stringify({ text: "", flush: true }));
      }
    });

    elevenLabsWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.audio && streamSid) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: msg.audio },
            })
          );
        }
      } catch (e) {}
    });

    elevenLabsWs.on("error", (err) =>
      console.error("[ElevenLabs]", err.message)
    );
  };

  const getTools = () => {
    const mode = callParams?.callMode || "intake";
    if (mode === "provider" || mode === "clinic") return toolsProvider;
    if (mode === "client") return toolsClient;
    return toolsIntake;
  };

  const startSession = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN || !callParams) return;

    const instructions = (callParams.prompt || "").trim();
    if (instructions.length < 80) {
      console.error("[Stenor] Prompt empty — check STENOR_API_BASE and session_config.php");
      remoteLog("ERROR", "Prompt empty at startSession", {
        job_id: callParams.jobId,
        api_base: callParams.apiBase,
      }, callParams.apiBase);
      callParams.prompt =
        "Ти Stenor. Говори українською. Привітайся і запитай, чим допомогти. Не кажи goodbye. Не завершуй дзвінок.";
    } else {
      remoteLog("INFO", "OpenAI session starting", {
        job_id: callParams.jobId,
        prompt_len: instructions.length,
      }, callParams.apiBase);
    }

    const sessionConfig = {
      type: "realtime",
      instructions: callParams.prompt,
      output_modalities: ["text"],
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: { model: "whisper-1", language: "uk" },
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
    };

    if (callParams.allowBooking === "1") {
      sessionConfig.tools = getTools();
      sessionConfig.tool_choice = "auto";
    }

    openaiWs.send(JSON.stringify({ type: "session.update", session: sessionConfig }));

    const greetingText = callParams.greeting || " ";
    if (greetingText.trim()) {
      openaiWs.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: greetingText }],
          },
        })
      );
    }
  };

  const tryStartSession = () => {
    if (sessionReady && callParams && openaiWs?.readyState === WebSocket.OPEN) {
      startSession();
    }
  };

  const bindOpenAIHandlers = (ws) => {
    ws.on("open", () => tryStartSession());

    ws.on("error", (err) => {
      console.error("[OpenAI] WS error:", err.message);
      remoteLog("ERROR", "OpenAI WebSocket error", { error: err.message }, callParams?.apiBase);
      setupElevenLabs(
        "Вибачте, голосовий сервіс тимчасово недоступний. Спробуйте зателефонувати пізніше."
      );
    });

    ws.on("close", (code, reason) => {
      remoteLog("WARN", "OpenAI WebSocket closed", {
        code,
        reason: reason?.toString?.() || "",
      }, callParams?.apiBase);
    });

    ws.on("message", onOpenAIMessage);
  };

  const connectOpenAI = async (apiBase) => {
    const credential = await getOpenAICredential(apiBase);
    remoteLog("INFO", "OpenAI credential ready", {
      source: OPENAI_API_KEY ? "render_env" : "stenor_realtime_token",
    }, apiBase);
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
      {
        headers: {
          Authorization: `Bearer ${credential}`,
        },
      }
    );
    openaiWs = ws;
    bindOpenAIHandlers(ws);
    return ws;
  };

  const doHangup = () => {
    pendingHangup = true;
    setTimeout(() => {
      if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      setTimeout(() => twilioWs.close(), 1500);
    }, 800);
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
            voice: custom.voice,
            greeting: custom.greeting || "Доброго дня. Що саме вам потрібно?",
            callSid: custom.callSid,
            jobId: custom.jobId || "",
            callMode: custom.callMode || "intake",
            providerIdx: custom.providerIdx || custom.clinicIdx || "0",
            allowBooking: custom.allowBooking || "1",
            bookingType: custom.bookingType || "intake",
            from: custom.fromNumber,
            to: custom.toNumber,
            apiBase: custom.apiBase || API_BASE,
          };
          currentCallSid = custom.callSid;

          remoteLog("INFO", "Twilio stream start", {
            call_sid: currentCallSid,
            job_id: callParams.jobId,
            api_base: callParams.apiBase,
            openai_via: OPENAI_API_KEY ? "render_env" : "stenor_token",
          }, callParams.apiBase);

          (async () => {
            const loaded = await fetchSessionConfig(callParams);
            callParams.prompt = loaded.prompt;
            if (loaded.greeting) callParams.greeting = loaded.greeting;

            remoteLog("INFO", "session_config loaded", {
              prompt_len: (callParams.prompt || "").length,
              greeting: (callParams.greeting || "").slice(0, 80),
            }, callParams.apiBase);

            try {
              await connectOpenAI(callParams.apiBase);
            } catch (e) {
              console.error("[Stenor] OpenAI connect failed:", e.message);
              remoteLog("ERROR", "OpenAI connect failed", {
                error: e.message,
                http_status: e.response?.status,
              }, callParams.apiBase);
              setupElevenLabs(
                "Вибачте, голосовий сервіс тимчасово недоступний. Спробуйте пізніше."
              );
              return;
            }

            const greetingToSay = (callParams.greeting || "").trim() || " ";
            setupElevenLabs(greetingToSay + " ");

            if (callParams.callMode === "intake") {
              const wh = await apiPost("webhook.php", {
                action: "start_intake",
                job_id: callParams.jobId || "",
                client_phone: callParams.from,
                call_sid: currentCallSid,
              });
              remoteLog("INFO", "start_intake response", wh, callParams.apiBase);
            }

            sessionReady = true;
            tryStartSession();
          })().catch((e) => {
            remoteLog("ERROR", "stream start async failed", { error: e.message }, callParams?.apiBase);
          });

          saveCall(currentCallSid, "started", {
            job_id: callParams.jobId,
            from_number: callParams.from,
            to_number: callParams.to,
            mode: callParams.callMode,
          });
          break;
        }
        case "media":
          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              })
            );
          }
          break;
        case "stop":
          saveCall(currentCallSid, "completed", { job_id: callParams?.jobId });
          apiPost("webhook.php", {
            action: "call_completed",
            job_id: callParams?.jobId,
            call_sid: currentCallSid,
          });
          if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
          if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
          break;
      }
    } catch (e) {}
  });

  let isBotSpeaking = false;
  let botSpeechStartTime = 0;

  const onOpenAIMessage = async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.type === "response.created") {
        isBotSpeaking = true;
        botSpeechStartTime = Date.now();
      }

      const textDeltaType =
        data.type === "response.output_text.delta" || data.type === "response.text.delta";
      if (textDeltaType && data.delta) {
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.send(JSON.stringify({ text: data.delta }));
        }
      }

      if (
        data.type === "response.done" ||
        data.type === "response.completed" ||
        data.type === "response.cancel"
      ) {
        isBotSpeaking = false;
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.send(JSON.stringify({ text: "", flush: true }));
        }
        if (pendingHangup) doHangup();
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
        console.log("[Tool]", data.name);
        let result = { status: "ok" };
        const args = data.arguments ? JSON.parse(data.arguments) : {};
        const jobId = callParams?.jobId || "";

        if (data.name === "complete_intake") {
          result = await apiPost("webhook.php", {
            action: "complete_intake",
            job_id: jobId,
            intake: {
              ...args,
              client_phone: callParams?.from,
            },
          });
          if (result.status === "forbidden") pendingHangup = true;
          else pendingHangup = true;
        } else if (
          data.name === "save_provider_result" ||
          data.name === "save_clinic_result"
        ) {
          const pid =
            args.provider_id ||
            args.clinic_id ||
            parseInt(callParams?.providerIdx || callParams?.clinicIdx, 10) + 1;
          result = await apiPost("webhook.php", {
            action: "save_provider_result",
            job_id: jobId,
            result: {
              ...args,
              provider_id: pid,
              provider_name: args.provider_name || args.clinic_name,
            },
          });
          pendingHangup = true;
        } else if (data.name === "save_client_choice") {
          result = await apiPost("webhook.php", {
            action: "save_client_choice",
            job_id: jobId,
            choice: args.choice,
            comment: args.comment || "",
          });
          pendingHangup = true;
        } else if (data.name === "hangup_call") {
          result = { status: "ok", message: "Hanging up" };
          pendingHangup = true;
        }

        openaiWs.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: data.call_id,
              output: JSON.stringify(result),
            },
          })
        );
        openaiWs.send(
          JSON.stringify({
            type: "response.create",
            response: { output_modalities: ["text"] },
          })
        );
      }

      if (data.type === "error") {
        remoteLog("ERROR", "OpenAI realtime error event", {
          error: data.error || data,
        }, callParams?.apiBase);
      }

      if (data.type === "conversation.item.input_audio_transcription.completed") {
        const text = (data.transcript || "").trim();
        if (text) {
          saveCall(currentCallSid, "transcript", {
            job_id: callParams?.jobId,
            text: "User: " + text,
          });
        }
      }

      if (data.type === "response.text.done" || data.type === "response.output_text.done") {
        const text = (data.text || "").trim();
        if (text) {
          saveCall(currentCallSid, "transcript", {
            job_id: callParams?.jobId,
            text: "AI: " + text,
          });
        }
      }
    } catch (e) {
      console.error("[OpenAI handler]", e.message);
    }
  };

  twilioWs.on("close", () => {
    remoteLog("INFO", "Twilio stream closed", { call_sid: currentCallSid }, callParams?.apiBase);
    if (openaiWs?.readyState === WebSocket.OPEN) openaiWs.close();
    if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
  });
});

server.listen(PORT, () => {
  console.log(`[Stenor] Listening on ${PORT}`);
  if (!API_BASE) {
    console.warn("[Stenor] Set STENOR_API_BASE=https://stenor.pl/api on Render");
  } else if (!OPENAI_API_KEY) {
    console.log("[Stenor] OpenAI: ключ у config.php → realtime_token.php (OPENAI_API_KEY на Render не потрібен)");
  }
  console.log("[Stenor] Logs → stenor.pl/api/log.php → logs.php?key=...");
});
