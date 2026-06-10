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
  const inputTileset = path.resolve(positional[0] ?? "static/models/横琴示范区.json");
  const outputTileset = path.resolve(positional[1] ?? makeDefaultOutput(inputTileset));
  const options = {
    ratio: readNumberOption(args, "--ratio", 0.25),
    minTriangles: readNumberOption(args, "--min-triangles", 200),
    minBytes: readSizeOption(args, "--min-bytes", 256 * 1024),
    maxVertices: readNumberOption(args, "--max-vertices", 60000),
  };

  if (options.ratio <= 0 || options.ratio >= 1) {
    throw new Error("--ratio must be greater than 0 and less than 1.");
  }
  if (options.minTriangles < 1) throw new Error("--min-triangles must be greater than 0.");
  if (options.maxVertices < 3 || options.maxVertices > 65535) {
    throw new Error("--max-vertices must be between 3 and 65535.");
  }

  const inputDir = path.dirname(inputTileset);
  const outputDir = path.dirname(outputTileset);
  const outputModelName = path.basename(outputTileset, path.extname(outputTileset));
  const outputContentDir = path.join(outputDir, outputModelName);
  const tileset = JSON.parse(await fsp.readFile(inputTileset, "utf8"));
  const fileIndex = await buildFileIndex(inputDir);

  await fsp.mkdir(outputContentDir, { recursive: true });

  const totals = {
    contentTiles: 0,
    lodTiles: 0,
    copiedTiles: 0,
    originalBytes: 0,
    lodBytes: 0,
    originalTriangles: 0,
    lodTriangles: 0,
  };

  await processTile(tileset.root, {
    baseDir: inputDir,
    fileIndex,
    outputModelName,
    outputContentDir,
    options,
    totals,
  });

  await fsp.mkdir(path.dirname(outputTileset), { recursive: true });
  await fsp.writeFile(outputTileset, `${JSON.stringify(tileset, null, 2)}\n`);

  console.log(`Content tiles: ${totals.contentTiles}`);
  console.log(`LOD parent tiles generated: ${totals.lodTiles}`);
  console.log(`Tiles left exact-only: ${totals.copiedTiles}`);
  console.log(`Triangles in exact model: ${totals.originalTriangles}`);
  console.log(`Triangles in LOD layer: ${totals.lodTriangles}`);
  console.log(`Original b3dm size referenced: ${formatBytes(totals.originalBytes)}`);
  console.log(`New LOD b3dm size: ${formatBytes(totals.lodBytes)}`);
  console.log(`Output tileset: ${outputTileset}`);
}

function printUsage() {
  console.log(`Usage:
  node optimize3dtiles/createLodTileset.js [inputTileset.json] [outputTileset.json] [options]

Options:
  --ratio <n>          Triangle keep ratio for the coarse LOD layer.
                       Default: 0.25
  --min-triangles <n>  Do not build a coarse LOD for b3dm files with fewer
                       triangles than this. Default: 200
  --min-bytes <size>   Do not build a coarse LOD for b3dm files smaller than
                       this. Supports bytes, kb, mb. Default: 256kb
  --max-vertices <n>   Maximum unique vertices per generated primitive.
                       Must be <= 65535. Default: 60000

The output tileset keeps the original exact b3dm content as children and adds
simplified parent b3dm content for distant display. Original model files are
not overwritten or duplicated.`);
}

function readNumberOption(args, name, fallback) {
  const equal = args.find((arg) => arg.startsWith(`${name}=`));
  if (equal) return Number(equal.slice(name.length + 1));
  const index = args.indexOf(name);
  if (index >= 0) return Number(args[index + 1]);
  return fallback;
}

function readSizeOption(args, name, fallback) {
  const raw = readStringOption(args, name);
  if (!raw) return fallback;
  const match = String(raw).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(b|kb|k|mb|m)?$/);
  if (!match) throw new Error(`Invalid size for ${name}: ${raw}`);
  const value = Number(match[1]);
  const unit = match[2] ?? "b";
  if (unit === "mb" || unit === "m") return Math.floor(value * 1024 * 1024);
  if (unit === "kb" || unit === "k") return Math.floor(value * 1024);
  return Math.floor(value);
}

function readStringOption(args, name) {
  const equal = args.find((arg) => arg.startsWith(`${name}=`));
  if (equal) return equal.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return undefined;
}

function makeDefaultOutput(inputTileset) {
  const ext = path.extname(inputTileset);
  const base = path.basename(inputTileset, ext);
  return path.join(path.dirname(inputTileset), `${base}_lod${ext}`);
}

async function buildFileIndex(rootDir) {
  const index = new Map();

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
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

async function processTile(tile, context) {
  if (!tile) return;

  const originalChildren = tile.children ?? [];
  for (const child of originalChildren) {
    await processTile(child, context);
  }

  const content = tile.content;
  const uri = content?.uri ?? content?.url;
  if (!uri || !stripUriQuery(uri).toLowerCase().endsWith(".b3dm")) return;

  const sourcePath = resolveContentPath(uri, context.baseDir, context.fileIndex);
  const sourceBytes = (await fsp.stat(sourcePath)).size;
  const sourceName = sanitizeFileName(path.basename(sourcePath, path.extname(sourcePath)));

  context.totals.contentTiles += 1;
  context.totals.originalBytes += sourceBytes;

  const sourceStats = await inspectB3dm(sourcePath);
  context.totals.originalTriangles += sourceStats.triangles;

  if (sourceBytes < context.options.minBytes || sourceStats.triangles < context.options.minTriangles) {
    context.totals.copiedTiles += 1;
    return;
  }

  const lod = await createLodB3dm(sourcePath, context.options);
  if (!lod || lod.triangles >= sourceStats.triangles) {
    context.totals.copiedTiles += 1;
    return;
  }

  const lodName = `${sourceName}_lod.b3dm`;
  const lodPath = path.join(context.outputContentDir, lodName);
  await fsp.writeFile(lodPath, lod.buffer);

  const exactContent = structuredClone(content);
  setContentUri(content, `./${context.outputModelName}/${lodName}`);

  tile.children = [
    {
      boundingVolume: structuredClone(tile.boundingVolume),
      content: exactContent,
      geometricError: 0,
      refine: "REPLACE",
    },
    ...originalChildren,
  ];

  if (!tile.refine) tile.refine = "REPLACE";
  if (!Number.isFinite(tile.geometricError) || tile.geometricError <= 0) {
    tile.geometricError = estimateGeometricError(tile.boundingVolume);
  }

  context.totals.lodTiles += 1;
  context.totals.lodBytes += lod.buffer.length;
  context.totals.lodTriangles += lod.triangles;
}

function setContentUri(content, uri) {
  if (content.uri !== undefined) content.uri = uri;
  else content.url = uri;
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

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

async function inspectB3dm(inputPath) {
  const b3dm = await fsp.readFile(inputPath);
  const parsed = parseB3dm(b3dm);
  const { gltf } = parseGlb(parsed.glb);
  return { triangles: countTriangles(gltf) };
}

async function createLodB3dm(inputPath, options) {
  const b3dm = await fsp.readFile(inputPath);
  const parsed = parseB3dm(b3dm);
  const lod = simplifyGlb(parsed.glb, options);
  if (!lod) return null;

  const output = Buffer.concat([parsed.prefix, lod.buffer]);
  output.writeUInt32LE(output.length, 8);
  return { buffer: output, triangles: lod.triangles };
}

function parseB3dm(buffer) {
  if (buffer.toString("utf8", 0, 4) !== "b3dm") {
    throw new Error("Invalid b3dm magic.");
  }

  const version = buffer.readUInt32LE(4);
  if (version !== 1) throw new Error(`Unsupported b3dm version: ${version}`);

  const featureJsonLength = buffer.readUInt32LE(12);
  const featureBinLength = buffer.readUInt32LE(16);
  const batchJsonLength = buffer.readUInt32LE(20);
  const batchBinLength = buffer.readUInt32LE(24);
  let glbOffset = 28 + featureJsonLength + featureBinLength + batchJsonLength + batchBinLength;

  if (buffer.toString("utf8", glbOffset, glbOffset + 4) !== "glTF") {
    glbOffset = buffer.indexOf(Buffer.from("glTF"), 20);
  }
  if (glbOffset < 0) throw new Error("Could not locate embedded GLB in b3dm.");

  return {
    prefix: Buffer.from(buffer.subarray(0, glbOffset)),
    glb: buffer.subarray(glbOffset),
  };
}

function parseGlb(buffer) {
  if (buffer.toString("utf8", 0, 4) !== "glTF") {
    throw new Error("Invalid GLB magic.");
  }

  const version = buffer.readUInt32LE(4);
  if (version !== 2) throw new Error(`Only GLB v2 is supported. Found v${version}.`);

  const length = buffer.readUInt32LE(8);
  let offset = 12;
  let gltf = null;
  let bin = null;

  while (offset + 8 <= length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;

    if (chunkType === GLB_JSON) {
      gltf = JSON.parse(buffer.toString("utf8", chunkStart, chunkEnd).trim());
    } else if (chunkType === GLB_BIN) {
      bin = buffer.subarray(chunkStart, chunkEnd);
    }

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
  const stats = { originalTriangles: 0, lodTriangles: 0 };

  remapNonGeometryBufferViews(gltf, target, bin, chunks);

  target.meshes = (gltf.meshes ?? []).map((mesh) => {
    const nextMesh = { ...mesh, primitives: [] };
    for (const primitive of mesh.primitives ?? []) {
      const simplified = simplifyPrimitive(gltf, bin, primitive, target, chunks, options);
      nextMesh.primitives.push(...simplified.primitives);
      stats.originalTriangles += simplified.originalTriangles;
      stats.lodTriangles += simplified.lodTriangles;
    }
    return nextMesh;
  });

  if (stats.lodTriangles <= 0 || stats.lodTriangles >= stats.originalTriangles) return null;

  return {
    buffer: buildGlb(target, chunks),
    triangles: stats.lodTriangles,
  };
}

function remapNonGeometryBufferViews(source, target, bin, chunks) {
  const remappedViews = new Map();

  function remapBufferView(bufferViewIndex) {
    if (bufferViewIndex === undefined) return undefined;
    if (!remappedViews.has(bufferViewIndex)) {
      const view = source.bufferViews[bufferViewIndex];
      remappedViews.set(bufferViewIndex, addBufferView(target, chunks, copyBufferView(bin, view), {
        target: view.target,
        byteStride: view.byteStride,
      }));
    }
    return remappedViews.get(bufferViewIndex);
  }

  for (const image of target.images ?? []) {
    if (image.bufferView !== undefined) image.bufferView = remapBufferView(image.bufferView);
  }

  for (const skin of target.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined) {
      skin.inverseBindMatrices = addCopiedAccessor(source, bin, target, chunks, skin.inverseBindMatrices, undefined);
    }
  }

  for (const animation of target.animations ?? []) {
    for (const sampler of animation.samplers ?? []) {
      if (sampler.input !== undefined) sampler.input = addCopiedAccessor(source, bin, target, chunks, sampler.input, undefined);
      if (sampler.output !== undefined) sampler.output = addCopiedAccessor(source, bin, target, chunks, sampler.output, undefined);
    }
  }
}

function simplifyPrimitive(source, bin, primitive, target, chunks, options) {
  if ((primitive.mode ?? 4) !== 4 || primitive.attributes?.POSITION === undefined) {
    return preservePrimitive(source, bin, primitive, target, chunks);
  }

  const positionAccessor = source.accessors[primitive.attributes.POSITION];
  const sourceIndices = primitive.indices !== undefined
    ? readIndexArray(source, bin, source.accessors[primitive.indices])
    : makeSequentialIndices(positionAccessor.count);
  const originalTriangles = Math.floor(sourceIndices.length / 3);
  const targetTriangles = Math.max(1, Math.floor(originalTriangles * options.ratio));
  const selectedTriangles = selectTriangles(sourceIndices, targetTriangles);
  const parts = buildPrimitiveParts(selectedTriangles, options.maxVertices);
  const primitives = parts.map((part) => buildSplitPrimitive(source, bin, primitive, target, chunks, part));

  return {
    primitives,
    originalTriangles,
    lodTriangles: selectedTriangles.length,
  };
}

function preservePrimitive(source, bin, primitive, target, chunks) {
  const attributes = {};
  for (const [semantic, accessorIndex] of Object.entries(primitive.attributes ?? {})) {
    attributes[semantic] = addCopiedAccessor(source, bin, target, chunks, accessorIndex, ARRAY_BUFFER);
  }

  const nextPrimitive = { ...primitive, attributes };
  let indexCount = 0;
  if (primitive.indices !== undefined) {
    indexCount = source.accessors[primitive.indices].count;
    nextPrimitive.indices = addCopiedAccessor(source, bin, target, chunks, primitive.indices, ELEMENT_ARRAY_BUFFER);
  } else {
    delete nextPrimitive.indices;
  }

  return {
    primitives: [nextPrimitive],
    originalTriangles: Math.floor(indexCount / 3),
    lodTriangles: Math.floor(indexCount / 3),
  };
}

function selectTriangles(sourceIndices, targetTriangles) {
  const totalTriangles = Math.floor(sourceIndices.length / 3);
  if (targetTriangles >= totalTriangles) {
    return Array.from({ length: totalTriangles }, (_, triangle) => [
      sourceIndices[triangle * 3],
      sourceIndices[triangle * 3 + 1],
      sourceIndices[triangle * 3 + 2],
    ]);
  }

  const result = [];
  let lastTriangle = -1;
  for (let i = 0; i < targetTriangles; i += 1) {
    let triangle = Math.floor((i * totalTriangles) / targetTriangles);
    if (triangle <= lastTriangle) triangle = lastTriangle + 1;
    if (triangle >= totalTriangles) break;
    result.push([
      sourceIndices[triangle * 3],
      sourceIndices[triangle * 3 + 1],
      sourceIndices[triangle * 3 + 2],
    ]);
    lastTriangle = triangle;
  }
  return result;
}

function buildPrimitiveParts(triangles, maxVertices) {
  const parts = [];
  let vertexMap = new Map();
  let vertices = [];
  let indices = [];

  function flush() {
    if (!indices.length) return;
    parts.push({ vertices, indices });
    vertexMap = new Map();
    vertices = [];
    indices = [];
  }

  function getLocalIndex(originalIndex) {
    let local = vertexMap.get(originalIndex);
    if (local !== undefined) return local;
    local = vertices.length;
    vertexMap.set(originalIndex, local);
    vertices.push(originalIndex);
    return local;
  }

  for (const triangle of triangles) {
    let newVertexCount = 0;
    for (const index of triangle) {
      if (!vertexMap.has(index)) newVertexCount += 1;
    }
    if (indices.length && vertices.length + newVertexCount > maxVertices) flush();
    for (const index of triangle) indices.push(getLocalIndex(index));
  }

  flush();
  return parts;
}

function buildSplitPrimitive(source, bin, primitive, target, chunks, part) {
  const attributes = {};
  for (const [semantic, accessorIndex] of Object.entries(primitive.attributes ?? {})) {
    attributes[semantic] = addRemappedAttributeAccessor(source, bin, target, chunks, accessorIndex, part.vertices);
  }

  const indexBuffer = Buffer.allocUnsafe(part.indices.length * 2);
  let maxIndex = 0;
  for (let i = 0; i < part.indices.length; i += 1) {
    const value = part.indices[i];
    maxIndex = Math.max(maxIndex, value);
    indexBuffer.writeUInt16LE(value, i * 2);
  }

  const indexView = addBufferView(target, chunks, indexBuffer, { target: ELEMENT_ARRAY_BUFFER });
  const indexAccessor = addAccessor(target, {
    bufferView: indexView,
    componentType: 5123,
    count: part.indices.length,
    type: "SCALAR",
    min: [0],
    max: [maxIndex],
  });

  return { ...primitive, attributes, indices: indexAccessor };
}

function addRemappedAttributeAccessor(source, bin, target, chunks, accessorIndex, vertices) {
  const accessor = source.accessors[accessorIndex];
  const elementSize = getAccessorElementSize(accessor);
  const data = Buffer.allocUnsafe(vertices.length * elementSize);

  for (let i = 0; i < vertices.length; i += 1) {
    copyAccessorElement(source, bin, accessor, vertices[i], data, i * elementSize);
  }

  const viewIndex = addBufferView(target, chunks, data, { target: ARRAY_BUFFER });
  return addAccessor(target, cloneAccessorForSubset(source, bin, accessor, viewIndex, vertices));
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

function countTriangles(gltf) {
  let triangles = 0;
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4) continue;
      if (primitive.indices !== undefined) triangles += Math.floor(gltf.accessors[primitive.indices].count / 3);
      else if (primitive.attributes?.POSITION !== undefined) {
        triangles += Math.floor(gltf.accessors[primitive.attributes.POSITION].count / 3);
      }
    }
  }
  return triangles;
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
  for (const chunk of chunks) {
    chunk.buffer.copy(bin, chunk.offset);
  }
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

function estimateGeometricError(boundingVolume) {
  const box = boundingVolume?.box;
  if (!Array.isArray(box) || box.length < 12) return 100;
  const hx = Math.hypot(box[3], box[4], box[5]);
  const hy = Math.hypot(box[6], box[7], box[8]);
  const hz = Math.hypot(box[9], box[10], box[11]);
  return Math.max(1, Math.hypot(hx, hy, hz) * 0.5);
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
