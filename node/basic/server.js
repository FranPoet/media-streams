const http = require("http");

const WebSocket = require("ws");

const axios = require("axios");



const PORT = process.env.PORT || 3000;



function saveCallToDb(callSid, status, extraData = {}) {

  if (!callSid) return;

  const url = 'https://primarch.eu/update_stats.php'; 

  const payload = { call_sid: callSid, status: status, ...extraData };

  axios.post(url, payload).catch(err => {});

}



// Функция API (теперь принимает номер ассистента)

async function makeBooking(assistantPhone, dateTime, note) {

    console.log(`[Booking] Request for assistant: ${assistantPhone}, time: ${dateTime}`);

    try {

        const response = await axios.post('https://primarch.eu/booking_api.php', {

            phone: assistantPhone, // <-- ВАЖНО: Номер врача/фирмы

            datetime: dateTime,

            note: note

        });

        console.log("[Booking] Response:", response.data);

        return response.data;

    } catch (error) {

        console.error("[Booking] API Error:", error.message);

        return { status: "error", message: "Błąd połączenia z bazą danych." };

    }

}



const toolsDefinition = [

  {

    type: "function",

    name: "book_appointment",

    description: "Rezerwuje wizytę w kalendarzu. Użyj tego, gdy klient potwierdzi datę i godzinę.",

    parameters: {

      type: "object",

      properties: {

        datetime: { type: "string", description: "Data i godzina w ISO 8601 (np. 2024-05-20 14:00:00)." },

        note: { type: "string", description: "Imię klienta lub cel wizyty." }

      },

      required: ["datetime"]

    }

  }

];



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



  openaiWs = new WebSocket(

    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",

    {

      headers: {

        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,

        "OpenAI-Beta": "realtime=v1",

      },

    }

  );



  const startSession = () => {

    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;

    if (!callParams) return;



    // 1. Конфигурация сессии

    const sessionConfig = {

      modalities: ["text", "audio"],

      instructions: callParams.prompt,

      voice: callParams.voice,

      input_audio_format: "g711_ulaw",

      output_audio_format: "g711_ulaw",

      input_audio_transcription: { model: "whisper-1" },

      turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 }

    };



    if (callParams.allowBooking == '1') {

        sessionConfig.tools = toolsDefinition;

        sessionConfig.tool_choice = "auto";

    }



    openaiWs.send(JSON.stringify({ type: "session.update", session: sessionConfig }));



    // 2. ИСПРАВЛЕННОЕ ПРИВЕТСТВИЕ

    // Мы говорим AI: "Пожалуйста, скажи эту фразу дословно".

    const greetingText = callParams.greeting || "Halo?";

    const initialGreeting = {

        type: "response.create",

        response: {

            modalities: ["text", "audio"],

            instructions: `Please say this exact phrase verbatim: "${greetingText}"`

        }

    };

    openaiWs.send(JSON.stringify(initialGreeting));

  };



  openaiWs.on("open", () => {

    console.log("[OpenAI] Connected");

    if (callParams) startSession();

  });



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

                // Вот новый параметр - номер ассистента для бронирования

                assistantPhone: custom.assistantPhone || custom.toNumber, 

                allowBooking: custom.allowBooking,

                from: custom.fromNumber,

                to: custom.toNumber

            };

            currentCallSid = custom.callSid;

            

            console.log(`[Init] Role found for assistant: ${callParams.assistantPhone}`);

            

            if (openaiWs.readyState === WebSocket.OPEN) startSession();

            saveCallToDb(currentCallSid, "started", { from_number: callParams.from, to_number: callParams.to });

          }

          break;

        case "media":

          if (openaiWs.readyState === WebSocket.OPEN) {

            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));

          }

          break;

        case "stop":

          saveCallToDb(currentCallSid, "completed");

          if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();

          break;

      }

    } catch (e) { }

  });



  openaiWs.on("message", async (msg) => {

    try {

      const data = JSON.parse(msg);



      if (data.type === "response.audio.delta" && streamSid) {

        twilioWs.send(JSON.stringify({ event: "media", streamSid: streamSid, media: { payload: data.delta } }));

      }



      // === ЛОГИКА ВЫЗОВА ИНСТРУМЕНТА ===

      if (data.type === "response.function_call_arguments.done") {

          console.log("[Tool] AI Calling:", data.name);

          

          if (data.name === "book_appointment") {

              const args = JSON.parse(data.arguments);

              

              // Используем assistantPhone для записи в правильный календарь

              const result = await makeBooking(callParams.assistantPhone, args.datetime, args.note);

              

              const toolOutput = {

                  type: "conversation.item.create",

                  item: {

                      type: "function_call_output",

                      call_id: data.call_id, 

                      output: JSON.stringify(result) 

                  }

              };

              openaiWs.send(JSON.stringify(toolOutput));

              openaiWs.send(JSON.stringify({type: "response.create"}));

          }

      }



      if (data.type === "conversation.item.input_audio_transcription.completed") {

        const text = data.transcript.trim();

        if(text) saveCallToDb(currentCallSid, "transcript", { text: "User: " + text });

      }

      if (data.type === "response.audio_transcript.done") {

        const text = data.transcript.trim();

        if(text) saveCallToDb(currentCallSid, "transcript", { text: "AI: " + text });

      }



    } catch (e) { }

  });



  twilioWs.on("close", () => {

    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();

  });

});



server.listen(PORT, () => console.log(`Listening on ${PORT}`));
