require("dotenv").config();

const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {

    res.writeHead(200);
    res.end("AI Voice Agent Running");

});

const wss = new WebSocket.Server({
    server,
    path: "/media"
});

wss.on("connection", (twilioWs) => {

    console.log("Twilio connected");

    let streamSid = null;

    let callParams = {};

    let transcript = "";

    let city = "Lublin";

    let isSpeaking = false;

    const openaiWs = new WebSocket(
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
    // OPENAI CONNECT
    // =========================

    openaiWs.on("open", () => {

        console.log("OpenAI connected");

        const session = {

            type: "session.update",

            session: {

                modalities: ["audio"],

                voice: "alloy",

                input_audio_format: "g711_ulaw",

                output_audio_format: "g711_ulaw",

                input_audio_transcription: {
                    model: "whisper-1"
                },

                turn_detection: {
                    type: "server_vad",
                    threshold: 0.8,
                    silence_duration_ms: 500,
                    prefix_padding_ms: 300,
                    create_response: true
                },

                instructions:
                    callParams.prompt
            }
        };

        openaiWs.send(
            JSON.stringify(session)
        );

        // START GREETING

        setTimeout(() => {

            openaiWs.send(JSON.stringify({

                type: "response.create",

                response: {

                    modalities: ["audio"],

                    instructions:
                        "Привітайся словами: " +
                        callParams.greeting
                }

            }));

        }, 1000);

    });

    // =========================
    // TWILIO EVENTS
    // =========================

    twilioWs.on("message", async (msg) => {

        try {

            const data =
                JSON.parse(msg);

            switch (data.event) {

                case "start":

                    streamSid =
                        data.start.streamSid;

                    callParams = {

                        prompt:
                            data.start
                                .customParameters
                                .prompt,

                        greeting:
                            data.start
                                .customParameters
                                .greeting,

                        from:
                            data.start
                                .customParameters
                                .fromNumber
                    };

                    console.log(
                        "Call started"
                    );

                    break;

                case "media":

                    if (
                        openaiWs.readyState
                        === WebSocket.OPEN
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
                        openaiWs.readyState
                        === WebSocket.OPEN
                    ) {

                        openaiWs.close();
                    }

                    break;
            }

        } catch (e) {

            console.error(
                "Twilio error:",
                e.message
            );

        }
    });

    // =========================
    // OPENAI EVENTS
    // =========================

    openaiWs.on("message", async (msg) => {

        try {

            const data =
                JSON.parse(msg);

            // DEBUG

            // console.log(data);

            // =========================
            // AUDIO FROM OPENAI
            // =========================

            if (
                data.type ===
                "response.audio.delta"
            ) {

                isSpeaking = true;

                twilioWs.send(
                    JSON.stringify({

                        event: "media",

                        streamSid:
                            streamSid,

                        media: {
                            payload:
                                data.delta
                        }

                    })
                );
            }

            // =========================
            // RESPONSE FINISHED
            // =========================

            if (
                data.type ===
                "response.done"
            ) {

                isSpeaking = false;
            }

            // =========================
            // USER TRANSCRIPT
            // =========================

            if (

                data.type ===

                "conversation.item.input_audio_transcription.completed"

            ) {

                console.log(
                    "USER:",
                    data.transcript
                );

                transcript +=
                    "USER: " +
                    data.transcript +
                    "\n";

                // DETECT CITY

                const text =
                    data.transcript
                        .toLowerCase();

                if (
                    text.includes("lublin")
                ) {

                    city = "Lublin";
                }

                if (
                    text.includes("warszawa")
                ) {

                    city = "Warszawa";
                }

                if (
                    text.includes("kraków")
                ) {

                    city = "Kraków";
                }
            }

            // =========================
            // AI TEXT
            // =========================

            if (
                data.type ===
                "response.audio_transcript.done"
            ) {

                console.log(
                    "AI:",
                    data.transcript
                );

                transcript +=
                    "AI: " +
                    data.transcript +
                    "\n";

                // CALLBACK TRIGGER

                const aiText =
                    data.transcript
                        .toLowerCase();

                if (

                    aiText.includes("oddzwonię")

                ) {

                    console.log(
                        "Searching company..."
                    );

                    // SAVE LEAD

                    await axios.post(

                        "https://i2.com.ua/ai/save_lead.php",

                        {
                            phone:
                                callParams.from,

                            transcript:
                                transcript
                        }
                    );

                    // GET COMPANIES

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

                    console.log(
                        companies
                    );

                    if (
                        companies.length > 0
                    ) {

                        // CALLBACK

                        await axios.get(

                            "https://i2.com.ua/ai/callback.php",

                            {
                                params: {
                                    phone:
                                        callParams.from
                                }
                            }
                        );

                        console.log(
                            "Callback done"
                        );
                    }
                }
            }

            // =========================
            // INTERRUPTION
            // =========================

            if (

                data.type ===
                "input_audio_buffer.speech_started"

                &&

                isSpeaking

            ) {

                console.log(
                    "User interrupted"
                );

                twilioWs.send(
                    JSON.stringify({
                        event: "clear",
                        streamSid:
                            streamSid
                    })
                );

                openaiWs.send(
                    JSON.stringify({
                        type:
                            "response.cancel"
                    })
                );

                isSpeaking = false;
            }

        } catch (e) {

            console.error(
                "OpenAI error:",
                e.message
            );

        }
    });

    // =========================
    // CLOSE
    // =========================

    twilioWs.on("close", () => {

        console.log(
            "Twilio disconnected"
        );

        if (
            openaiWs.readyState
            === WebSocket.OPEN
        ) {

            openaiWs.close();
        }
    });

});

// =========================
// START SERVER
// =========================

server.listen(PORT, () => {

    console.log(
        `Server running on ${PORT}`
    );

});
