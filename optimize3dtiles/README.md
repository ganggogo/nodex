# optimize3dtiles 说明

这个目录里的脚本用于优化 3D Tiles `tileset.json + b3dm` 模型。所有脚本都会输出新文件和新目录，不会覆盖原始模型。

运行命令时按当前项目约定使用 `rtk` 前缀，例如：

```powershell
rtk node optimize3dtiles/createLodTileset.js static/models/横琴示范区.json static/models/横琴示范区_lod10.json --ratio 0.10
```

## 文件说明

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
