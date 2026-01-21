const http = require("http");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Twilio webhook
  if (req.url === "/voice") {
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`
<Response>
  <Say voice="alice" language="uk-UA">
    Це тест. Якщо ви це чуєте, значить Twilio webhook працює.
  </Say>
  <Pause length="2"/>
  <Say voice="alice" language="uk-UA">
    Зараз дзвінок буде завершено.
  </Say>
  <Hangup/>
</Response>
    `);
    return;
  }

  // Health check
  res.writeHead(200);
  res.end("OK");
});

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
