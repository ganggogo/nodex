import { z } from 'zod';
import { sendToWeb } from '../../wsClient.js';

export default {
  name: 'drawLine',
  config: {
    title: '将点位连成线',
    description: '根据传入的点位的坐标串，将这些点连成线并在地图上显示，传入参数格式为：117.180399,36.590722;117.180399,36.590722;117.180399,36.590722，经纬度格式',
    inputSchema: {
      coord: z.string().describe('经纬度坐标串，格式为：117.180399,36.590722;117.180399,36.590722;117.180399,36.590722')
    },
  },
  handler: ({ coord }) => {
    sendToWeb('drawLine', { coord });
    return {
      content: [{ type: 'text', text: `成功将点位连成线，坐标串为：${coord}` }],
    };
  },
};
