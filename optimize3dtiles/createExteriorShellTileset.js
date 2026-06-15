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

const IDENTITY = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const positional = args.filter((arg) => !arg.startsWith("-"));
  const inputTileset = path.resolve(positional[0] ?? "static/models/全市地质体模型.json");
  const outputTileset = path.resolve(positional[1] ?? makeDefaultOutput(inputTileset));
  const epsilon = readNumberOption(args, "--epsilon", 0.001);
  if (!Number.isFinite(epsilon) || epsilon <= 0) throw new Error("--epsilon must be a positive number.");

  const inputDir = path.dirname(inputTileset);
  const outputDir = path.dirname(outputTileset);
  const outputModelName = path.basename(outputTileset, path.extname(outputTileset));
  const outputContentDir = path.join(outputDir, outputModelName);
  const tileset = JSON.parse(await fsp.readFile(inputTileset, "utf8"));
  const fileIndex = await buildFileIndex(inputDir);
  const jobs = [];

  collectContentJobs(tileset.root, inputDir, fileIndex, outputContentDir, outputModelName, IDENTITY, jobs);
  if (!jobs.length) throw new Error(`No b3dm content found in ${inputTileset}`);

  await fsp.rm(outputContentDir, { recursive: true, force: true });
  await fsp.mkdir(outputContentDir, { recursive: true });

  console.log(`Counting triangle faces from ${jobs.length} b3dm files...`);
  const faceCounts = await countFaces(jobs, epsilon);
  console.log(`Unique face keys: ${faceCounts.size}`);

  const totals = {
    files: 0,
    originalBytes: 0,
    outputBytes: 0,
    originalTriangles: 0,
    outputTriangles: 0,
    removedTriangles: 0,
    originalVertices: 0,
    outputVertices: 0,
  };

  for (const [index, job] of jobs.entries()) {
    const result = await writeShellB3dm(job, faceCounts, epsilon);
    for (const key of Object.keys(totals)) totals[key] += result[key] ?? 0;
    console.log(`[${index + 1}/${jobs.length}] ${path.basename(job.sourcePath)} triangles ${result.originalTriangles} -> ${result.outputTriangles}`);
  }

  pruneEmptyLeafTiles(tileset.root);
  await fsp.mkdir(path.dirname(outputTileset), { recursive: true });
  await fsp.writeFile(outputTileset, `${JSON.stringify(tileset, null, 2)}\n`);

  console.log(`Epsilon: ${epsilon}`);
  console.log(`Processed b3dm files: ${totals.files}`);
  console.log(`Triangles: ${totals.originalTriangles} -> ${totals.outputTriangles} (-${totals.removedTriangles})`);
  console.log(`Vertices: ${totals.originalVertices} -> ${totals.outputVertices}`);
  console.log(`B3dm size: ${formatBytes(totals.originalBytes)} -> ${formatBytes(totals.outputBytes)}`);
  console.log(`Output tileset: ${outputTileset}`);
}

function printUsage() {
  console.log(`Usage:
  node optimize3dtiles/createExteriorShellTileset.js [inputTileset.json] [outputTileset.json] [options]

Options:
  --epsilon <n>  Position matching tolerance in model coordinates. Default: 0.001

This script builds a display-only shell by deleting duplicate coincident faces
that appear in more than one place. Keep the original tileset for clipping or
analysis, and use the shell tileset only for rendering.`);
}

function makeDefaultOutput(inputTileset) {
  const ext = path.extname(inputTileset);
  const base = path.basename(inputTileset, ext);
  return path.join(path.dirname(inputTileset), `${base}_shell${ext}`);
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

function collectContentJobs(tile, baseDir, fileIndex, outputContentDir, outputModelName, parentTransform, jobs) {
  if (!tile) return;
  const transform = tile.transform ? multiplyMatrix4(parentTransform, tile.transform) : parentTransform;
  const content = tile.content;
  const uri = content?.uri ?? content?.url;
  if (uri && stripUriQuery(uri).toLowerCase().endsWith(".b3dm")) {
    const sourcePath = resolveContentPath(uri, baseDir, fileIndex);
    const outputName = path.basename(sourcePath);
    const outputPath = path.join(outputContentDir, outputName);
    const outputUri = `./${outputModelName}/${encodeURIComponent(outputName).replaceAll("%2E", ".")}`;
    if (content.uri !== undefined) content.uri = outputUri;
    else content.url = outputUri;
    jobs.push({ sourcePath, outputPath, transform, tile });
  }
  for (const child of tile.children ?? []) collectContentJobs(child, baseDir, fileIndex, outputContentDir, outputModelName, transform, jobs);
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

async function countFaces(jobs, epsilon) {
  const counts = new Map();
  for (const [index, job] of jobs.entries()) {
    const b3dm = await fsp.readFile(job.sourcePath);
    const { gltf, bin } = parseGlb(parseB3dm(b3dm).glb);
    forEachTriangle(gltf, bin, job.transform, epsilon, (hash) => {
      const previous = counts.get(hash) ?? 0;
      if (previous < 2) counts.set(hash, previous + 1);
    });
    console.log(`[count ${index + 1}/${jobs.length}] ${path.basename(job.sourcePath)}`);
  }
  return counts;
}

async function writeShellB3dm(job, faceCounts, epsilon) {
  const b3dm = await fsp.readFile(job.sourcePath);
  const parsed = parseB3dm(b3dm);
  const shell = createShellGlb(parsed.glb, job.transform, faceCounts, epsilon);
  const output = Buffer.concat([parsed.prefix, shell.buffer]);
  output.writeUInt32LE(output.length, 8);
  await fsp.writeFile(job.outputPath, output);
  if (shell.outputTriangles <= 0) delete job.tile.content;
  return {
    files: 1,
    originalBytes: b3dm.length,
    outputBytes: output.length,
    originalTriangles: shell.originalTriangles,
    outputTriangles: shell.outputTriangles,
    removedTriangles: shell.originalTriangles - shell.outputTriangles,
    originalVertices: shell.originalVertices,
    outputVertices: shell.outputVertices,
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

function forEachTriangle(gltf, bin, transform, epsilon, callback) {
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4 || primitive.attributes?.POSITION === undefined) continue;
      const positionAccessor = gltf.accessors[primitive.attributes.POSITION];
      const indices = primitive.indices !== undefined
        ? readIndexArray(gltf, bin, gltf.accessors[primitive.indices])
        : makeSequentialIndices(positionAccessor.count);
      for (let i = 0; i + 2 < indices.length; i += 3) {
        callback(faceHash(gltf, bin, positionAccessor, transform, epsilon, indices[i], indices[i + 1], indices[i + 2]));
      }
    }
  }
}

function createShellGlb(sourceGlb, transform, faceCounts, epsilon) {
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
  target.meshes = [];

  for (const mesh of gltf.meshes ?? []) {
    const nextMesh = { ...mesh, primitives: [] };
    for (const primitive of mesh.primitives ?? []) {
      const result = shellPrimitive(gltf, bin, primitive, target, chunks, transform, faceCounts, epsilon);
      stats.originalTriangles += result.originalTriangles;
      stats.outputTriangles += result.outputTriangles;
      stats.originalVertices += result.originalVertices;
      stats.outputVertices += result.outputVertices;
      if (result.primitive) nextMesh.primitives.push(result.primitive);
    }
    if (nextMesh.primitives.length > 0) target.meshes.push(nextMesh);
  }

  if (!target.meshes.length) target.meshes = [];
  return { buffer: buildGlb(target, chunks), ...stats };
}

function shellPrimitive(source, bin, primitive, target, chunks, transform, faceCounts, epsilon) {
  if ((primitive.mode ?? 4) !== 4 || primitive.attributes?.POSITION === undefined) {
    return preservePrimitive(source, bin, primitive, target, chunks);
  }

  const positionAccessor = source.accessors[primitive.attributes.POSITION];
  const sourceIndices = primitive.indices !== undefined
    ? readIndexArray(source, bin, source.accessors[primitive.indices])
    : makeSequentialIndices(positionAccessor.count);
  const keptTriangles = [];

  for (let i = 0; i + 2 < sourceIndices.length; i += 3) {
    const a = sourceIndices[i];
    const b = sourceIndices[i + 1];
    const c = sourceIndices[i + 2];
    const hash = faceHash(source, bin, positionAccessor, transform, epsilon, a, b, c);
    if ((faceCounts.get(hash) ?? 0) === 1) keptTriangles.push([a, b, c]);
  }

  if (!keptTriangles.length) {
    return {
      primitive: null,
      originalTriangles: Math.floor(sourceIndices.length / 3),
      outputTriangles: 0,
      originalVertices: positionAccessor.count,
      outputVertices: 0,
    };
  }

  const remapped = remapTrianglesToVertices(keptTriangles);
  const attributes = {};
  for (const [semantic, accessorIndex] of Object.entries(primitive.attributes ?? {})) {
    attributes[semantic] = addRemappedAttributeAccessor(source, bin, target, chunks, accessorIndex, remapped.vertices);
  }
  const indexAccessor = addIndexAccessor(target, chunks, remapped.indices);
  return {
    primitive: { ...primitive, attributes, indices: indexAccessor },
    originalTriangles: Math.floor(sourceIndices.length / 3),
    outputTriangles: keptTriangles.length,
    originalVertices: positionAccessor.count,
    outputVertices: remapped.vertices.length,
  };
}

function faceHash(gltf, bin, positionAccessor, transform, epsilon, a, b, c) {
  const keys = [
    quantizedPositionKey(readPosition(gltf, bin, positionAccessor, a), transform, epsilon),
    quantizedPositionKey(readPosition(gltf, bin, positionAccessor, b), transform, epsilon),
    quantizedPositionKey(readPosition(gltf, bin, positionAccessor, c), transform, epsilon),
  ].sort();
  let h1 = 2166136261;
  let h2 = 2166136261 ^ 0x9e3779b9;
  for (const key of keys) {
    for (let i = 0; i < key.length; i += 1) {
      const code = key.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ code, 2246822519) >>> 0;
    }
  }
  return `${h1.toString(36)}:${h2.toString(36)}`;
}

function quantizedPositionKey(position, transform, epsilon) {
  const p = transformPoint(transform, position);
  return `${Math.round(p[0] / epsilon)},${Math.round(p[1] / epsilon)},${Math.round(p[2] / epsilon)}`;
}

function remapTrianglesToVertices(triangles) {
  const vertexMap = new Map();
  const vertices = [];
  const indices = [];
  function local(sourceIndex) {
    let value = vertexMap.get(sourceIndex);
    if (value !== undefined) return value;
    value = vertices.length;
    vertexMap.set(sourceIndex, value);
    vertices.push(sourceIndex);
    return value;
  }
  for (const triangle of triangles) {
    indices.push(local(triangle[0]), local(triangle[1]), local(triangle[2]));
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
  return { primitive: nextPrimitive, originalTriangles: triangles, outputTriangles: triangles, originalVertices: vertices, outputVertices: vertices };
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

function pruneEmptyLeafTiles(tile) {
  if (!tile?.children?.length) return;
  tile.children = tile.children.filter((child) => {
    pruneEmptyLeafTiles(child);
    return child.content || child.children?.length;
  });
}

function multiplyMatrix4(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function transformPoint(m, p) {
  const x = p[0];
  const y = p[1];
  const z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
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
