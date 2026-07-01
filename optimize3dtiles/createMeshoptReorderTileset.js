#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MeshoptEncoder } from "meshoptimizer";

const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const UNUSED = 0xffffffff;

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

  await MeshoptEncoder.ready;
  if (!MeshoptEncoder.supported) throw new Error("MeshoptEncoder is not supported in this Node runtime.");

  const positional = args.filter((arg) => !arg.startsWith("-"));
  const inputTileset = path.resolve(positional[0] ?? "static/models/横琴示范区_retiled_dedup_tex25_shell.json");
  const outputTileset = path.resolve(positional[1] ?? makeDefaultOutput(inputTileset));
  const options = {
    optSize: args.includes("--opt-size"),
  };

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
    primitives: 0,
    reorderedPrimitives: 0,
    originalVertices: 0,
    outputVertices: 0,
    originalIndices: 0,
    outputIndices: 0,
  };

  for (const [index, job] of jobs.entries()) {
    const result = await reorderB3dm(job.sourcePath, job.outputPath, options);
    for (const key of Object.keys(totals)) totals[key] += result[key] ?? 0;
    console.log(`[${index + 1}/${jobs.length}] ${path.basename(job.sourcePath)} primitives ${result.reorderedPrimitives}/${result.primitives}, vertices ${result.originalVertices} -> ${result.outputVertices}`);
  }

  await fsp.mkdir(path.dirname(outputTileset), { recursive: true });
  await fsp.writeFile(outputTileset, `${JSON.stringify(tileset, null, 2)}\n`);

  console.log(`Mode: ${options.optSize ? "size" : "render"}`);
  console.log(`Processed b3dm files: ${totals.files}`);
  console.log(`Reordered primitives: ${totals.reorderedPrimitives}/${totals.primitives}`);
  console.log(`Indices: ${totals.originalIndices} -> ${totals.outputIndices}`);
  console.log(`Vertices: ${totals.originalVertices} -> ${totals.outputVertices}`);
  console.log(`B3dm size: ${formatBytes(totals.originalBytes)} -> ${formatBytes(totals.outputBytes)}`);
  console.log(`Output tileset: ${outputTileset}`);
}

function printUsage() {
  console.log(`Usage:
  node optimize3dtiles/createMeshoptReorderTileset.js [inputTileset.json] [outputTileset.json] [options]

Options:
  --opt-size  Prefer transmission-size order. Default prefers render locality.

This script is lossless for visible geometry. It rewrites triangle primitive
index order and remaps all vertex attribute streams with meshoptimizer so the
GPU gets better locality. It does not simplify geometry or change materials.`);
}

function makeDefaultOutput(inputTileset) {
  const ext = path.extname(inputTileset);
  const base = path.basename(inputTileset, ext);
  return path.join(path.dirname(inputTileset), `${base}_reordered${ext}`);
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

async function reorderB3dm(inputPath, outputPath, options) {
  const b3dm = await fsp.readFile(inputPath);
  const parsed = parseB3dm(b3dm);
  const reordered = reorderGlb(parsed.glb, options);
  const output = Buffer.concat([parsed.prefix, reordered.buffer]);
  output.writeUInt32LE(output.length, 8);
  await fsp.writeFile(outputPath, output);
  return {
    files: 1,
    originalBytes: b3dm.length,
    outputBytes: output.length,
    ...reordered.stats,
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
    if (chunkType === GLB_JSON) gltf = JSON.parse(buffer.toString("utf8", chunkStart, chunkEnd).trim());
    else if (chunkType === GLB_BIN) bin = buffer.subarray(chunkStart, chunkEnd);
    offset = chunkEnd;
  }

  if (!gltf || !bin) throw new Error("GLB must contain JSON and BIN chunks.");
  return { gltf, bin };
}

function reorderGlb(sourceGlb, options) {
  const { gltf, bin } = parseGlb(sourceGlb);
  const target = structuredClone(gltf);
  target.accessors = [];
  target.bufferViews = [];
  target.buffers = [{ byteLength: 0 }];
  const chunks = [];
  const stats = {
    primitives: 0,
    reorderedPrimitives: 0,
    originalVertices: 0,
    outputVertices: 0,
    originalIndices: 0,
    outputIndices: 0,
  };

  remapNonGeometryBufferViews(gltf, target, bin, chunks);

  target.meshes = (gltf.meshes ?? []).map((mesh) => {
    const nextMesh = { ...mesh, primitives: [] };
    for (const primitive of mesh.primitives ?? []) {
      const result = reorderPrimitive(gltf, bin, primitive, target, chunks, options);
      nextMesh.primitives.push(result.primitive);
      stats.primitives += 1;
      stats.reorderedPrimitives += result.reordered ? 1 : 0;
      stats.originalVertices += result.originalVertices;
      stats.outputVertices += result.outputVertices;
      stats.originalIndices += result.originalIndices;
      stats.outputIndices += result.outputIndices;
    }
    return nextMesh;
  });

  return { buffer: buildGlb(target, chunks), stats };
}

function reorderPrimitive(source, bin, primitive, target, chunks, options) {
  if ((primitive.mode ?? 4) !== 4 || primitive.attributes?.POSITION === undefined) {
    return preservePrimitive(source, bin, primitive, target, chunks);
  }

  const positionAccessor = source.accessors[primitive.attributes.POSITION];
  if (!positionAccessor || positionAccessor.count < 3) {
    return preservePrimitive(source, bin, primitive, target, chunks);
  }

  const sourceIndices = primitive.indices !== undefined
    ? readIndexArray(source, bin, source.accessors[primitive.indices])
    : makeSequentialIndices(positionAccessor.count);
  const originalIndices = sourceIndices.length;
  if (originalIndices < 3 || originalIndices % 3 !== 0) {
    return preservePrimitive(source, bin, primitive, target, chunks);
  }

  const indices = new Uint32Array(sourceIndices);
  const [remap, unique] = MeshoptEncoder.reorderMesh(indices, true, options.optSize);
  if (!unique || remap.length < positionAccessor.count) {
    return preservePrimitive(source, bin, primitive, target, chunks);
  }

  const attributes = {};
  for (const [semantic, accessorIndex] of Object.entries(primitive.attributes ?? {})) {
    attributes[semantic] = addRemappedAccessor(source, bin, target, chunks, accessorIndex, remap, unique, ARRAY_BUFFER);
  }

  const nextPrimitive = { ...primitive, attributes, indices: addIndexAccessor(target, chunks, indices, unique) };
  if (primitive.targets) {
    nextPrimitive.targets = primitive.targets.map((targetAttributes) => {
      const nextTarget = {};
      for (const [semantic, accessorIndex] of Object.entries(targetAttributes)) {
        nextTarget[semantic] = addRemappedAccessor(source, bin, target, chunks, accessorIndex, remap, unique, ARRAY_BUFFER);
      }
      return nextTarget;
    });
  }

  return {
    primitive: nextPrimitive,
    reordered: true,
    originalVertices: positionAccessor.count,
    outputVertices: unique,
    originalIndices,
    outputIndices: indices.length,
  };
}

function preservePrimitive(source, bin, primitive, target, chunks) {
  const attributes = {};
  let vertices = 0;
  for (const [semantic, accessorIndex] of Object.entries(primitive.attributes ?? {})) {
    attributes[semantic] = addCopiedAccessor(source, bin, target, chunks, accessorIndex, ARRAY_BUFFER);
    if (semantic === "POSITION") vertices = source.accessors[accessorIndex].count;
  }

  const nextPrimitive = { ...primitive, attributes };
  if (primitive.indices !== undefined) nextPrimitive.indices = addCopiedAccessor(source, bin, target, chunks, primitive.indices, ELEMENT_ARRAY_BUFFER);
  if (primitive.targets) {
    nextPrimitive.targets = primitive.targets.map((targetAttributes) => {
      const nextTarget = {};
      for (const [semantic, accessorIndex] of Object.entries(targetAttributes)) {
        nextTarget[semantic] = addCopiedAccessor(source, bin, target, chunks, accessorIndex, ARRAY_BUFFER);
      }
      return nextTarget;
    });
  }

  const indices = primitive.indices !== undefined ? source.accessors[primitive.indices].count : vertices;
  return {
    primitive: nextPrimitive,
    reordered: false,
    originalVertices: vertices,
    outputVertices: vertices,
    originalIndices: indices,
    outputIndices: indices,
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

function addIndexAccessor(gltf, chunks, indices, vertexCount) {
  const maxIndex = Math.max(0, vertexCount - 1);
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

function addRemappedAccessor(source, bin, target, chunks, accessorIndex, remap, count, bufferTarget) {
  const accessor = source.accessors[accessorIndex];
  const elementSize = getAccessorElementSize(accessor);
  const data = Buffer.allocUnsafe(count * elementSize);
  let copied = 0;

  for (let sourceIndex = 0; sourceIndex < Math.min(remap.length, accessor.count); sourceIndex += 1) {
    const targetIndex = remap[sourceIndex];
    if (targetIndex !== UNUSED && targetIndex < count) {
      copyAccessorElement(source, bin, accessor, sourceIndex, data, targetIndex * elementSize);
      copied += 1;
    }
  }

  if (copied !== count) throw new Error(`Accessor remap copied ${copied}/${count} vertices.`);

  const viewIndex = addBufferView(target, chunks, data, { target: bufferTarget });
  const nextAccessor = { ...accessor, bufferView: viewIndex, byteOffset: 0, count };
  delete nextAccessor.sparse;
  if (accessor.min || accessor.max) {
    const bounds = computeAccessorBounds(target, data, nextAccessor);
    nextAccessor.min = bounds.min;
    nextAccessor.max = bounds.max;
  }
  return addAccessor(target, nextAccessor);
}

function addCopiedAccessor(source, bin, target, chunks, accessorIndex, bufferTarget) {
  const accessor = source.accessors[accessorIndex];
  const elementSize = getAccessorElementSize(accessor);
  const data = Buffer.allocUnsafe(accessor.count * elementSize);
  for (let i = 0; i < accessor.count; i += 1) copyAccessorElement(source, bin, accessor, i, data, i * elementSize);
  const viewIndex = addBufferView(target, chunks, data, { target: bufferTarget });
  const nextAccessor = { ...accessor, bufferView: viewIndex, byteOffset: 0 };
  delete nextAccessor.sparse;
  return addAccessor(target, nextAccessor);
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

function readIndexArray(source, bin, accessor) {
  const view = source.bufferViews[accessor.bufferView];
  const stride = view.byteStride ?? COMPONENT_BYTES.get(accessor.componentType);
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const result = new Uint32Array(accessor.count);
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
  const result = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) result[i] = i;
  return result;
}

function readAccessorComponentFromBuffer(buffer, accessor, index, component) {
  const componentSize = COMPONENT_BYTES.get(accessor.componentType);
  const offset = index * getAccessorElementSize(accessor) + component * componentSize;
  switch (accessor.componentType) {
    case 5120: return buffer.readInt8(offset);
    case 5121: return buffer.readUInt8(offset);
    case 5122: return buffer.readInt16LE(offset);
    case 5123: return buffer.readUInt16LE(offset);
    case 5125: return buffer.readUInt32LE(offset);
    case 5126: return buffer.readFloatLE(offset);
    default: throw new Error(`Unsupported component type: ${accessor.componentType}`);
  }
}

function computeAccessorBounds(gltf, buffer, accessor) {
  const components = TYPE_COMPONENTS.get(accessor.type);
  const min = new Array(components).fill(Number.POSITIVE_INFINITY);
  const max = new Array(components).fill(Number.NEGATIVE_INFINITY);
  for (let index = 0; index < accessor.count; index += 1) {
    for (let component = 0; component < components; component += 1) {
      const value = readAccessorComponentFromBuffer(buffer, accessor, index, component);
      if (value < min[component]) min[component] = value;
      if (value > max[component]) max[component] = value;
    }
  }
  return { min, max };
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
  if (!componentBytes || !components) throw new Error(`Unsupported accessor layout: ${accessor.componentType} ${accessor.type}`);
  return componentBytes * components;
}

function copyBufferView(bin, view) {
  return Buffer.from(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
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
