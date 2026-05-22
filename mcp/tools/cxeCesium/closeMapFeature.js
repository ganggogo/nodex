import { z } from 'zod';
import { sendToWeb } from '../../wsClient.js';

export default {
  name: 'closeMapFeature',
  config: {
    title: '关闭地图临时图层',
    description: '关闭地图上的临时图层，并通知 Web 端',
    inputSchema: {
    },
  },
  handler: ({  }) => {
    sendToWeb('closeMapFeature', {  });
    return {
      content: [{ type: 'text', text: `成功关闭地图上的临时图层` }],
    };
  },
};
