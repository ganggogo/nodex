import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerAllTools } from './tools/index.js';
import './wsClient.js'; // 启动 WebSocket 服务

const app = express();
const port = 18088;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());

const server = new McpServer({
  name: 'my mcp server',
  title: 'my mcp server',
  version: '0.1.0',
});

registerAllTools(server); // 一行注册所有工具

const transports = {};

app.get('/sse', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  console.log('Dify 已连接（SSE）');

  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;

  res.on('close', () => {
    console.log(`Dify 断开，sessionId: ${transport.sessionId}`);
    delete transports[transport.sessionId];
  });

  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(404).json({ error: `未找到 sessionId: ${sessionId}` });
  await transport.handlePostMessage(req, res, req.body);
});

app.listen(port, () => {
  console.log(`MCP SSE 服务：http://localhost:${port}/sse`);
});
