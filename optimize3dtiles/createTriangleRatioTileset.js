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
  const inputTileset = path.resolve(positional[0] ?? "static/models/横琴示范区_retiled_dedup_tex25.json");
  const ratio = readNumberOption(args, "--ratio", 0.5);
  const outputTileset = path.resolve(positional[1] ?? makeDefaultOutput(inputTileset, ratio));

  if (ratio <= 0 || ratio > 1) throw new Error("--ratio must be greater than 0 and less than or equal to 1.");

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
    originalVertices: 0,
    outputVertices: 0,
  };

  for (const job of jobs) {
    const result = await reduceB3dmTriangles(job.sourcePath, job.outputPath, ratio);
    for (const key of Object.keys(totals)) totals[key] += result[key] ?? 0;
  }

  await fsp.mkdir(path.dirname(outputTileset), { recursive: true });
  await fsp.writeFile(outputTileset, `${JSON.stringify(tileset, null, 2)}\n`);

  console.log(`Ratio: ${ratio}`);
  console.log(`Processed b3dm files: ${totals.files}`);
  console.log(`Triangles: ${totals.originalTriangles} -> ${totals.outputTriangles}`);
  console.log(`Vertices: ${totals.originalVertices} -> ${totals.outputVertices}`);
  console.log(`B3dm size: ${formatBytes(totals.originalBytes)} -> ${formatBytes(totals.outputBytes)}`);
  console.log(`Output tileset: ${outputTileset}`);
}

function printUsage() {
  console.log(`Usage:
  node optimize3dtiles/createTriangleRatioTileset.js [inputTileset.json] [outputTileset.json] [options]

Options:
  --ratio <n>  Triangle keep ratio. Default: 0.5

Diagnostic only: this deletes triangles and changes geometry. Do not use for
precision clipping analysis unless the approximation is acceptable.`);
}

function makeDefaultOutput(inputTileset, ratio) {
  const ext = path.extname(inputTileset);
  const base = path.basename(inputTileset, ext);
  return path.join(path.dirname(inputTileset), `${base}_tri${Math.round(ratio * 100)}${ext}`);
}

function readNumberOption(args, name, fallback) {
  const value = readStringOption(args, name);
  return value === undefined ? fallback : Number(value);
}

function readStringOption(args, name, fallback = undefined) {
  const equal = args.find((arg) => arg.startsWith(`${name}=`));
  if (equal) return equal.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return fallback;
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

async function reduceB3dmTriangles(inputPath, outputPath, ratio) {
  const b3dm = await fsp.readFile(inputPath);
  const parsed = parseB3dm(b3dm);
  const reduced = reduceGlbTriangles(parsed.glb, ratio);
  const output = Buffer.concat([parsed.prefix, reduced.buffer]);
  output.writeUInt32LE(output.length, 8);
  await fsp.writeFile(outputPath, output);
  return {
    files: 1,
    originalBytes: b3dm.length,
    outputBytes: output.length,
    originalTriangles: reduced.originalTriangles,
    outputTriangles: reduced.outputTriangles,
    originalVertices: reduced.originalVertices,
    outputVertices: reduced.outputVertices,
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

function reduceGlbTriangles(sourceGlb, ratio) {
  const { gltf, bin } = parseGlb(sourceGlb);
  const target = structuredClone(gltf);
  target.accessors = [];
  target.bufferViews = [];
  target.buffers = [{ byteLength: 0 }];
  const chunks = [];
  const stats = {
    originalTriangles: 0,
    outputTriangles: 0,
    originalVertices: 0,
    outputVertices: 0,
  };

  remapNonGeometryBufferViews(gltf, target, bin, chunks);

  target.meshes = (gltf.meshes ?? []).map((mesh) => {
    const nextMesh = { ...mesh, primitives: [] };
    for (const primitive of mesh.primitives ?? []) {
      const reduced = reducePrimitive(gltf, bin, primitive, target, chunks, ratio);
      nextMesh.primitives.push(reduced.primitive);
      stats.originalTriangles += reduced.originalTriangles;
      stats.outputTriangles += reduced.outputTriangles;
      stats.originalVertices += reduced.originalVertices;
      stats.outputVertices += reduced.outputVertices;
    }
    return nextMesh;
  });

  return {
    buffer: buildGlb(target, chunks),
    ...stats,
  };
}

function reducePrimitive(source, bin, primitive, target, chunks, ratio) {
  if ((primitive.mode ?? 4) !== 4 || primitive.attributes?.POSITION === undefined) {
    return preservePrimitive(source, bin, primitive, target, chunks);
  }

  const sourceIndices = primitive.indices !== undefined
    ? readIndexArray(source, bin, source.accessors[primitive.indices])
    : makeSequentialIndices(source.accessors[primitive.attributes.POSITION].count);
  const totalTriangles = Math.floor(sourceIndices.length / 3);
  const targetTriangles = Math.max(1, Math.floor(totalTriangles * ratio));
  const selected = selectTriangles(sourceIndices, targetTriangles);
  const remapped = remapTrianglesToVertices(selected);
  const attributes = {};

  for (const [semantic, accessorIndex] of Object.entries(primitive.attributes ?? {})) {
    attributes[semantic] = addRemappedAttributeAccessor(source, bin, target, chunks, accessorIndex, remapped.vertices);
  }

  const indexComponentType = remapped.vertices.length <= 65535 ? 5123 : 5125;
  const indexBuffer = Buffer.allocUnsafe(remapped.indices.length * (indexComponentType === 5123 ? 2 : 4));
  let maxIndex = 0;
  for (let i = 0; i < remapped.indices.length; i += 1) {
    const value = remapped.indices[i];
    maxIndex = Math.max(maxIndex, value);
    if (indexComponentType === 5123) indexBuffer.writeUInt16LE(value, i * 2);
    else indexBuffer.writeUInt32LE(value, i * 4);
  }
  const indexView = addBufferView(target, chunks, indexBuffer, { target: ELEMENT_ARRAY_BUFFER });
  const indexAccessor = addAccessor(target, {
    bufferView: indexView,
    componentType: indexComponentType,
    count: remapped.indices.length,
    type: "SCALAR",
    min: [0],
    max: [maxIndex],
  });

  return {
    primitive: { ...primitive, attributes, indices: indexAccessor },
    originalTriangles: totalTriangles,
    outputTriangles: selected.length,
    originalVertices: source.accessors[primitive.attributes.POSITION].count,
    outputVertices: remapped.vertices.length,
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
  for (let i = 0; i < targetTriangles; i += 1) {
    const triangle = Math.floor((i * totalTriangles) / targetTriangles);
    result.push([
      sourceIndices[triangle * 3],
      sourceIndices[triangle * 3 + 1],
      sourceIndices[triangle * 3 + 2],
    ]);
  }
  return result;
}

function remapTrianglesToVertices(triangles) {
  const vertexMap = new Map();
  const vertices = [];
  const indices = [];
  function getLocalIndex(sourceIndex) {
    let local = vertexMap.get(sourceIndex);
    if (local !== undefined) return local;
    local = vertices.length;
    vertexMap.set(sourceIndex, local);
    vertices.push(sourceIndex);
    return local;
  }
  for (const triangle of triangles) {
    for (const sourceIndex of triangle) indices.push(getLocalIndex(sourceIndex));
  }
  return { vertices, indices };
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
  }
  return {
    primitive: nextPrimitive,
    originalTriangles: triangles,
    outputTriangles: triangles,
    originalVertices: vertices,
    outputVertices: vertices,
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

function addRemappedAttributeAccessor(source, bin, target, chunks, accessorIndex, vertices) {
  const accessor = source.accessors[accessorIndex];
  const elementSize = getAccessorElementSize(accessor);
  const data = Buffer.allocUnsafe(vertices.length * elementSize);
  for (let i = 0; i < vertices.length; i += 1) copyAccessorElement(source, bin, accessor, vertices[i], data, i * elementSize);
  const viewIndex = addBufferView(target, chunks, data, { target: ARRAY_BUFFER });
  const nextAccessor = cloneAccessorForSubset(source, bin, accessor, viewIndex, vertices);
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
  if (accessor.componentType === 5126) return bin.readFloatLE(offset);
  if (accessor.componentType === 5125) return bin.readUInt32LE(offset);
  if (accessor.componentType === 5123) return bin.readUInt16LE(offset);
  if (accessor.componentType === 5121) return bin.readUInt8(offset);
  if (accessor.componentType === 5122) return bin.readInt16LE(offset);
  if (accessor.componentType === 5120) return bin.readInt8(offset);
  throw new Error(`Unsupported component type: ${accessor.componentType}`);
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
