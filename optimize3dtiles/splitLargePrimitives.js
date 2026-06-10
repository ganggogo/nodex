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
  const maxVertices = readNumberOption(args, "--max-vertices", 60000);

  if (maxVertices <= 0 || maxVertices > 65535) {
    throw new Error("--max-vertices must be between 1 and 65535.");
  }

  const inputDir = path.dirname(inputTileset);
  const outputDir = path.dirname(outputTileset);
  const outputModelName = path.basename(outputTileset, path.extname(outputTileset));
  const outputContentDir = path.join(outputDir, outputModelName);
  const tileset = JSON.parse(await fsp.readFile(inputTileset, "utf8"));
  const fileIndex = await buildFileIndex(inputDir);
  const jobs = [];

  collectContentJobs(tileset.root, inputDir, fileIndex, outputContentDir, outputModelName, jobs);
  if (!jobs.length) throw new Error(`No b3dm content found in ${inputTileset}`);

  await fsp.mkdir(outputContentDir, { recursive: true });

  const totals = {
    files: 0,
    originalBytes: 0,
    optimizedBytes: 0,
    originalPrimitives: 0,
    optimizedPrimitives: 0,
    originalTriangles: 0,
    optimizedTriangles: 0,
    convertedIndexAccessors: 0,
  };

  for (const job of jobs) {
    const result = await splitB3dmFile(job.sourcePath, job.outputPath, maxVertices);
    for (const key of Object.keys(totals)) totals[key] += result[key] ?? 0;
  }

  await fsp.mkdir(path.dirname(outputTileset), { recursive: true });
  await fsp.writeFile(outputTileset, `${JSON.stringify(tileset, null, 2)}\n`);

  console.log(`Processed ${totals.files} b3dm tile(s).`);
  console.log(`Primitives: ${totals.originalPrimitives} -> ${totals.optimizedPrimitives}`);
  console.log(`Triangles: ${totals.originalTriangles} -> ${totals.optimizedTriangles}`);
  console.log(`Index accessors converted to uint16: ${totals.convertedIndexAccessors}`);
  console.log(`Original size: ${formatBytes(totals.originalBytes)}`);
  console.log(`Optimized size: ${formatBytes(totals.optimizedBytes)}`);
  console.log(`Saved: ${formatBytes(totals.originalBytes - totals.optimizedBytes)}`);
  console.log(`Output tileset: ${outputTileset}`);
}

function printUsage() {
  console.log(`Usage:
  node optimize3dtiles/splitLargePrimitives.js [inputTileset.json] [outputTileset.json] [options]

Options:
  --max-vertices <n>  Maximum unique vertices per output primitive. Default: 60000

This keeps model attributes such as POSITION, NORMAL, TEXCOORD_0 and _BATCHID,
but splits large primitives and remaps indices so each output primitive can use
uint16 indices.`);
}

function readNumberOption(args, name, fallback) {
  const equal = args.find((arg) => arg.startsWith(`${name}=`));
  if (equal) return Number(equal.slice(name.length + 1));
  const index = args.indexOf(name);
  if (index >= 0) return Number(args[index + 1]);
  return fallback;
}

function makeDefaultOutput(inputTileset) {
  const ext = path.extname(inputTileset);
  const base = path.basename(inputTileset, ext);
  return path.join(path.dirname(inputTileset), `${base}_split_optimized${ext}`);
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

function collectContentJobs(tile, baseDir, fileIndex, outputContentDir, outputModelName, jobs) {
  if (!tile) return;
  const content = tile.content;
  const uri = content?.uri ?? content?.url;

  if (uri && stripUriQuery(uri).toLowerCase().endsWith(".b3dm")) {
    const sourcePath = resolveContentPath(uri, baseDir, fileIndex);
    const outputName = path.basename(sourcePath);
    const outputPath = path.join(outputContentDir, outputName);
    const outputUri = `./${outputModelName}/${outputName}`;

    if (content.uri !== undefined) content.uri = outputUri;
    else content.url = outputUri;

    jobs.push({ sourcePath, outputPath });
  }

  for (const child of tile.children ?? []) {
    collectContentJobs(child, baseDir, fileIndex, outputContentDir, outputModelName, jobs);
  }
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

async function splitB3dmFile(inputPath, outputPath, maxVertices) {
  const b3dm = await fsp.readFile(inputPath);
  const parsed = parseB3dm(b3dm);
  const glb = splitGlb(parsed.glb, maxVertices);
  const output = Buffer.concat([parsed.prefix, glb.buffer]);

  output.writeUInt32LE(output.length, 8);
  await fsp.writeFile(outputPath, output);

  return {
    files: 1,
    originalBytes: b3dm.length,
    optimizedBytes: output.length,
    originalPrimitives: glb.originalPrimitives,
    optimizedPrimitives: glb.optimizedPrimitives,
    originalTriangles: glb.originalTriangles,
    optimizedTriangles: glb.optimizedTriangles,
    convertedIndexAccessors: glb.convertedIndexAccessors,
  };
}

function parseB3dm(buffer) {
  if (buffer.toString("utf8", 0, 4) !== "b3dm") {
    throw new Error("Invalid b3dm magic.");
  }

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

function splitGlb(sourceGlb, maxVertices) {
  const { gltf, bin } = parseGlb(sourceGlb);
  const out = structuredClone(gltf);
  out.accessors = [];
  out.bufferViews = [];
  out.buffers = [{ byteLength: 0 }];

  const chunks = [];
  const stats = {
    originalPrimitives: 0,
    optimizedPrimitives: 0,
    originalTriangles: 0,
    optimizedTriangles: 0,
    convertedIndexAccessors: 0,
  };

  remapImageBufferViews(gltf, out, bin, chunks);

  out.meshes = (gltf.meshes ?? []).map((mesh) => {
    const nextMesh = { ...mesh, primitives: [] };
    for (const primitive of mesh.primitives ?? []) {
      const split = splitPrimitive(gltf, bin, primitive, out, chunks, maxVertices);
      nextMesh.primitives.push(...split.primitives);
      stats.originalPrimitives += 1;
      stats.optimizedPrimitives += split.primitives.length;
      stats.originalTriangles += split.originalTriangles;
      stats.optimizedTriangles += split.optimizedTriangles;
      stats.convertedIndexAccessors += split.primitives.length;
    }
    return nextMesh;
  });

  const glb = buildGlb(out, chunks);
  return { buffer: glb, ...stats };
}

function remapImageBufferViews(source, target, bin, chunks) {
  const remapped = new Map();
  for (const image of target.images ?? []) {
    if (image.bufferView === undefined) continue;
    if (!remapped.has(image.bufferView)) {
      const view = source.bufferViews[image.bufferView];
      const data = copyBufferView(bin, view);
      const nextViewIndex = addBufferView(target, chunks, data, {
        target: view.target,
        byteStride: view.byteStride,
      });
      remapped.set(image.bufferView, nextViewIndex);
    }
    image.bufferView = remapped.get(image.bufferView);
  }
}

function splitPrimitive(source, bin, primitive, target, chunks, maxVertices) {
  if ((primitive.mode ?? 4) !== 4 || primitive.attributes?.POSITION === undefined) {
    return preservePrimitive(source, bin, primitive, target, chunks);
  }

  const sourceIndices = primitive.indices !== undefined
    ? readIndexArray(source, bin, source.accessors[primitive.indices])
    : makeSequentialIndices(source.accessors[primitive.attributes.POSITION].count);

  const parts = buildPrimitiveParts(sourceIndices, maxVertices);
  const primitives = parts.map((part) => buildSplitPrimitive(source, bin, primitive, target, chunks, part));

  return {
    primitives,
    originalTriangles: Math.floor(sourceIndices.length / 3),
    optimizedTriangles: parts.reduce((sum, part) => sum + Math.floor(part.indices.length / 3), 0),
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
    const indexAccessor = source.accessors[primitive.indices];
    indexCount = indexAccessor.count;
    nextPrimitive.indices = addCopiedAccessor(source, bin, target, chunks, primitive.indices, ELEMENT_ARRAY_BUFFER);
  } else {
    delete nextPrimitive.indices;
  }

  return {
    primitives: [nextPrimitive],
    originalTriangles: Math.floor(indexCount / 3),
    optimizedTriangles: Math.floor(indexCount / 3),
  };
}

function buildPrimitiveParts(sourceIndices, maxVertices) {
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

  for (let i = 0; i + 2 < sourceIndices.length; i += 3) {
    const tri = [sourceIndices[i], sourceIndices[i + 1], sourceIndices[i + 2]];
    let newVertexCount = 0;
    for (const index of tri) {
      if (!vertexMap.has(index)) newVertexCount += 1;
    }

    if (indices.length && vertices.length + newVertexCount > maxVertices) {
      flush();
    }

    for (const index of tri) {
      indices.push(getLocalIndex(index));
    }
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

  const nextPrimitive = { ...primitive, attributes, indices: indexAccessor };
  delete nextPrimitive.extensions;
  if (primitive.extensions) nextPrimitive.extensions = structuredClone(primitive.extensions);
  return nextPrimitive;
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
