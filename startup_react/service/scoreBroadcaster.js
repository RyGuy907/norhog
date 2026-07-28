import { WebSocketServer } from 'ws';

let wss = null;

// Attach a WebSocket server to the HTTP server. Clients only listen;
// the service pushes leaderboard updates with broadcast().
const maxClients = 500;

export function initWebSocket(httpService) {
  wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  httpService.on('upgrade', (request, socket, head) => {
    // Only the leaderboard path, and don't let sockets pile up unbounded.
    const path = (request.url || '').split('?')[0];
    if (path !== '/ws' || wss.clients.size >= maxClients) {
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
    // Clients only listen; ignore anything they send and never let a socket
    // error bubble up as an unhandled exception.
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
