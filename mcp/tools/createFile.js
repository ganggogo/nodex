import { z } from 'zod';
import fs from 'fs';
import { sendToWeb } from '../wsClient.js';

export default {
  name: 'createFile',
  config: {
    title: '创建文件',
    description: '在指定目录下创建一个文件',
    inputSchema: {
      filename: z.string().describe('文件名'),
      content: z.string().describe('文件内容'),
    },
  },
  handler: ({ filename, content }) => {
    try {
      fs.writeFileSync(filename, content);
      sendToWeb('createFile', { filename, content });
      return { content: [{ type: 'text', text: '文件创建成功！' }] };
    } catch (err) {
      return { content: [{ type: 'text', text: err.message || '文件创建失败！' }] };
    }
  },
};
