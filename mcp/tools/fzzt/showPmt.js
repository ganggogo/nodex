import { z } from 'zod';
import { sendToWeb } from '../../wsClient.js';

export default {
  name: 'showPmt',
  config: {
    title: '展示钻孔的剖面图',
    description: '根据多个钻孔的钻孔编号，生成钻孔的剖面图，并展示在 Web 端',
    inputSchema: {
      holecodes: z.array(z.string()).describe('钻孔编号数组')
    },
  },
  handler: ({ holecodes }) => {
    sendToWeb('showPmt', { holecodes });
    return {
      content: [{ type: 'text', text: `成功展示了 ${holecodes.join('，')} 的剖面图` }],
    };
  },
};
