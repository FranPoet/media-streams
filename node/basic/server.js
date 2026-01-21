const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

// 1. Создаем HTTP сервер для обработки первичного запроса от Twilio
const server = http.createServer((req, res) => {
  // Этот путь вызывается, если ты укажешь его напрямую в Twilio, 
  // но в твоей схеме с Apache, Twilio сначала пойдет на PHP.
  if (req.url === "/voice") {
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`
      <Response>
        <Connect>
          <Stream url="wss://${req.headers.host}/media" />
        </Connect>
      </Response>
    `);
  } else {
    res.writeHead(200);
    res.end("Server is running");
  }
});

// 2. Создаем WebSocket сервер для работы с аудио-потоком
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("Twilio client connected");

  let streamSid = null;
  let instructions = "Ты живой голосовой ассистент. Отвечай коротко и естественно по-русски.";
  let voice = "alloy";

  // Подключаемся к OpenAI Realtime API
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Функция для настройки сессии (отправляем промт и настройки голоса)
  const sendSessionUpdate = () => {
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: instructions,
        voice: voice,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad", // ИИ сам поймет, когда юзер закончил говорить
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        },
      },
    };
    console.log("Sending session update with prompt:", instructions.substring(0, 50) + "...");
    openaiWs.send(JSON.stringify(sessionUpdate));
  };

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI");
    // Инициализируем сессию сразу, если промт уже есть, 
    // либо он обновится позже в событии 'start'
    sendSessionUpdate();
  });

  // ОБРАБОТКА СООБЩЕНИЙ ОТ TWILIO
  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      switch (data.event) {
       case "start":
    streamSid = data.start.streamSid;
    console.log("Stream started, ID:", streamSid);

    // ПРИЕМ ПАРАМЕТРОВ ОТ PHP
    if (data.start.customParameters) {
        // Мы берем prompt и voice, которые прислал PHP
        instructions = data.start.customParameters.prompt || instructions;
        voice = data.start.customParameters.voice || voice;
        
        // СРАЗУ обновляем сессию в OpenAI, чтобы он применил новые настройки
        if (openaiWs.readyState === WebSocket.OPEN) {
            sendSessionUpdate();
        }
    }
    break;

        case "media":
          // Пересылаем входящее аудио от пользователя в OpenAI
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload
            }));
          }
          break;

        case "stop":
          console.log("Call ended");
          openaiWs.close();
          break;
      }
    } catch (err) {
      console.error("Error parsing Twilio message:", err);
    }
  });

  // ОБРАБОТКА СООБЩЕНИЙ ОТ OPENAI
  openaiWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      // Получаем аудио-дельту от ИИ и отправляем в Twilio
      if (data.type === "response.audio.delta" && streamSid) {
        const audioPayload = {
          event: "media",
          streamSid: streamSid,
          media: {
            payload: data.delta
          }
        };
        twilioWs.send(JSON.stringify(audioPayload));
      }

      // Логируем ошибки от OpenAI если они есть
      if (data.type === "error") {
        console.error("OpenAI API Error:", data.error);
      }

    } catch (err) {
      console.error("Error parsing OpenAI message:", err);
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio connection closed");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WebSocket Error:", err);
  });
});

server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
