#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

const COMPONENT_BYTES = new Map([
  [5120, 1],
  [5121, 1],
  [5122, 2],
  [5123, 2],
  [5125, 4],
  [5126, 4],
]);

const TYPE_COMPONENTS = new Map([
  ["SCALAR", 1],
  ["VEC2", 2],
  ["VEC3", 3],
  ["VEC4", 4],
  ["MAT2", 4],
  ["MAT3", 9],
  ["MAT4", 16],
]);

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const positional = args.filter((arg) => !arg.startsWith("-"));
  const inputTileset = path.resolve(positional[0] ?? "static/models/全市地质体模型.json");
  const gridSize = readNumberOption(args, "--grid-size", 512);
  const outputTileset = path.resolve(positional[1] ?? makeDefaultOutput(inputTileset, gridSize));
  const options = {
    gridSize,
    cellSize: readOptionalNumberOption(args, "--cell-size"),
    positionMode: readStringOption(args, "--position", "average"),
    keepBatchBoundaries: !args.includes("--merge-batches"),
  };

  validateOptions(options);

  const inputDir = path.dirname(inputTileset);
  const outputDir = path.dirname(outputTileset);
  const outputModelName = path.basename(outputTileset, path.extname(outputTileset));
  const outputContentDir = path.join(outputDir, outputModelName);
  const tileset = JSON.parse(await fsp.readFile(inputTileset, "utf8"));
  const fileIndex = await buildFileIndex(inputDir);
  const jobs = [];

  collectContentJobs(tileset.root, inputDir, fileIndex, outputContentDir, outputModelName, jobs);
  if (!jobs.length) throw new Error(`No b3dm content found in ${inputTileset}`);

  await fsp.rm(outputContentDir, { recursive: true, force: true });
  await fsp.mkdir(outputContentDir, { recursive: true });

  const totals = {
    files: 0,
    originalBytes: 0,
    outputBytes: 0,
    originalTriangles: 0,
    outputTriangles: 0,
    removedTriangles: 0,
    originalVertices: 0,
    outputVertices: 0,
    simplifiedPrimitives: 0,
  };

  for (const [index, job] of jobs.entries()) {
    const result = await simplifyB3dm(job.sourcePath, job.outputPath, options);
    for (const key of Object.keys(totals)) totals[key] += result[key] ?? 0;
    console.log(`[${index + 1}/${jobs.length}] ${path.basename(job.sourcePath)} triangles ${result.originalTriangles} -> ${result.outputTriangles}, vertices ${result.originalVertices} -> ${result.outputVertices}`);
  }

  await fsp.mkdir(path.dirname(outputTileset), { recursive: true });
  await fsp.writeFile(outputTileset, `${JSON.stringify(tileset, null, 2)}\n`);

  console.log(`Grid size: ${options.gridSize}`);
  if (options.cellSize !== undefined) console.log(`Cell size: ${options.cellSize}`);
  console.log(`Position mode: ${options.positionMode}`);
  console.log(`Keep _BATCHID boundaries: ${options.keepBatchBoundaries}`);
  console.log(`Processed b3dm files: ${totals.files}`);
  console.log(`Simplified primitives: ${totals.simplifiedPrimitives}`);
  console.log(`Triangles: ${totals.originalTriangles} -> ${totals.outputTriangles} (-${totals.removedTriangles})`);
  console.log(`Vertices: ${totals.originalVertices} -> ${totals.outputVertices}`);
  console.log(`B3dm size: ${formatBytes(totals.originalBytes)} -> ${formatBytes(totals.outputBytes)}`);
  console.log(`Output tileset: ${outputTileset}`);
}

function printUsage() {
  console.log(`Usage:
  node optimize3dtiles/createVertexClusterSimplifyTileset.js [inputTileset.json] [outputTileset.json] [options]

Options:
  --grid-size <n>       Number of clustering cells along the largest primitive
                        axis. Smaller values simplify more. Default: 512
  --cell-size <n>       Absolute clustering cell size in model coordinates.
                        Overrides --grid-size.
  --position <mode>     average or representative. Default: average
  --merge-batches       Allow vertices with different _BATCHID values to merge.
                        Default keeps _BATCHID boundaries separate.

This is a real geometry simplification test based on vertex clustering. It
collapses nearby vertices, rebuilds indices, and removes degenerate triangles.
It does not directly delete every Nth triangle like createTriangleRatioTileset.js.`);
}

function makeDefaultOutput(inputTileset, gridSize) {
  const ext = path.extname(inputTileset);
  const base = path.basename(inputTileset, ext);
  return path.join(path.dirname(inputTileset), `${base}_vc${Math.round(gridSize)}${ext}`);
}

function readNumberOption(args, name, fallback) {
  const value = readStringOption(args, name);
  return value === undefined ? fallback : Number(value);
}

function readOptionalNumberOption(args, name) {
  const value = readStringOption(args, name);
  return value === undefined ? undefined : Number(value);
}

function readStringOption(args, name, fallback = undefined) {
  const equal = args.find((arg) => arg.startsWith(`${name}=`));
  if (equal) return equal.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return fallback;
}

function validateOptions(options) {
  if (!Number.isFinite(options.gridSize) || options.gridSize < 2) {
    throw new Error("--grid-size must be a number greater than or equal to 2.");
  }
  if (options.cellSize !== undefined && (!Number.isFinite(options.cellSize) || options.cellSize <= 0)) {
    throw new Error("--cell-size must be a positive number.");
  }
  if (!["average", "representative"].includes(options.positionMode)) {
    throw new Error("--position must be average or representative.");
  }
}

async function buildFileIndex(rootDir) {
  const index = new Map();
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else {
        const key = entry.name.toLowerCase();
        const bucket = index.get(key);
        if (bucket) bucket.push(fullPath);
        else index.set(key, [fullPath]);
      }
    }));
  }
  await walk(rootDir);
  return index;
}

function collectContentJobs(tile, baseDir, fileIndex, outputContentDir, outputModelName, jobs) {
  if (!tile) return;
  const content = tile.content;
  const uri = content?.uri ?? content?.url;
  if (uri && stripUriQuery(uri).toLowerCase().endsWith(".b3dm")) {
    const sourcePath = resolveContentPath(uri, baseDir, fileIndex);
    const outputName = path.basename(sourcePath);
    const outputPath = path.join(outputContentDir, outputName);
    const outputUri = `./${outputModelName}/${encodeURIComponent(outputName).replaceAll("%2E", ".")}`;
    if (content.uri !== undefined) content.uri = outputUri;
    else content.url = outputUri;
    jobs.push({ sourcePath, outputPath });
  }
  for (const child of tile.children ?? []) collectContentJobs(child, baseDir, fileIndex, outputContentDir, outputModelName, jobs);
}

function resolveContentPath(uri, baseDir, fileIndex) {
  const clean = stripUriQuery(uri);
  const decoded = safeDecodeUri(clean).replaceAll("/", path.sep);
  const direct = path.resolve(baseDir, decoded);
  if (fs.existsSync(direct)) return direct;
  const fallbackName = path.basename(decoded).toLowerCase();
  const matches = fileIndex.get(fallbackName) ?? [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const normalized = decoded.toLowerCase();
    return matches.find((item) => item.toLowerCase().endsWith(normalized)) ?? matches[0];
  }
  throw new Error(`Content file not found: ${uri}`);
}

async function simplifyB3dm(inputPath, outputPath, options) {
  const b3dm = await fsp.readFile(inputPath);
  const parsed = parseB3dm(b3dm);
  const simplified = simplifyGlb(parsed.glb, options);
  const output = Buffer.concat([parsed.prefix, simplified.buffer]);
  output.writeUInt32LE(output.length, 8);
  await fsp.writeFile(outputPath, output);
  return {
    files: 1,
    originalBytes: b3dm.length,
    outputBytes: output.length,
    originalTriangles: simplified.originalTriangles,
    outputTriangles: simplified.outputTriangles,
    removedTriangles: simplified.removedTriangles,
    originalVertices: simplified.originalVertices,
    outputVertices: simplified.outputVertices,
    simplifiedPrimitives: simplified.simplifiedPrimitives,
  };
}

function parseB3dm(buffer) {
  if (buffer.toString("utf8", 0, 4) !== "b3dm") throw new Error("Invalid b3dm magic.");
  const featureJsonLength = buffer.readUInt32LE(12);
  const featureBinLength = buffer.readUInt32LE(16);
  const batchJsonLength = buffer.readUInt32LE(20);
  const batchBinLength = buffer.readUInt32LE(24);
  let glbOffset = 28 + featureJsonLength + featureBinLength + batchJsonLength + batchBinLength;
  if (buffer.toString("utf8", glbOffset, glbOffset + 4) !== "glTF") glbOffset = buffer.indexOf(Buffer.from("glTF"), 20);
  if (glbOffset < 0) throw new Error("Could not locate embedded GLB in b3dm.");
  return { prefix: Buffer.from(buffer.subarray(0, glbOffset)), glb: buffer.subarray(glbOffset) };
}

function parseGlb(buffer) {
  if (buffer.toString("utf8", 0, 4) !== "glTF") throw new Error("Invalid GLB magic.");
  const length = buffer.readUInt32LE(8);
  let offset = 12;
  let gltf = null;
  let bin = null;
  while (offset + 8 <= length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkType === GLB_JSON) gltf = JSON.parse(buffer.toString("utf8", chunkStart, chunkEnd).trim());
    else if (chunkType === GLB_BIN) bin = buffer.subarray(chunkStart, chunkEnd);
    offset = chunkEnd;
  }
  if (!gltf || !bin) throw new Error("GLB must contain JSON and BIN chunks.");
  return { gltf, bin };
}

function simplifyGlb(sourceGlb, options) {
  const { gltf, bin } = parseGlb(sourceGlb);
  const target = structuredClone(gltf);
  target.accessors = [];
  target.bufferViews = [];
  target.buffers = [{ byteLength: 0 }];
  const chunks = [];
  const stats = {
    originalTriangles: 0,
    outputTriangles: 0,
    removedTriangles: 0,
    originalVertices: 0,
    outputVertices: 0,
    simplifiedPrimitives: 0,
  };

  remapNonGeometryBufferViews(gltf, target, bin, chunks);

  target.meshes = (gltf.meshes ?? []).map((mesh) => {
    const nextMesh = { ...mesh, primitives: [] };
    for (const primitive of mesh.primitives ?? []) {
      const result = simplifyPrimitive(gltf, bin, primitive, target, chunks, options);
      nextMesh.primitives.push(result.primitive);
      stats.originalTriangles += result.originalTriangles;
      stats.outputTriangles += result.outputTriangles;
      stats.removedTriangles += result.removedTriangles;
      stats.originalVertices += result.originalVertices;
      stats.outputVertices += result.outputVertices;
      if (result.simplified) stats.simplifiedPrimitives += 1;
    }
    return nextMesh;
  });

  return { buffer: buildGlb(target, chunks), ...stats };
}

function simplifyPrimitive(source, bin, primitive, target, chunks, options) {
  if ((primitive.mode ?? 4) !== 4 || primitive.attributes?.POSITION === undefined) {
    return preservePrimitive(source, bin, primitive, target, chunks);
  }

  const positionAccessor = source.accessors[primitive.attributes.POSITION];
  if (positionAccessor.componentType !== 5126 || positionAccessor.type !== "VEC3") {
    return preservePrimitive(source, bin, primitive, target, chunks);
  }

  const sourceIndices = primitive.indices !== undefined
    ? readIndexArray(source, bin, source.accessors[primitive.indices])
    : makeSequentialIndices(positionAccessor.count);
  const originalTriangles = Math.floor(sourceIndices.length / 3);
  const bounds = getPositionBounds(source, bin, positionAccessor);
  const cellSize = options.cellSize ?? chooseCellSize(bounds, options.gridSize);
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    return preservePrimitive(source, bin, primitive, target, chunks);
  }

  const clusterMap = new Map();
  const clusters = [];
  const outputIndices = [];
  let removedTriangles = 0;

  function getClusterIndex(sourceIndex) {
    const position = readPosition(source, bin, positionAccessor, sourceIndex);
    const key = makeClusterKey(source, bin, primitive, sourceIndex, position, bounds.min, cellSize, options);
    let clusterIndex = clusterMap.get(key);
    if (clusterIndex !== undefined) {
      const cluster = clusters[clusterIndex];
      cluster.count += 1;
      cluster.sum[0] += position[0];
      cluster.sum[1] += position[1];
      cluster.sum[2] += position[2];
      return clusterIndex;
    }

    clusterIndex = clusters.length;
    clusterMap.set(key, clusterIndex);
    clusters.push({
      sourceIndex,
      sum: [position[0], position[1], position[2]],
      count: 1,
    });
    return clusterIndex;
  }

  for (let i = 0; i + 2 < sourceIndices.length; i += 3) {
    const a = getClusterIndex(sourceIndices[i]);
    const b = getClusterIndex(sourceIndices[i + 1]);
    const c = getClusterIndex(sourceIndices[i + 2]);
    if (a === b || b === c || a === c) {
      removedTriangles += 1;
      continue;
    }
    outputIndices.push(a, b, c);
  }

  if (!outputIndices.length) {
    return preservePrimitive(source, bin, primitive, target, chunks);
  }

  const positions = clusters.map((cluster) => {
    if (options.positionMode === "representative") {
      return readPosition(source, bin, positionAccessor, cluster.sourceIndex);
    }
    return [
      cluster.sum[0] / cluster.count,
      cluster.sum[1] / cluster.count,
      cluster.sum[2] / cluster.count,
    ];
  });
  const representativeVertices = clusters.map((cluster) => cluster.sourceIndex);
  const attributes = {};

  for (const [semantic, accessorIndex] of Object.entries(primitive.attributes ?? {})) {
    if (semantic === "POSITION") attributes[semantic] = addPositionAccessor(target, chunks, positions);
    else attributes[semantic] = addRemappedAttributeAccessor(source, bin, target, chunks, accessorIndex, representativeVertices);
  }

  const indexAccessor = addIndexAccessor(target, chunks, outputIndices);
  return {
    primitive: { ...primitive, attributes, indices: indexAccessor },
    originalTriangles,
    outputTriangles: Math.floor(outputIndices.length / 3),
    removedTriangles,
    originalVertices: positionAccessor.count,
    outputVertices: clusters.length,
    simplified: true,
  };
}

function makeClusterKey(source, bin, primitive, sourceIndex, position, min, cellSize, options) {
  const x = Math.floor((position[0] - min[0]) / cellSize);
  const y = Math.floor((position[1] - min[1]) / cellSize);
  const z = Math.floor((position[2] - min[2]) / cellSize);
  let key = `${x},${y},${z}`;
  if (options.keepBatchBoundaries) {
    const batchAccessorIndex = primitive.attributes?._BATCHID ?? primitive.attributes?._FEATURE_ID_0;
    if (batchAccessorIndex !== undefined) {
      key += `|b:${accessorElementKey(source, bin, source.accessors[batchAccessorIndex], sourceIndex)}`;
    }
  }
  return key;
}

function accessorElementKey(source, bin, accessor, index) {
  const view = source.bufferViews[accessor.bufferView];
  const elementSize = getAccessorElementSize(accessor);
  const stride = view.byteStride ?? elementSize;
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * stride;
  return bin.subarray(offset, offset + elementSize).toString("hex");
}

function chooseCellSize(bounds, gridSize) {
  const span = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  const maxSpan = Math.max(...span);
  return maxSpan / gridSize;
}

function getPositionBounds(source, bin, accessor) {
  if (accessor.min?.length === 3 && accessor.max?.length === 3) {
    return { min: [...accessor.min], max: [...accessor.max] };
  }

  const bounds = createBounds();
  for (let index = 0; index < accessor.count; index += 1) {
    expandBounds(bounds, readPosition(source, bin, accessor, index));
  }
  return bounds;
}

function preservePrimitive(source, bin, primitive, target, chunks) {
  const attributes = {};
  let vertices = 0;
  for (const [semantic, accessorIndex] of Object.entries(primitive.attributes ?? {})) {
    attributes[semantic] = addCopiedAccessor(source, bin, target, chunks, accessorIndex, ARRAY_BUFFER);
    if (semantic === "POSITION") vertices = source.accessors[accessorIndex].count;
  }
  const nextPrimitive = { ...primitive, attributes };
  let triangles = 0;
  if (primitive.indices !== undefined) {
    triangles = Math.floor(source.accessors[primitive.indices].count / 3);
    nextPrimitive.indices = addCopiedAccessor(source, bin, target, chunks, primitive.indices, ELEMENT_ARRAY_BUFFER);
  } else if (primitive.attributes?.POSITION !== undefined) {
    triangles = Math.floor(source.accessors[primitive.attributes.POSITION].count / 3);
  }
  return {
    primitive: nextPrimitive,
    originalTriangles: triangles,
    outputTriangles: triangles,
    removedTriangles: 0,
    originalVertices: vertices,
    outputVertices: vertices,
    simplified: false,
  };
}

function remapNonGeometryBufferViews(source, target, bin, chunks) {
  const remapped = new Map();
  function remapBufferView(bufferViewIndex) {
    if (bufferViewIndex === undefined) return undefined;
    if (!remapped.has(bufferViewIndex)) {
      const view = source.bufferViews[bufferViewIndex];
      remapped.set(bufferViewIndex, addBufferView(target, chunks, copyBufferView(bin, view), {
        target: view.target,
        byteStride: view.byteStride,
      }));
    }
    return remapped.get(bufferViewIndex);
  }
  for (const image of target.images ?? []) {
    if (image.bufferView !== undefined) image.bufferView = remapBufferView(image.bufferView);
  }
}

function addPositionAccessor(gltf, chunks, positions) {
  const data = Buffer.allocUnsafe(positions.length * 12);
  const bounds = createBounds();
  for (let i = 0; i < positions.length; i += 1) {
    const position = positions[i];
    data.writeFloatLE(position[0], i * 12);
    data.writeFloatLE(position[1], i * 12 + 4);
    data.writeFloatLE(position[2], i * 12 + 8);
    expandBounds(bounds, position);
  }
  const viewIndex = addBufferView(gltf, chunks, data, { target: ARRAY_BUFFER });
  return addAccessor(gltf, {
    bufferView: viewIndex,
    byteOffset: 0,
    componentType: 5126,
    count: positions.length,
    type: "VEC3",
    min: bounds.min,
    max: bounds.max,
  });
}

function addIndexAccessor(gltf, chunks, indices) {
  const maxIndex = indices.reduce((max, value) => Math.max(max, value), 0);
  const componentType = maxIndex <= 65535 ? 5123 : 5125;
  const bytes = componentType === 5123 ? 2 : 4;
  const data = Buffer.allocUnsafe(indices.length * bytes);
  for (let i = 0; i < indices.length; i += 1) {
    if (componentType === 5123) data.writeUInt16LE(indices[i], i * 2);
    else data.writeUInt32LE(indices[i], i * 4);
  }
  const viewIndex = addBufferView(gltf, chunks, data, { target: ELEMENT_ARRAY_BUFFER });
  return addAccessor(gltf, {
    bufferView: viewIndex,
    byteOffset: 0,
    componentType,
    count: indices.length,
    type: "SCALAR",
    min: [0],
    max: [maxIndex],
  });
}

function addRemappedAttributeAccessor(source, bin, target, chunks, accessorIndex, vertices) {
  const accessor = source.accessors[accessorIndex];
  const elementSize = getAccessorElementSize(accessor);
  const data = Buffer.allocUnsafe(vertices.length * elementSize);
  for (let i = 0; i < vertices.length; i += 1) {
    copyAccessorElement(source, bin, accessor, vertices[i], data, i * elementSize);
  }
  const viewIndex = addBufferView(target, chunks, data, { target: ARRAY_BUFFER });
  const nextAccessor = cloneAccessorForSubset(source, bin, accessor, viewIndex, vertices);
  return addAccessor(target, nextAccessor);
}

function addCopiedAccessor(source, bin, target, chunks, accessorIndex, bufferTarget) {
  const accessor = source.accessors[accessorIndex];
  const elementSize = getAccessorElementSize(accessor);
  const data = Buffer.allocUnsafe(accessor.count * elementSize);
  for (let i = 0; i < accessor.count; i += 1) {
    copyAccessorElement(source, bin, accessor, i, data, i * elementSize);
  }
  const viewIndex = addBufferView(target, chunks, data, { target: bufferTarget });
  const nextAccessor = { ...accessor, bufferView: viewIndex, byteOffset: 0 };
  delete nextAccessor.sparse;
  return addAccessor(target, nextAccessor);
}

function cloneAccessorForSubset(source, bin, accessor, bufferView, vertices) {
  const next = { ...accessor, bufferView, byteOffset: 0, count: vertices.length };
  delete next.sparse;
  if (accessor.min || accessor.max) {
    const bounds = computeAccessorBounds(source, bin, accessor, vertices);
    next.min = bounds.min;
    next.max = bounds.max;
  }
  return next;
}

function computeAccessorBounds(source, bin, accessor, vertices) {
  const components = TYPE_COMPONENTS.get(accessor.type);
  const min = new Array(components).fill(Number.POSITIVE_INFINITY);
  const max = new Array(components).fill(Number.NEGATIVE_INFINITY);
  for (const vertex of vertices) {
    for (let component = 0; component < components; component += 1) {
      const value = readAccessorComponent(source, bin, accessor, vertex, component);
      if (value < min[component]) min[component] = value;
      if (value > max[component]) max[component] = value;
    }
  }
  return { min, max };
}

function readAccessorComponent(source, bin, accessor, index, component) {
  const view = source.bufferViews[accessor.bufferView];
  const componentSize = COMPONENT_BYTES.get(accessor.componentType);
  const elementSize = getAccessorElementSize(accessor);
  const stride = view.byteStride ?? elementSize;
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * stride + component * componentSize;
  switch (accessor.componentType) {
    case 5120: return bin.readInt8(offset);
    case 5121: return bin.readUInt8(offset);
    case 5122: return bin.readInt16LE(offset);
    case 5123: return bin.readUInt16LE(offset);
    case 5125: return bin.readUInt32LE(offset);
    case 5126: return bin.readFloatLE(offset);
    default: throw new Error(`Unsupported component type: ${accessor.componentType}`);
  }
}

function copyAccessorElement(source, bin, accessor, index, target, targetOffset) {
  const view = source.bufferViews[accessor.bufferView];
  const elementSize = getAccessorElementSize(accessor);
  const stride = view.byteStride ?? elementSize;
  const sourceOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * stride;
  bin.copy(target, targetOffset, sourceOffset, sourceOffset + elementSize);
}

function readPosition(source, bin, accessor, index) {
  return [
    readAccessorComponent(source, bin, accessor, index, 0),
    readAccessorComponent(source, bin, accessor, index, 1),
    readAccessorComponent(source, bin, accessor, index, 2),
  ];
}

function getAccessorElementSize(accessor) {
  const componentBytes = COMPONENT_BYTES.get(accessor.componentType);
  const components = TYPE_COMPONENTS.get(accessor.type);
  if (!componentBytes || !components) {
    throw new Error(`Unsupported accessor layout: ${accessor.componentType} ${accessor.type}`);
  }
  return componentBytes * components;
}

function readIndexArray(source, bin, accessor) {
  const view = source.bufferViews[accessor.bufferView];
  const stride = view.byteStride ?? COMPONENT_BYTES.get(accessor.componentType);
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const result = new Array(accessor.count);
  for (let i = 0; i < accessor.count; i += 1) {
    const cursor = offset + i * stride;
    if (accessor.componentType === 5125) result[i] = bin.readUInt32LE(cursor);
    else if (accessor.componentType === 5123) result[i] = bin.readUInt16LE(cursor);
    else if (accessor.componentType === 5121) result[i] = bin.readUInt8(cursor);
    else throw new Error(`Unsupported index component type: ${accessor.componentType}`);
  }
  return result;
}

function makeSequentialIndices(count) {
  return Array.from({ length: count }, (_, index) => index);
}

function copyBufferView(bin, view) {
  return Buffer.from(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
}

function addBufferView(gltf, chunks, buffer, options = {}) {
  const index = gltf.bufferViews.length;
  gltf.bufferViews.push({
    buffer: 0,
    byteOffset: 0,
    byteLength: buffer.length,
    ...(options.byteStride ? { byteStride: options.byteStride } : {}),
    ...(options.target ? { target: options.target } : {}),
  });
  chunks.push({ viewIndex: index, buffer });
  return index;
}

function addAccessor(gltf, accessor) {
  const index = gltf.accessors.length;
  gltf.accessors.push(accessor);
  return index;
}

function buildGlb(gltf, chunks) {
  let offset = 0;
  for (const chunk of chunks) {
    offset = align4(offset);
    chunk.offset = offset;
    gltf.bufferViews[chunk.viewIndex].byteOffset = offset;
    offset += chunk.buffer.length;
  }
  const bin = Buffer.alloc(align4(offset));
  for (const chunk of chunks) chunk.buffer.copy(bin, chunk.offset);
  gltf.buffers[0].byteLength = bin.length;
  const json = padJson(Buffer.from(JSON.stringify(gltf), "utf8"));
  const binPadded = padBin(bin);
  const totalLength = 12 + 8 + json.length + 8 + binPadded.length;
  const glb = Buffer.allocUnsafe(totalLength);
  glb.write("glTF", 0, 4, "utf8");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(totalLength, 8);
  glb.writeUInt32LE(json.length, 12);
  glb.writeUInt32LE(GLB_JSON, 16);
  json.copy(glb, 20);
  const binHeader = 20 + json.length;
  glb.writeUInt32LE(binPadded.length, binHeader);
  glb.writeUInt32LE(GLB_BIN, binHeader + 4);
  binPadded.copy(glb, binHeader + 8);
  return glb;
}

function createBounds() {
  return {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  };
}

function expandBounds(bounds, point) {
  for (let i = 0; i < 3; i += 1) {
    if (point[i] < bounds.min[i]) bounds.min[i] = point[i];
    if (point[i] > bounds.max[i]) bounds.max[i] = point[i];
  }
}

function stripUriQuery(uri) {
  return uri.split("#", 1)[0].split("?", 1)[0];
}

function safeDecodeUri(uri) {
  try {
    return decodeURI(uri);
  } catch {
    return uri;
  }
}

function align4(value) {
  return (value + 3) & ~3;
}

function padJson(buffer) {
  const padded = Buffer.alloc(align4(buffer.length), 0x20);
  buffer.copy(padded);
  return padded;
}

function padBin(buffer) {
  if (buffer.length % 4 === 0) return buffer;
  const padded = Buffer.alloc(align4(buffer.length));
  buffer.copy(padded);
  return padded;
}

function formatBytes(value) {
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
