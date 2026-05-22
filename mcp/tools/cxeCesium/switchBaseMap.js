import { z } from 'zod';
import { sendToWeb } from '../../wsClient.js';

export default {
  name: 'switchBaseMap',
  config: {
    title: '切换底图',
    description: '根据不同的指令，web端切换不同的底图，底图类型，可选值：天地图影像，天地图矢量，天地图注记，高德影像，高德矢量，高德注记，腾讯影像，腾讯矢量，腾讯注记，不可以同时选多个一样类型的，比如同时显示天地图影像和高德影像是不可以的，还有同时显示天地图矢量和高德矢量也是不可以的，还有同时选择天地图注记和高德注记也是不可以的，还有同时选天地图影像和天地图矢量也是不可以的，等等。',
    inputSchema: {
      maptype: z.string().describe('底图类型，可选值：天地图影像，天地图矢量，天地图注记，高德影像，高德矢量，高德注记，腾讯影像，腾讯矢量，腾讯注记，不可以同时选多个一样类型的，比如同时显示天地图影像和高德影像是不可以的，还有同时显示天地图矢量和高德矢量也是不可以的，还有同时选择天地图注记和高德注记也是不可以的，还有同时选天地图影像和天地图矢量也是不可以的，等等。'),
    },
  },
  handler: ({ maptype }) => {
    sendToWeb('switchBaseMap', { maptype });
    return {
      content: [{ type: 'text', text: `成功切换底图为${maptype}` }],
    };
  },
};
