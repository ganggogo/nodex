
import { WebSocketServer } from 'ws';
const wsport = 18088;
let browserClient = null;
const wss = new WebSocketServer({ port: wsport });
wss.on('connection', (ws) => {
    browserClient = ws;
    console.error('dify-web 客户端已连接'); // 在 MCP 中，console.log 用于传输数据，log 调试要用 console.error
});


import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod'; // 数据校验库
import fs from 'fs';

const server = new McpServer({
  name: 'my mcp server',
  title: 'my mcp server',
  version: '0.1.0',
});

server.registerTool(
  'sum', // 函数名
  {
    title: '两数求和',
    description: '得到两个数的和',
    inputSchema: {
      a: z.number().describe('第一个数'),
      b: z.number().describe('第二个数'),
    },
  },
  ({ a, b }) => {
    // console.error(123);
    return {
      content: [
        {
          type: 'text',
          text: `两数求和结果：${a + b}`,
        },
      ],
    };
  }
);

server.registerTool(
  'createFile',
  {
    title: '创建文件',
    description: '在指定目录下创建一个文件',
    inputSchema: {
      filename: z.string().describe('文件名'),
      content: z.string().describe('文件内容'),
    },
  },
  ({ filename, content }) => {
    try {
      fs.writeFileSync(filename, content);
      return {
        content: [
          {
            type: 'text',
            text: `文件创建成功！`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: err.message || '文件创建失败！',
          },
        ],
      };
    }
  }
);

const transport = new StdioServerTransport();
server.connect(transport);
