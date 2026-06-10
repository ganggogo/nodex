# Cesium 3D Tiles 性能排查指南

## 一、开启 FPS 显示

用于观察场景实时帧率。

```javascript
viewer.scene.debugShowFramesPerSecond = true;
```

界面左下角会显示：

```text
FPS
MS
```

说明：

* FPS：当前帧率
* MS：单帧耗时

参考：


| FPS   | 状态     |
| ----- | -------- |
| 60+   | 流畅     |
| 30~60 | 正常     |
| 15~30 | 偏卡     |
| <15   | 严重卡顿 |

---

# 二、统计当前 Draw Call

Draw Call 是判断 CPU 是否成为瓶颈的重要指标。

```javascript
viewer.scene.postRender.addEventListener(() => {
    console.log(
        viewer.scene.frameState.commandList.length
    );
});
```

输出示例：

```text
2638
2509
2458
2420
```

表示：

```text
当前 Draw Call ≈ 2400~2600
```

经验参考：


| Draw Call | 状态 |
| --------- | ---- |
| <300      | 优秀 |
| 300~800   | 正常 |
| 800~1500  | 偏高 |
| 1500~3000 | 较高 |
| >3000     | 很高 |

---

# 三、统计可见 Tile 数量

```javascript
console.log(
    "Visible Tiles:",
    tileset._selectedTiles.length
);
```

示例：

```text
Visible Tiles: 1280
```

参考：


| Visible Tiles | 状态 |
| ------------- | ---- |
| <100          | 优秀 |
| 100~300       | 正常 |
| 300~800       | 偏高 |
| >1000         | 异常 |

---

# 四、统计 Primitive 数量

```javascript
let totalPrimitive = 0;

tileset._selectedTiles.forEach(tile => {

    const nodes =
        tile.content?._model?._sceneGraph?._runtimeNodes || [];

    nodes.forEach(node => {
        totalPrimitive +=
            node.runtimePrimitives?.length || 0;
    });

});

console.log(
    "Primitive:",
    totalPrimitive
);
```

输出：

```text
Primitive: 2638
```

如果：

```text
Primitive ≈ Draw Call
```

说明：

```text
一个 Primitive 基本对应一个 Draw Call
```

---

# 五、查看 Tileset 统计信息

```javascript
console.log(
    tileset.statistics
);
```

或

```javascript
console.log(
    tileset._statistics
);
```

重点关注：

```text
numberOfCommands
numberOfTrianglesSelected
selected
visited
numberOfTilesWithContentReady
```

示例：

```text
numberOfCommands = 2638
numberOfTrianglesSelected = 2644216
selected = 1280
visited = 1281
```

说明：

```text
Draw Call = 2638
三角面 = 264万
可见 Tile = 1280
```

---

# 六、统计根节点子节点数量

检查是否存在 LOD 树。

```javascript
console.log(
    "root children:",
    tileset.root.children.length
);
```

正常情况：

```text
root children: 4
root children: 8
root children: 16
```

异常情况：

```text
root children: 1280
```

说明：

```text
所有 Tile 直接挂在 Root 下
没有层级结构
```

---

# 七、测试 LOD 是否生效

查看当前配置：

```javascript
console.log(
    tileset.maximumScreenSpaceError
);
```

修改：

```javascript
tileset.maximumScreenSpaceError = 256;
```

等待几秒：

```javascript
setTimeout(() => {

    console.log(
        tileset._selectedTiles.length
    );

}, 3000);
```

判断：

### 情况1

```text
1280
↓
100
```

说明：

```text
LOD 正常
SSE 配置过小
```

### 情况2

```text
1280
↓
1278
```

说明：

```text
LOD 失效
或不存在
```

---

# 八、统计每个 Tile 的 Primitive

```javascript
tileset._selectedTiles.forEach(tile => {

    const model =
        tile.content?._model;

    const nodes =
        model?._sceneGraph?._runtimeNodes || [];

    let primitiveCount = 0;

    nodes.forEach(node => {

        primitiveCount +=
            node.runtimePrimitives?.length || 0;

    });

    console.log(
        tile._contentResource?.url,
        primitiveCount
    );

});
```

用于查找：

```text
哪个 b3dm 最耗性能
```

---

# 九、统计 Draw Call Top20

```javascript
function countTileDrawCalls(tile) {

    const content = tile.content;

    if (!content || !content._model) {
        return 0;
    }

    let count = 0;

    const sceneGraph =
        content._model._sceneGraph;

    const runtimeNodes =
        sceneGraph._runtimeNodes;

    runtimeNodes.forEach(node => {

        if (node.runtimePrimitives) {

            count +=
                node.runtimePrimitives.length;

        }

    });

    return count;
}

const result = [];

tileset._selectedTiles.forEach(tile => {

    result.push({
        tile,
        count: countTileDrawCalls(tile)
    });

});

result.sort(
    (a, b) => b.count - a.count
);

console.table(
    result.slice(0, 20)
);
```

输出：

```text
Top20 最耗 DrawCall 的 Tile
```

---

# 十、Chrome Performance 分析

打开：

```text
F12
→ Performance
→ Record
```

操作模型：

```text
旋转
缩放
平移
```

停止录制。

重点观察：

```text
Scene.render
executeCommands
updateAndRenderPrimitives
```

如果：

```text
Main Thread 占用高
GPU 占用低
```

通常说明：

```text
Draw Call 过多
CPU 成为瓶颈
```

---

# 十一、Spector.js 分析

安装：

https://spector.babylonjs.com/

抓取一帧：

```text
Capture Frame
```

可查看：

```text
Draw Call 数量
Shader
Texture
VAO
Buffer
```

是分析 WebGL 最准确的方法。

---

# 十二、当前项目排查结果

模型：

```text
横琴示范区
```

统计结果：

```text
Tiles Total       : 1281
Visible Tiles     : 1280
Primitive         : 2638
Draw Call         : 2638
Triangles         : 2644216
Geometry Memory   : 317 MB
Texture Memory    : 112 MB
```

结论：

```text
1. 三角面数量不是瓶颈
2. Draw Call 偏高
3. Tile 数量异常高
4. Root 下直接挂 1280 个 Tile
5. LOD 基本失效
6. maximumScreenSpaceError 调整无明显效果
```

主要问题：

```text
3D Tiles 层级结构设计不合理
```

优化优先级：

```text
① 重建 LOD 树
② 合并 Tile
③ 合并 Primitive
④ 减少 Draw Call
```
