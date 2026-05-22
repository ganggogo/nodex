import sum from './sum.js';
import createFile from './createFile.js';
import localToPoint from './cxeCesium/localToPoint.js'
import drawLine from './cxeCesium/drawLine.js'
import showZzt from './fzzt/showZzt.js';
import showPmt from './fzzt/showPmt.js';
import closePlugin from './cx/closePlugin.js';
import closeMapFeature from './cxeCesium/closeMapFeature.js';
import switchBaseMap from './cxeCesium/switchBaseMap.js';

const tools =
[
  sum,
  createFile,
  localToPoint,
  drawLine,
  showZzt,
  showPmt,
  closePlugin,
  closeMapFeature,
  switchBaseMap
];

export function registerAllTools(server) {
  tools.forEach(({ name, config, handler }) => {
    server.registerTool(name, config, handler);
  });
  console.log(`已注册 ${tools.length} 个工具：${tools.map(t => t.name).join(', ')}`);
}
