import { z } from 'zod';
import { sendToWeb } from '../../wsClient.js';

export default {
  name: 'localToPoint',
  config: {
    title: '定位到某个点',
    description: '根据传入的经纬度坐标，将当前视角定位到某个点，并显示该点的坐标。',
    inputSchema: {
      lon: z.number().describe('经度'),
      lat: z.number().describe('纬度')
    },
  },
  handler: ({ lon, lat }) => {
    sendToWeb('localToPoint', { lon, lat });
    return {
      content: [{ type: 'text', text: `成功定位到经度 ${lon} 纬度 ${lat}` }],
    };
  },
};
