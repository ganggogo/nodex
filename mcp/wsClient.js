import { WebSocketServer } from 'ws';

const wsPort = 18089;
const wss = new WebSocketServer({ port: wsPort });
let browserClient = null;

wss.on('connection', (ws) => {
  browserClient = ws;
  console.log('Web端已连接');
  ws.on('close', () => {
    browserClient = null;
    console.log('Web端已断开');
  });
});

export function sendToWeb(command, payload = {}) {
  if (!browserClient) throw new Error('Web端未连接');
  browserClient.send(JSON.stringify({ command, payload }));
}

console.log(`WebSocket 服务：ws://localhost:${wsPort}`);
