# 显示外壳模型方案说明

本文说明 `createExteriorShellTileset.js` 的设计思路。这个方案用于“显示层 + 分析层”双模型：

- 显示层：加载外壳模型，提高日常浏览帧率。
- 分析层：仍然使用原始完整模型，保证剖切、土方量、属性分析等结果正确。

## 为什么需要外壳模型

`全市地质体模型` 原模型本身只有约 28 个 draw call，draw call 已经很低。它的主要性能瓶颈不是 primitive 过碎，而是完整显示时需要绘制约 940 万三角面。

前面尝试过两类几何简化：

- 顶点聚类：会导致剖切出现大量漏洞。
- meshoptimizer 边折叠：即使只保留 90% 三角面，剖切仍然有漏洞。

这说明该地质体模型对几何完整性非常敏感，不能直接拿简化后的模型做分析。

因此更合理的方向是：

```text
日常浏览只画外壳
剖切分析仍然用原模型
```

## 外壳抽取原理

地质体通常由多个地层或实体贴合组成。相邻两个实体之间会有一张共享界面：

```text
地层 A 的边界面
地层 B 的边界面
```

这张面在完整模型内部，正常从外面看不到，但 GPU 仍然会绘制它。如果这种内部面很多，帧率会被大量不可见三角面拖低。

`createExteriorShellTileset.js` 的处理逻辑是：

1. 遍历整套 tileset 的所有 `.b3dm`。
2. 读取每个三角面的 3 个顶点坐标。
3. 对三角面的 3 个顶点坐标做排序，生成一个与顶点顺序无关的 face key。
4. 全局统计每个 face key 出现次数。
5. 第二遍重写 b3dm：
   - 出现 1 次的面保留，认为是外壳面。
   - 出现 2 次或更多的面删除，认为是内部重复贴合面。
6. 输出新的 `xxx_shell.json` 和 `xxx_shell/` 目录。

这个过程不会移动顶点，不会做边折叠，也不会近似改变面的位置。它只是删除“重复出现的共面三角面”。

## 和三角面简化的区别

```text
meshopt / vertex clustering:
  改变几何拓扑或顶点位置
  目标是减少三角面
  可能破坏剖切结果

exterior shell:
  不移动顶点
  不折叠边
  只删除重复内部面
  只建议用于显示，不建议用于分析
```

## 使用命令

```powershell
rtk node optimize3dtiles/createExteriorShellTileset.js static/models/全市地质体模型.json static/models/全市地质体模型_shell.json --epsilon 0.001
```

输出：

```text
static/models/全市地质体模型_shell.json
static/models/全市地质体模型_shell/
```

参数：

```powershell
--epsilon 0.001
```

`epsilon` 是顶点坐标匹配容差。脚本会把坐标除以 `epsilon` 后四舍五入，用于判断两个三角面是否重合。

建议：

- 先用 `0.001`。
- 如果几乎删不掉内部面，可以尝试 `0.01`。
- 不要一开始设太大，否则可能误删外部重叠面。

## 前端使用方式

前端应同时保留两个模型概念：

```text
displayTileset:
  外壳模型，只负责场景显示和交互浏览

analysisTileset:
  原始完整模型，只负责剖切和计算分析
```

日常浏览：

```js
displayTileset.show = true
analysisTileset.show = false
```

开始剖切或分析时：

```js
displayTileset.show = false
analysisTileset.show = true
```

分析结束后，如果只需要看结果图元，可以再隐藏原始模型：

```js
analysisTileset.show = false
displayTileset.show = true
```

注意：剖切上下文、土方量计算、属性查询等必须绑定 `analysisTileset`，不要绑定 `displayTileset`。

## 适用场景

适合：

- 多个地质体或地层贴合组成的模型。
- 内部共享面很多，但外部浏览只需要看到外包络。
- 剖切分析可以切换回原始完整模型。

不适合：

- 内部面没有共点共面，只是非常接近但不重合。
- 模型本身就是单层壳，没有大量内部重复面。
- 必须直接对显示模型做精确剖切分析。

## 风险和限制

1. 内部面不完全重合时，脚本可能删不掉。

如果两个地质体之间的接触面顶点不一致、三角剖分方式不同，face key 不会相同，脚本无法识别为重复内部面。

2. 外部重复面可能被误删。

如果模型外表面本来就有完全重叠的重复面，脚本也会把它当成重复面删除。

3. 外壳模型不能用于剖切分析。

外壳模型已经删除内部结构，用它做剖切会缺少内部地层面，分析结果不可信。

4. 帧率收益取决于内部重复面比例。

如果模型内部共享面很多，收益会明显；如果内部面很少，收益有限。

## 判断是否成功

生成后重点看这些指标：

```text
numberOfTrianglesSelected 是否明显下降
geometryByteLength 是否明显下降
FPS 是否提升
外观看起来是否仍然完整
```

同时要确认分析流程使用的仍然是原始模型：

```text
剖切/土方量/属性分析 -> 全市地质体模型.json
日常浏览显示 -> 全市地质体模型_shell.json
```

