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
// Mini Realtime (OpenAI): gpt-realtime-mini lub gpt-realtime-2.1-mini — ustaw OPENAI_REALTIME_MODEL na Render.
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-mini";
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "marin";

const POLISH_RULES =
  "Tylko polski. Jedna krótka wypowiedź na turę (zwykle jedno pytanie). " +
  "Bez dygresji, bez powtarzania klienta, bez wyjaśniania systemu. " +
  "Pożegnanie wyłącznie: „Do widzenia” lub „Do usłyszenia” na końcu rozmowy. Zakaz angielskiego. " +
  "Off-topic: jedno zdanie „Wróćmy do usługi…” i od razu pytanie z algorytmu.";

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
    "User-Agent": "BookForDay-Voice/12 (Render; bookforday.com)",
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
    res.end(JSON.stringify({ ok: true, service: "bookforday-voice", v: 12, model: REALTIME_MODEL }));
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
  let hangupInProgress = false;
  let hangupAfterMs = 12000;
  let lastBotAudioAt = 0;
  let awaitingFarewellSpeech = false;
  let farewellPending = false;
  let farewellTranscript = "";
  let goodbyeHangupRetries = 0;
  let goodbyePollTimer = null;
  const handledFunctionCalls = new Set();
  const GOODBYE_RE = /do\s+(widzenia|usłyszenia|uslyszenia)/i;

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
              output_modalities: USE_ELEVENLABS ? ["text"] : ["audio"],
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
      if (elevenLabsWs?.readyState === WebSocket.OPEN) elevenLabsWs.close();
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, reason || "done");
    }, 600);
  };

  const turnDetection = (createResponse) => ({
    type: "server_vad",
    threshold: 0.92,
    prefix_padding_ms: 500,
    silence_duration_ms: 1500,
    create_response: createResponse,
    interrupt_response: false,
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
        "BookForDay. Algorytm: usługa → typ (salon vs online) → brakujące pola → complete_intake. Krótko, po polsku.";
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
        "BookForDay. Algorytm: usługa → typ (salon vs online) → brakujące pola → complete_intake. Krótko, po polsku.";
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
      "Dzień dobry, BookForDay. Jakiej usługi szukasz?";
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: USE_ELEVENLABS ? ["text"] : ["audio"],
          instructions:
            `${POLISH_RULES} To pierwsze zdanie rozmowy. Powiedz DOKŁADNIE (nic więcej): „${greeting}” ` +
            "Nie dodawaj miasta ani terminu. Nie kończ rozmowy. Nie wywołuj complete_intake.",
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
                    threshold: 0.92,
                    prefix_padding_ms: 400,
                    silence_duration_ms: 1200,
                    create_response: false,
                    interrupt_response: false,
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
        : `${POLISH_RULES} Ostatnia wypowiedź rozmowy. Powiedz po polsku, wyraźnie i w całości: „Sprawdzam firmy. W około dziesięć minut dostaniesz SMS z numerami. Do widzenia.” albo zakończ „Do usłyszenia.” Koniec. Bez funkcji.`;
    if (intakeCompleted) {
      farewellPending = true;
    }
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: USE_ELEVENLABS ? ["text"] : ["audio"],
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
        if (farewellPending && intakeCompleted) {
          farewellPending = false;
          awaitingFarewellSpeech = true;
          farewellTranscript = "";
        }
      }

      if (data.type === "response.output_audio.delta" && data.delta) {
        lastBotAudioAt = Date.now();
        sendTwilioAudio(data.delta);
      }

      if (
        awaitingFarewellSpeech &&
        data.delta &&
        (data.type === "response.output_audio_transcript.delta" ||
          data.type === "response.audio_transcript.delta")
      ) {
        appendFarewellTranscript(data.delta);
      }

      const textDelta = data.type === "response.output_text.delta" || data.type === "response.text.delta";
      if (textDelta && data.delta) {
        appendFarewellTranscript(data.delta);
        if (USE_ELEVENLABS && elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.send(JSON.stringify({ text: data.delta }));
        }
      }

      if (data.type === "response.done" || data.type === "response.completed" || data.type === "response.cancelled") {
        isBotSpeaking = false;

        let hadFunctionCallThisTurn = false;
        if (data.type === "response.done" && Array.isArray(data.response?.output)) {
          for (const item of data.response.output) {
            if (item.type === "function_call" && item.call_id) {
              hadFunctionCallThisTurn = true;
              await handleFunctionCall(item.name, item.arguments, item.call_id);
            }
          }
        }

        if (firstResponseSent && !vadAutoResponse && !intakeCompleted) {
          enableVadResponses();
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

      if (data.type === "input_audio_buffer.speech_started") {
        // Asystent nie może być przerywany — ignoruj mowę klienta w trakcie odpowiedzi bota.
        if (isBotSpeaking || awaitingFarewellSpeech || intakeCompleted) {
          return;
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

          console.log("[BookForDay] call start", callParams.callSid, "from", callParams.from, "→", API_BASE);

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
  console.log(`[BookForDay voice] v12 model=${REALTIME_MODEL} → ${API_BASE} (secret len ${API_SECRET.length})`);
  void verifyApiAuth();
});
