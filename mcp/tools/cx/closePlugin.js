import { z } from 'zod';
import { sendToWeb } from '../../wsClient.js';

export default {
  name: 'closePlugin',
  config: {
    title: '关闭临时插件',
    description: '将web端打开的临时插件关闭，包括插件、弹框、提示框等。并通知 Web 端',
    inputSchema: {
    },
  },
  handler: ({  }) => {
    sendToWeb('closePlugin', {  });
    return {
      content: [{ type: 'text', text: `成功关闭临时插件` }],
    };
  },
};
