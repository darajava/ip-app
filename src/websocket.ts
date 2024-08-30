import WebSocket from "ws";

// Create a WebSocket server instance
export const wss = new WebSocket.Server({ port: 8080 });

type Connections = {
  [key: string]: Connection;
};

type Connection = {
  ip: string;
  ws: WebSocket;
  isAlive: boolean;
};

type Message = {
  action: string;
  messageJSON: string;
};

const connections: Connections = {};

wss.on("connection", (ws, req) => {
  console.log("Client connected");
  const ip = (req.headers["x-real-ip"] as string) ?? req.socket.remoteAddress;

  console.log(ip);
  console.log(req.headers["x-real-ip"]);

  if (!ip) {
    console.log("No IP provided");
    ws.close();
    return;
  }

  ws.on("message", (data) => {
    const message: Message = JSON.parse(data.toString());

    if (message.action === "pong") {
      heartbeat(connections[ip]);
    }
  });

  if (connections[ip]) {
    console.log(`IP ${ip} already connected`);
    connections[ip].ws.close();
    delete connections[ip];
  }

  connections[ip] = {
    ip: req.socket.remoteAddress!,
    ws,
    isAlive: true,
  };

  // Handle client disconnect
  ws.on("close", (w: any, closeEvent: any, reason: any) => {
    console.log("Connection closed", closeEvent, reason);
    console.log("Client disconnected");
  });
});

function heartbeat(connection: Connection) {
  console.log("Heartbeat received");
  connection.isAlive = true;
}

const interval = setInterval(() => {
  console.log("Pinging connections");
  for (const key in connections) {
    const entry = connections[key];

    if (entry.isAlive === false) {
      console.log(`Connection ${key} timed out`);
      entry.ws.terminate();
      delete connections[key];

      return;
    }

    entry.isAlive = false;
    entry.ws.send(
      JSON.stringify({
        action: "ping",
        messageJSON: "{}",
      })
    );
  }
}, 30000);

wss.on("close", () => {
  clearInterval(interval);
});

export const broadcast = (message: Message) => {
  Object.values(connections).forEach((entry) => {
    entry.ws.send(JSON.stringify(message));
  });
};

console.log("WebSocket server is listening on ws://localhost:8080");
