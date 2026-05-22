require("dotenv").config();

const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;

// =========================
// ELEVENLABS
// =========================

const ELEVENLABS_API_KEY =
process.env.ELEVENLABS_API_KEY;

const ELEVENLABS_VOICE_ID =
process.env.ELEVENLABS_VOICE_ID;

// =========================
// SERVER
// =========================

const server = http.createServer(
    (req, res) => {

        res.writeHead(200);

        res.end("AI Voice Agent Running");

    }
);

// =========================
// WEBSOCKET
// =========================

const wss =
new WebSocket.Server({

    server,

    path: "/media"

});

// =========================
// CONNECTION
// =========================

wss.on("connection", (twilioWs) => {

    console.log("[Twilio] Connected");

    let streamSid = null;

    let callParams = null;

    let currentCallSid = null;

    let openaiWs = null;

    let elevenLabsWs = null;

    let transcript = "";

    let isBotSpeaking = false;

    let botSpeechStartTime = 0;

    let city = "Lublin";

    // =========================
    // ELEVENLABS SETUP
    // =========================

    const setupElevenLabs =
    (initialText = " ") => {

        if (elevenLabsWs) {

            elevenLabsWs.close();
        }

        const url =

`wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=eleven_multilingual_v2&output_format=ulaw_8000`;

        elevenLabsWs = new WebSocket(
            url,
            {
                headers: {
                    "xi-api-key":
                    ELEVENLABS_API_KEY
                }
            }
        );

        elevenLabsWs.on(
            "open",
            () => {

                elevenLabsWs.send(

                    JSON.stringify({

                        text:
                        initialText,

                        voice_settings: {

                            stability: 0.5,

                            similarity_boost: 0.8
                        }

                    })
                );

                if (
                    initialText.trim()
                    !== ""
                ) {

                    elevenLabsWs.send(

                        JSON.stringify({

                            text: "",

                            flush: true

                        })
                    );
                }
            }
        );

        elevenLabsWs.on(
            "message",
            (data) => {

                try {

                    const msg =
                    JSON.parse(data);

                    if (

                        msg.audio

                        &&

                        streamSid

                    ) {

                        twilioWs.send(

                            JSON.stringify({

                                event:
                                "media",

                                streamSid:
                                streamSid,

                                media: {
                                    payload:
                                    msg.audio
                                }

                            })
                        );
                    }

                } catch (e) {}
            }
        );
    };

    // =========================
    // OPENAI
    // =========================

    openaiWs =
    new WebSocket(

        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",

        {
            headers: {

                Authorization:
                `Bearer ${process.env.OPENAI_API_KEY}`,

                "OpenAI-Beta":
                "realtime=v1"
            }
        }
    );

    // =========================
    // START SESSION
    // =========================

    const startSession = () => {

        if (
            !openaiWs
            ||
            openaiWs.readyState
            !== WebSocket.OPEN
        ) return;

        if (!callParams) return;

        const sessionConfig = {

            modalities: ["text"],

            instructions:
            callParams.prompt,

            input_audio_format:
            "g711_ulaw",

            input_audio_transcription: {
                model: "whisper-1"
            },

            turn_detection: {

                type: "server_vad",

                threshold: 0.8,

                prefix_padding_ms: 300,

                silence_duration_ms: 700
            }
        };

        openaiWs.send(

            JSON.stringify({

                type:
                "session.update",

                session:
                sessionConfig

            })
        );

        // greeting

        const greetingText =

        callParams.greeting
        ||
        "Dzień dobry.";

        const fakeAssistantMessage = {

            type:
            "conversation.item.create",

            item: {

                type:
                "message",

                role:
                "assistant",

                content: [

                    {

                        type:
                        "text",

                        text:
                        greetingText

                    }
                ]
            }
        };

        openaiWs.send(
            JSON.stringify(
                fakeAssistantMessage
            )
        );
    };

    // =========================
    // OPENAI OPEN
    // =========================

    openaiWs.on(
        "open",
        () => {

            if (
                callParams
            ) {

                startSession();
            }
        }
    );

    // =========================
    // TWILIO MESSAGE
    // =========================

    twilioWs.on(
        "message",
        async (msg) => {

            try {

                const data =
                JSON.parse(msg);

                switch (
                    data.event
                ) {

                    case "start":

                        streamSid =
                        data.start.streamSid;

                        const custom =
                        data.start
                        .customParameters;

                        if (custom) {

                            callParams = {

                                prompt:
                                custom.prompt,

                                greeting:
                                custom.greeting,

                                from:
                                custom.fromNumber,

                                to:
                                custom.toNumber,

                                callSid:
                                custom.callSid
                            };

                            currentCallSid =
                            custom.callSid;

                            const greeting =
                            callParams.greeting
                            ||
                            "Dzień dobry.";

                            setupElevenLabs(
                                greeting + " "
                            );

                            if (

                                openaiWs
                                .readyState

                                ===

                                WebSocket.OPEN

                            ) {

                                startSession();
                            }
                        }

                        break;

                    case "media":

                        if (

                            openaiWs
                            .readyState

                            ===

                            WebSocket.OPEN

                        ) {

                            openaiWs.send(

                                JSON.stringify({

                                    type:
                                    "input_audio_buffer.append",

                                    audio:
                                    data.media.payload

                                })
                            );
                        }

                        break;

                    case "stop":

                        console.log(
                            "Call ended"
                        );

                        if (

                            openaiWs
                            .readyState

                            ===

                            WebSocket.OPEN

                        ) {

                            openaiWs.close();
                        }

                        if (

                            elevenLabsWs

                            &&

                            elevenLabsWs
                            .readyState

                            ===

                            WebSocket.OPEN

                        ) {

                            elevenLabsWs.close();
                        }

                        break;
                }

            } catch (e) {

                console.log(
                    e.message
                );

            }
        }
    );

    // =========================
    // OPENAI MESSAGE
    // =========================

    openaiWs.on(
        "message",
        async (msg) => {

            try {

                const data =
                JSON.parse(msg);

                // =========================
                // RESPONSE START
                // =========================

                if (
                    data.type ===
                    "response.created"
                ) {

                    isBotSpeaking =
                    true;

                    botSpeechStartTime =
                    Date.now();
                }

                // =========================
                // TEXT DELTA
                // =========================

                if (
                    data.type ===
                    "response.text.delta"
                ) {

                    if (

                        elevenLabsWs

                        &&

                        elevenLabsWs
                        .readyState

                        ===

                        WebSocket.OPEN

                    ) {

                        elevenLabsWs.send(

                            JSON.stringify({

                                text:
                                data.delta

                            })
                        );
                    }
                }

                // =========================
                // RESPONSE DONE
                // =========================

                if (

                    data.type ===
                    "response.done"

                    ||

                    data.type ===
                    "response.cancel"

                ) {

                    isBotSpeaking =
                    false;

                    if (

                        elevenLabsWs

                        &&

                        elevenLabsWs
                        .readyState

                        ===

                        WebSocket.OPEN

                    ) {

                        elevenLabsWs.send(

                            JSON.stringify({

                                text: "",

                                flush: true

                            })
                        );
                    }
                }

                // =========================
                // INTERRUPTION
                // =========================

                if (

                    data.type ===
                    "input_audio_buffer.speech_started"

                ) {

                    const speakDuration =

                    Date.now()
                    -
                    botSpeechStartTime;

                    if (

                        !isBotSpeaking

                        ||

                        speakDuration > 5000

                    ) {

                        console.log(
                            "Interrupted"
                        );

                        if (streamSid) {

                            twilioWs.send(

                                JSON.stringify({

                                    event:
                                    "clear",

                                    streamSid:
                                    streamSid

                                })
                            );
                        }

                        openaiWs.send(

                            JSON.stringify({

                                type:
                                "response.cancel"

                            })
                        );

                        setupElevenLabs(
                            " "
                        );
                    }
                }

                // =========================
                // USER TRANSCRIPT
                // =========================

                if (

                    data.type ===

                    "conversation.item.input_audio_transcription.completed"

                ) {

                    const text =
                    data.transcript.trim();

                    console.log(
                        "USER:",
                        text
                    );

                    transcript +=
                    "USER: " +
                    text +
                    "\n";

                    const lower =
                    text.toLowerCase();

                    if (
                        lower.includes(
                            "lublin"
                        )
                    ) {

                        city =
                        "Lublin";
                    }
                }

                // =========================
                // AI TEXT
                // =========================

                if (
                    data.type ===
                    "response.text.done"
                ) {

                    const text =
                    data.text
                    ?
                    data.text.trim()
                    :
                    "";

                    console.log(
                        "AI:",
                        text
                    );

                    transcript +=
                    "AI: " +
                    text +
                    "\n";

                    // =========================
                    // SEARCH COMPANY
                    // =========================

                    if (

                        text
                        .toLowerCase()
                        .includes(
                            "oddzwonię"
                        )

                    ) {

                        console.log(
                            "Searching..."
                        );

                        const result =

                        await axios.get(

"https://i2.com.ua/ai/get_companies.php",

                            {
                                params: {

                                    category:
                                    "dentist",

                                    city:
                                    city
                                }
                            }
                        );

                        const companies =
                        result.data;

                        if (
                            companies.length
                            > 0
                        ) {

                            const best =
                            companies[0];

                            // SAVE LEAD

                            await axios.post(

"https://i2.com.ua/ai/save_lead.php",

                                {

                                    phone:
                                    callParams.from,

                                    transcript:
                                    transcript,

                                    company:
                                    best
                                }
                            );

                            // CALLBACK

                            await axios.get(

"https://i2.com.ua/ai/callback.php",

                                {
                                    params: {

                                        phone:
                                        callParams.from,

                                        company:
                                        JSON.stringify(
                                            best
                                        )
                                    }
                                }
                            );

                            console.log(
                                "Callback done"
                            );
                        }
                    }
                }

            } catch (e) {

                console.log(
                    e.message
                );

            }
        }
    );

    // =========================
    // CLOSE
    // =========================

    twilioWs.on(
        "close",
        () => {

            console.log(
                "Disconnected"
            );

            if (

                openaiWs
                .readyState

                ===

                WebSocket.OPEN

            ) {

                openaiWs.close();
            }

            if (

                elevenLabsWs

                &&

                elevenLabsWs
                .readyState

                ===

                WebSocket.OPEN

            ) {

                elevenLabsWs.close();
            }
        }
    );
});

// =========================
// START
// =========================

server.listen(
    PORT,
    () => {

        console.log(
            `Listening on ${PORT}`
        );

    }
);
