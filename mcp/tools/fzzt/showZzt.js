import { z } from 'zod';
import { sendToWeb } from '../../wsClient.js';

export default {
  name: 'showZzt',
  config: {
    title: '展示钻孔的柱状图',
    description: '根据钻孔的钻孔编号，生成钻孔的柱状图，并展示在 Web 端',
    inputSchema: {
      holecode: z.string().describe('钻孔编号')
    },
  },
  handler: ({ holecode }) => {
    sendToWeb('showZzt', { holecode });
    return {
      content: [{ type: 'text', text: `成功展示了 ${holecode} 的柱状图` }],
    };
  },
};
