const http = require("http");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // ВАЖНО: Twilio шлёт POST
  if (req.url.startsWith("/voice")) {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="uk-UA">
    Це тест. Якщо ви це чуєте, webhook працює.
  </Say>
  <Pause length="2"/>
  <Hangup/>
</Response>`);
    });
    return;
  }

  // health check
  res.writeHead(200);
  res.end("OK");
});

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
