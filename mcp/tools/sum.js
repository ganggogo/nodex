import { z } from 'zod';
import { sendToWeb } from '../wsClient.js';

export default {
  name: 'sum',
  config: {
    title: '两数求和',
    description: '得到两个数的和',
    inputSchema: {
      a: z.number().describe('第一个数'),
      b: z.number().describe('第二个数'),
    },
  },
  handler: ({ a, b }) => {
    const result = a + b;
    sendToWeb('sum', { a, b, result });
    return {
      content: [{ type: 'text', text: `两数求和结果：${result}` }],
    };
  },
};
