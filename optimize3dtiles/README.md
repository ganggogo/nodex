# optimize3dtiles 说明

这个目录里的脚本用于优化 3D Tiles `tileset.json + b3dm` 模型。所有脚本都会输出新文件和新目录，不会覆盖原始模型。

运行命令时按当前项目约定使用 `rtk` 前缀，例如：

```powershell
rtk node optimize3dtiles/createLodTileset.js static/models/横琴示范区.json static/models/横琴示范区_lod10.json --ratio 0.10
```

## 文件说明

### buildRetiledDedupTex.js

推荐的一键优化流水线脚本。

作用：

- 串联执行 `groupTilesetByQuadTree.js`、`retileByGrid.js`、`createTextureScaleTileset.js`。
- 默认生成一套适合横琴示范区这类“需要剖切正确、但希望提升近景性能”的模型。
- 默认只保留最终输出，自动删除中间的 `_grouped` 和 `_retiled_dedup` 过程产物。
- 不做 LOD，不直接删三角面。

默认命令：

```powershell
rtk node optimize3dtiles/buildRetiledDedupTex.js static/models/横琴示范区.json
```

最终输出：

```text
static/models/横琴示范区_retiled_dedup_tex25.json
static/models/横琴示范区_retiled_dedup_tex25/
```

如果要保留中间产物用于排查：

```powershell
rtk node optimize3dtiles/buildRetiledDedupTex.js static/models/横琴示范区.json --keep-stages
```

如果要生成 `tex50`：

```powershell
rtk node optimize3dtiles/buildRetiledDedupTex.js static/models/横琴示范区.json --ratio 0.5
```

内部等价流程：

```powershell
rtk node optimize3dtiles/groupTilesetByQuadTree.js static/models/横琴示范区.json static/models/横琴示范区_grouped.json

rtk node optimize3dtiles/retileByGrid.js static/models/横琴示范区_grouped.json static/models/横琴示范区_retiled_dedup.json --max-triangles 30000 --min-bytes 2mb --max-parts 16 --max-vertices 60000

rtk node optimize3dtiles/createTextureScaleTileset.js static/models/横琴示范区_retiled_dedup.json static/models/横琴示范区_retiled_dedup_tex25.json --ratio 0.25
```

当前推荐优先使用这个脚本，而不是手动分步执行。

### groupTilesetByQuadTree.js

Tileset 分组 + b3dm 内 primitive 合并 + 顶点去重脚本。

作用：

- 把 root 下大量直接 child 按 XY 空间分组，降低 root 直接子节点数量。
- 默认不跨 b3dm 合并，保持原始 feature/b3dm 粒度，剖切更稳。
- 在每个 b3dm 内合并兼容 primitive。
- 按完整 attribute 字节做无损顶点去重，重建 index buffer。
- 保留 batchTable、`_BATCHID`、材质、纹理和几何精度。

示例：

```powershell
rtk node optimize3dtiles/groupTilesetByQuadTree.js static/models/横琴示范区.json static/models/横琴示范区_grouped.json
```

输出：

```text
static/models/横琴示范区_grouped.json
static/models/横琴示范区_grouped/
```

可选参数：

```powershell
--target-group-size 12
--min-group-size 8
--max-group-size 16
--merge-groups
--max-merged-bytes 12mb
--max-merged-span 2000
```

注意：

- 默认模式是剖切安全优先。
- `--merge-groups` 会跨 b3dm 合并，能降低 content/draw call，但可能改变剖切依赖的空间粒度，必须单独复测。

### createTextureScaleTileset.js

内嵌 PNG 纹理降采样脚本。

作用：

- 只缩小 b3dm GLB 内嵌 PNG 图片。
- 不改几何、index、batchTable、`_BATCHID`、tile 树。
- 当前用于横琴示范区时，`--ratio 0.25` 会把 `128x128` 纹理降到 `32x32`。

示例：

```powershell
rtk node optimize3dtiles/createTextureScaleTileset.js static/models/横琴示范区_retiled_dedup.json static/models/横琴示范区_retiled_dedup_tex25.json --ratio 0.25
```

输出：

```text
static/models/横琴示范区_retiled_dedup_tex25.json
static/models/横琴示范区_retiled_dedup_tex25/
```

### createMaterialTestTileset.js

材质性能诊断脚本。

作用：

- `solid`：移除纹理引用，改成纯色材质，用于判断纹理采样成本。
- `unlit`：保留纹理，添加 `KHR_materials_unlit`，用于判断光照/法线 shader 成本。
- 不改几何和 batch 数据。

示例：

```powershell
rtk node optimize3dtiles/createMaterialTestTileset.js static/models/横琴示范区_retiled_dedup.json static/models/横琴示范区_retiled_dedup_solid.json --mode solid

rtk node optimize3dtiles/createMaterialTestTileset.js static/models/横琴示范区_retiled_dedup.json static/models/横琴示范区_retiled_dedup_unlit.json --mode unlit
```

注意：

- 这是诊断脚本，不一定适合作为正式交付模型。

### createMeshoptSimplifyTileset.js

边折叠三角面简化测试脚本。

作用：

- 使用 `meshoptimizer` 的 edge-collapse 简化算法减少三角面。
- 默认启用 `LockBorder`，尽量锁住拓扑边界，降低剖切出现大洞的风险。
- 保持原 tileset 结构和 b3dm 数量，不像 `retileByGrid.js` 那样增加 draw call。
- 会改变几何，属于有损优化，必须重新检查模型外观和剖切结果。

全市地质体模型当前建议从保守版本开始测试：

```powershell
rtk node optimize3dtiles/createMeshoptSimplifyTileset.js static/models/全市地质体模型.json static/models/全市地质体模型_meshopt90.json --ratio 0.9 --error 0.001

rtk node optimize3dtiles/createMeshoptSimplifyTileset.js static/models/全市地质体模型.json static/models/全市地质体模型_meshopt80.json --ratio 0.8 --error 0.002

rtk node optimize3dtiles/createMeshoptSimplifyTileset.js static/models/全市地质体模型.json static/models/全市地质体模型_meshopt70.json --ratio 0.7 --error 0.005
```

已生成结果：

```text
meshopt90:
  三角面: 9402428 -> 8462160
  顶点:   5189226 -> 4718403
  体积:   286.78 MB -> 257.44 MB

meshopt80:
  三角面: 9402428 -> 7521920
  顶点:   5189226 -> 4247001
  体积:   286.78 MB -> 230.18 MB

meshopt70:
  三角面: 9402428 -> 6581676
  顶点:   5189226 -> 3774399
  体积:   286.78 MB -> 202.42 MB

meshopt50:
  三角面: 9402428 -> 4701190
  顶点:   5189226 -> 2807246
  体积:   286.78 MB -> 148.27 MB
  结论: 剖切仍有漏洞，不推荐用于正式剖切模型。
```

可选参数：

```powershell
--ratio 0.7
--error 0.005
--no-lock-border
--no-compact
```

注意：

- `--ratio` 越小，三角面越少，但剖切和外观风险越高。
- 默认不要加 `--no-lock-border`，除非只是做显示层性能极限测试。
- 如果 `meshopt80` 或 `meshopt90` 仍有剖切漏洞，说明这个模型不适合自动几何简化。

### createExteriorShellTileset.js

显示外壳抽取脚本。

作用：

- 扫描整套 tileset 的三角面。
- 把顶点位置完全重合或在容差内重合的三角面视为同一个面。
- 只保留出现一次的面，删除重复出现的内部共面面。
- 输出一套只用于显示的外壳模型。
- 不修改原模型，分析和剖切仍然应该使用原始完整模型。

示例：

```powershell
rtk node optimize3dtiles/createExteriorShellTileset.js static/models/全市地质体模型.json static/models/全市地质体模型_shell.json --epsilon 0.001
```

输出：

```text
static/models/全市地质体模型_shell.json
static/models/全市地质体模型_shell/
```

注意：

- 这是“显示层 + 分析层”思路：`shell` 负责日常浏览，原始模型负责剖切分析。
- 如果内部面不是完全共点共面，这个脚本删不掉，需要更复杂的实体外包络算法。
- 如果 `--epsilon` 太大，可能误删外部重叠面；建议先用 `0.001`，效果不明显再小步调大。

### createVertexClusterSimplifyTileset.js

顶点聚类简化诊断脚本。

作用：

- 按空间网格合并相邻顶点，重建 index，并删除退化三角面。
- 对部分模型能快速降低顶点和三角面。
- 已验证用于 `全市地质体模型` 时，剖切会出现大量漏洞。

示例：

```powershell
rtk node optimize3dtiles/createVertexClusterSimplifyTileset.js static/models/全市地质体模型.json static/models/全市地质体模型_vc512.json --grid-size 512
```

注意：

- 这个脚本只保留为诊断工具。
- 不建议用于需要精确剖切的地质体模型。

### createTriangleRatioTileset.js

三角面抽稀诊断脚本。

作用：

- 按比例直接删除三角面，用于测试 FPS 上限。
- 会改变几何，可能出现孔洞、蜂窝状缺面。
- 不建议用于正式模型或精确剖切。

示例：

```powershell
rtk node optimize3dtiles/createTriangleRatioTileset.js static/models/横琴示范区_retiled_dedup_tex25.json static/models/横琴示范区_retiled_dedup_tex25_tri50.json --ratio 0.5
```

注意：

- 这个脚本只用于诊断，已经验证直接抽面会导致模型不完整。

### index.js

无损索引优化脚本。

作用：

- 遍历 tileset 里的所有 `.b3dm`。
- 保留所有顶点属性、材质、纹理、batch 数据。
- 只把满足条件的 `uint32` 索引转换成 `uint16` 索引。
- 适合先做低风险压缩。

适用场景：

- 模型里有不少索引本来没有超过 `65535`，但被保存成了 `uint32`。
- 希望不改变几何、不改变属性、不影响剖切分析。

示例：

```powershell
rtk node optimize3dtiles/index.js static/models/海南岛_1.json static/models/海南岛_1_optimized.json
```

可选参数：

```powershell
--keep-uint32-indices
```

这个参数会保留原始 `uint32` 索引，主要用于排查某些分析代码是否依赖 `UNSIGNED_INT` 索引。

输出：

- `static/models/xxx_optimized.json`
- `static/models/xxx_optimized/`

风险：

- 风险最低。
- 体积收益不一定明显，取决于原模型有多少索引可以转成 `uint16`。

### splitLargePrimitives.js

大 primitive 拆分脚本。

作用：

- 在单个 `.b3dm` 内部拆分过大的 `TRIANGLES primitive`。
- 每个拆出来的 primitive 使用不超过指定数量的唯一顶点。
- 拆分后索引可以使用 `uint16`。
- 保留 `POSITION`、`NORMAL`、`TEXCOORD_0`、`_BATCHID` 等所有 primitive 属性。

适用场景：

- 原模型 vertex buffer 很大，且大 primitive 导致索引无法转成 `uint16`。
- 希望不改变 tile 树，只优化 b3dm 内部结构。

示例：

```powershell
rtk node optimize3dtiles/splitLargePrimitives.js static/models/横琴示范区.json static/models/横琴示范区_split_optimized.json --max-vertices 60000
```

可选参数：

```powershell
--max-vertices 60000
```

输出：

- `static/models/xxx_split_optimized.json`
- `static/models/xxx_split_optimized/`

风险：

- 不减少三角面数量。
- 不改变 tile 加载粒度。
- 对移动端首屏加载的改善有限，但对文件大小和索引类型有帮助。

### retileByGrid.js

空间重切片脚本。

作用：

- 把过大的 `.b3dm` 按 XY 空间网格拆成多个子 `.b3dm`。
- 原 tile 会变成空父节点，下面挂多个 child tile。
- 不做几何简化，三角面数量保持一致。
- 保留属性、材质、纹理、b3dm 元数据。

适用场景：

- 移动端卡慢主要来自单个 tile 太大、局部浏览时也必须加载大块模型。
- 希望 Cesium 更细粒度地按视角加载局部数据。
- 希望剖切分析仍然基于完整精确几何。

保守示例：

```powershell
rtk node optimize3dtiles/retileByGrid.js static/models/横琴示范区.json static/models/横琴示范区_retiled.json --max-triangles 12000 --min-bytes 1mb --max-parts 16 --max-vertices 60000
```

更细示例：

```powershell
rtk node optimize3dtiles/retileByGrid.js static/models/横琴示范区.json static/models/横琴示范区_retiled_fine.json --max-triangles 8000 --min-bytes 512kb --max-parts 32 --max-vertices 60000
```

参数：

- `--max-triangles`：每个生成子 b3dm 的目标三角面数量。
- `--min-bytes`：只有大于这个体积的源 b3dm 才会被拆。
- `--max-parts`：单个源 b3dm 最多拆成多少份。
- `--max-vertices`：每个输出 primitive 的最大唯一顶点数，必须小于等于 `65535`。

输出：

- `static/models/xxx_retiled.json`
- `static/models/xxx_retiled/`

风险：

- 请求数量会增加。
- 如果服务器并发或缓存配置不好，过细切片可能导致请求开销变大。
- 不做几何简化，所以总体体积不会大幅下降，主要收益是局部加载粒度。

### createLodTileset.js

LOD tileset 生成脚本。

作用：

- 为部分较大的 b3dm 生成一个简化粗模型作为父 tile content。
- 原始精确 b3dm 仍然作为 child tile 保留。
- 前端只需要加载新的 `xxx_lod.json`，Cesium 会根据相机距离和 `maximumScreenSpaceError` 自动在粗层和精细层之间切换。
- 原始模型不会被复制，LOD tileset 里的精细层仍然引用原来的模型目录。

适用场景：

- 希望移动端远景和首屏更快。
- 可以接受远处显示简化模型，近处再切换到精确模型。
- 剖切分析希望在近处精确层加载完成后再执行。

推荐移动端测试版：

```powershell
rtk node optimize3dtiles/createLodTileset.js static/models/横琴示范区.json static/models/横琴示范区_lod10.json --ratio 0.10 --min-bytes 128kb --min-triangles 100 --max-vertices 60000
```

较高质量版：

```powershell
rtk node optimize3dtiles/createLodTileset.js static/models/横琴示范区.json static/models/横琴示范区_lod25.json --ratio 0.25 --min-bytes 256kb --min-triangles 200 --max-vertices 60000
```

参数：

- `--ratio`：粗模型保留的三角面比例，必须大于 `0` 且小于 `1`。
- `--min-triangles`：三角面少于这个值的 b3dm 不生成 LOD。
- `--min-bytes`：体积小于这个值的 b3dm 不生成 LOD。
- `--max-vertices`：每个输出 primitive 的最大唯一顶点数。

输出：

- `static/models/xxx_lod.json`
- `static/models/xxx_lod/`

注意：

- `xxx_lod.json` 不是完整模型文件，只是 tileset 索引。
- 新增粗模型在 `xxx_lod/` 目录。
- 精细模型仍然引用原始目录，例如 `static/models/横琴示范区/`。
- 剖切分析如果发生在粗层，封面会按简化几何计算；建议剖切前降低 `maximumScreenSpaceError` 并等待精确 tile 加载完成。

## 当前已测试过的输出

横琴示范区：

```text
retileByGrid:
  输入:  static/models/横琴示范区.json
  输出:  static/models/横琴示范区_retiled.json
  b3dm: 1280 -> 1425
  三角面: 2644216 -> 2644216
  b3dm 总大小: 310.64 MB -> 297.64 MB

createLodTileset ratio 0.10:
  输入:  static/models/横琴示范区.json
  输出:  static/models/横琴示范区_lod10.json
  精确层三角面: 2644216
  LOD 粗层三角面: 260740
  新增 LOD b3dm: 28.80 MB

createLodTileset ratio 0.25:
  输入:  static/models/横琴示范区.json
  输出:  static/models/横琴示范区_lod25.json
  精确层三角面: 2644216
  LOD 粗层三角面: 646415
  新增 LOD b3dm: 70.63 MB
```

海南岛：

```text
index:
  输入:  static/models/海南岛_1.json
  输出:  static/models/海南岛_1_optimized.json
  b3dm 总大小: 5.32 MB -> 4.39 MB 左右

retileByGrid:
  输入:  static/models/海南岛_1.json
  输出:  static/models/海南岛_1_retiled.json
  b3dm: 13 -> 77
  三角面: 162242 -> 162242
  b3dm 总大小: 5.32 MB -> 4.83 MB

createLodTileset ratio 0.25:
  输入:  static/models/海南岛_1.json
  输出:  static/models/海南岛_1_lod.json
  精确层三角面: 162242
  LOD 粗层三角面: 40557
  新增 LOD b3dm: 2.88 MB
```

## 选型建议

优先级建议：

1. 先跑 `index.js`，这是最低风险的无损优化。
2. 如果单个 b3dm 太大，用 `retileByGrid.js` 改善移动端局部加载。
3. 如果远景和首屏仍然慢，用 `createLodTileset.js` 做粗层 LOD。
4. 如果只想压体积且不想改变 tile 树，用 `splitLargePrimitives.js`。

剖切分析建议：

- 精确剖切优先使用原始几何层。
- 使用 LOD tileset 时，剖切前让 Cesium 切到精确层。
- 前端可以在剖切模式临时调小 `tileset.maximumScreenSpaceError`，例如 `4` 或 `8`。
- 结束剖切后再恢复移动端展示参数，例如 `16` 或 `24`。
