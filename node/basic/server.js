const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;

// Функция статистики (оставил как было)
function saveCallToDb(callSid, status, extraData = {}) {
  if (!callSid) return;
  const url = 'https://primarch.eu/update_stats.php'; 
  const payload = { call_sid: callSid, status: status, ...extraData };
  axios.post(url, payload)
    .then(() => { if (status !== 'transcript') console.log(`Stat updated: ${status}`); })
    .catch(err => console.error("DB Error:", err.message));
}

const server = http.createServer((req, res) => {
  if (req.url === "/voice") {
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`<Response><Connect><Stream url="wss://${req.headers.host}/media" /></Connect></Response>`);
  } else {
    res.writeHead(200).end("Server is ready");
  }
});

const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  let streamSid = null;
  let currentCallSid = null;
  
  // Хранилище для параметров из PHP (пока пусто)
  let callParams = null;
  let openaiWs = null;

  // 1. Открываем соединение с OpenAI
  openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Функция запуска (сработает только когда есть И сокет, И параметры от Twilio)
  const startSession = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (!callParams) return;

    console.log("Starting session with prompt from PHP...");

    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: callParams.prompt, // БЕРЕМ ИЗ PHP!
        voice: callParams.voice,         // БЕРЕМ ИЗ PHP!
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 }
      }
    };
    openaiWs.send(JSON.stringify(sessionUpdate));

    const initialGreeting = {
        type: "response.create",
        response: {
            modalities: ["text", "audio"],
            instructions: "Przywitaj się krótko, zgodnie z twoją rolą." // "Поздоровайся коротко согласно своей роли"
        }
    };
    openaiWs.send(JSON.stringify(initialGreeting));
  };

  openaiWs.on("open", () => {
    console.log("OpenAI connected. Waiting for Twilio params...");
    // Если параметры от Twilio пришли раньше, чем открылся сокет - запускаем
    if (callParams) startSession();
  });

  // Twilio Messages
  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          const custom = data.start.customParameters;
          
          if (custom) {
            // СОХРАНЯЕМ ПАРАМЕТРЫ, ПРИШЕДШИЕ ИЗ PHP
            callParams = {
                prompt: custom.prompt,
                voice: custom.voice,
                callSid: custom.callSid,
                from: custom.fromNumber,
                to: custom.toNumber
            };
            currentCallSid = custom.callSid;

            console.log(`Params received from PHP. Role: ${callParams.prompt.substring(0, 20)}...`);
            
            // Если сокет OpenAI уже открыт - запускаем сессию
            if (openaiWs.readyState === WebSocket.OPEN) startSession();

            // Пишем в БД
            saveCallToDb(currentCallSid, "started", { from_number: callParams.from, to_number: callParams.to });
          }
          break;

        case "media":
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload
            }));
          }
          break;

        case "stop":
          console.log("Call ended");
          saveCallToDb(currentCallSid, "completed");
          if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
          break;
      }
    } catch (e) { console.error(e); }
  });

  // OpenAI Messages
  openaiWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      
      // Аудио от бота
      if (data.type === "response.audio.delta" && streamSid) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid: streamSid,
          media: { payload: data.delta }
        }));
      }

      // Транскрипция (Юзер)
      if (data.type === "conversation.item.input_audio_transcription.completed") {
          const text = data.transcript.trim();
          if(text) saveCallToDb(currentCallSid, "transcript", { text: "User: " + text });
      }
      
      // Транскрипция (Бот)
      if (data.type === "response.audio_transcript.done") {
          const text = data.transcript.trim();
          if(text) saveCallToDb(currentCallSid, "transcript", { text: "AI: " + text });
      }

    } catch (e) { console.error(e); }
  });

  twilioWs.on("close", () => {
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

server.listen(PORT, () => console.log(`Listening on ${PORT}`));
