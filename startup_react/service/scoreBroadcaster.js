import { WebSocketServer } from 'ws';

let wss = null;

const maxClients = 500;

// Browsers always send an Origin header on WebSocket upgrades, so a page on
// another site can be turned away by comparing it with the Host header. Clients
// that send no Origin aren't browsers and could fake one anyway, so they are
// allowed.
export function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) {
    return true;
  }
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

// Attaches a WebSocket server to the HTTP server. Clients only listen, and the
// service pushes leaderboard updates to them with broadcast().
export function initWebSocket(httpService) {
  wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  httpService.on('upgrade', (request, socket, head) => {
    // Accepts only the leaderboard path, up to a fixed number of open sockets.
    const path = (request.url || '').split('?')[0];
    if (path !== '/ws' || wss.clients.size >= maxClients || !sameOrigin(request)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    // Anything a client sends is ignored, and a socket error closes that socket
    // instead of surfacing as an uncaught exception.
    ws.on('error', () => ws.terminate());
  });

  wss.on('error', (err) => console.log(`WebSocket server error: ${err.message}`));

  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
      } else {
        ws.isAlive = false;
        ws.ping();
      }
    });
  }, 10000);
}

export function broadcast(message) {
  if (!wss) return;
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(data);
    }
  });
}
