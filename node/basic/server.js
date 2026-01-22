const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;

// Function to save call statistics and transcripts to the database via PHP
function saveCallToDb(callSid, status, extraData = {}) {
  if (!callSid) return;
  
  const url = 'https://primarch.eu/update_stats.php'; 
  
  const payload = {
    call_sid: callSid,
    status: status,
    ...extraData
  };
  
  axios.post(url, payload)
  .then(() => {
    if (status !== 'transcript') console.log(`Stat updated: ${status} for ${callSid}`);
  })
  .catch(err => console.error("DB Stat Error:", err.message));
}

// 1. Create HTTP server
const server = http.createServer((req, res) => {
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

// 2. Create WebSocket server
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("Twilio client connected");

  let streamSid = null;
  let currentCallSid = null;
  
  // Storage for parameters passed from PHP via Twilio
  let callParams = null;
  let openaiWs = null;

  // 1. Open connection to OpenAI Realtime API
  openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Function to initialize the session (runs only when both OpenAI matches and Twilio params are present)
  const startSession = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (!callParams) return;

    console.log("Starting session with prompt from PHP...");

    // A. Send session configuration (Prompt and Voice from PHP)
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: callParams.prompt, // Prompt from DB/PHP
        voice: callParams.voice,         // Voice from DB/PHP
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: {
            model: "whisper-1"
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        },
      },
    };
    openaiWs.send(JSON.stringify(sessionUpdate));

    // B. Trigger the greeting (Specific text from PHP)
    const greetingText = callParams.greeting || "Dzień dobry, w czym mogę pomóc?";
    
    const initialGreeting = {
        type: "response.create",
        response: {
            modalities: ["text", "audio"],
            instructions: greetingText // Use the specific greeting text
        }
    };
    openaiWs.send(JSON.stringify(initialGreeting));
  };

  openaiWs.on("open", () => {
    console.log("OpenAI connected. Waiting for Twilio params...");
    // If Twilio params arrived before OpenAI connected, start now
    if (callParams) startSession();
  });

  // HANDLE TWILIO MESSAGES
  twilioWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          const customParams = data.start.customParameters;
          
          if (customParams) {
            // Extract parameters sent from PHP
            callParams = {
                prompt: customParams.prompt,
                voice: customParams.voice,
                greeting: customParams.greeting, // <--- IMPORTANT: Capture greeting
                callSid: customParams.callSid,
                fromNumber: customParams.fromNumber || 'unknown',
                toNumber: customParams.toNumber || 'unknown'
            };
            currentCallSid = callParams.callSid;

            console.log(`Params received. To: ${callParams.toNumber}, Voice: ${callParams.voice}`);

            // If OpenAI is already open, start the session
            if (openaiWs.readyState === WebSocket.OPEN) {
                startSession();
            }
            
            // Log call start to DB
            saveCallToDb(currentCallSid, "started", { 
                from_number: callParams.fromNumber, 
                to_number: callParams.toNumber 
            });
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
          console.log("Call ended:", currentCallSid);
          saveCallToDb(currentCallSid, "completed");
          if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
          break;
      }
    } catch (err) {
      console.error("Error parsing Twilio message:", err);
    }
  });

  // HANDLE OPENAI MESSAGES
  openaiWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      // 1. Send audio delta to Twilio
      if (data.type === "response.audio.delta" && streamSid) {
        twilioWs.send(JSON.stringify({
          event: "media",
          streamSid: streamSid,
          media: { payload: data.delta }
        }));
      }

      // 2. Transcribe User input
      if (data.type === "conversation.item.input_audio_transcription.completed") {
          const userText = data.transcript.trim();
          if (userText) {
            console.log("User:", userText);
            saveCallToDb(currentCallSid, "transcript", { text: "User: " + userText });
          }
      }

      // 3. Transcribe AI response
      if (data.type === "response.audio_transcript.done") {
          const aiText = data.transcript.trim();
          if (aiText) {
            console.log("AI:", aiText);
            saveCallToDb(currentCallSid, "transcript", { text: "AI: " + aiText });
          }
      }

      if (data.type === "error") {
        console.error("OpenAI API Error:", data.error);
      }
    } catch (err) {
      console.error("Error parsing OpenAI message:", err);
    }
  });

  twilioWs.on("close", () => {
    if (openaiWs.readyState === WebSocket.OPEN) {
      saveCallToDb(currentCallSid, "completed");
      openaiWs.close();
    }
  });

  openaiWs.on("error", (err) => console.error("OpenAI WebSocket Error:", err));
});

server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
