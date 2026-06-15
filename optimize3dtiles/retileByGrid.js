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
    maxTriangles: readNumberOption(args, "--max-triangles", 12000),
    maxVertices: readNumberOption(args, "--max-vertices", 60000),
    minBytes: readSizeOption(args, "--min-bytes", 1024 * 1024),
    maxParts: readNumberOption(args, "--max-parts", 16),
  };

  if (options.maxTriangles < 1) throw new Error("--max-triangles must be greater than 0.");
  if (options.maxVertices < 3 || options.maxVertices > 65535) {
    throw new Error("--max-vertices must be between 3 and 65535.");
  }
  if (options.maxParts < 2) throw new Error("--max-parts must be greater than 1.");

  const inputDir = path.dirname(inputTileset);
  const outputDir = path.dirname(outputTileset);
  const outputModelName = path.basename(outputTileset, path.extname(outputTileset));
  const outputContentDir = path.join(outputDir, outputModelName);

  const tileset = JSON.parse(await fsp.readFile(inputTileset, "utf8"));
  const fileIndex = await buildFileIndex(inputDir);
  await fsp.mkdir(outputContentDir, { recursive: true });

  const totals = {
    originalTiles: 0,
    copiedTiles: 0,
    splitTiles: 0,
    outputTiles: 0,
    originalBytes: 0,
    outputBytes: 0,
    originalTriangles: 0,
    outputTriangles: 0,
  };

  await retileNode(tileset.root, {
    baseDir: inputDir,
    fileIndex,
    outputContentDir,
    outputModelName,
    options,
    totals,
  });
  updateInternalBoundingVolumes(tileset.root);

  await fsp.mkdir(path.dirname(outputTileset), { recursive: true });
  await fsp.writeFile(outputTileset, `${JSON.stringify(tileset, null, 2)}\n`);

  console.log(`Content tiles: ${totals.originalTiles}`);
  console.log(`Copied tiles: ${totals.copiedTiles}`);
  console.log(`Split tiles: ${totals.splitTiles}`);
  console.log(`Output b3dm tiles: ${totals.outputTiles}`);
  console.log(`Triangles: ${totals.originalTriangles} -> ${totals.outputTriangles}`);
  console.log(`Original b3dm size: ${formatBytes(totals.originalBytes)}`);
  console.log(`Output b3dm size: ${formatBytes(totals.outputBytes)}`);
  console.log(`Delta: ${formatBytes(totals.outputBytes - totals.originalBytes)}`);
  console.log(`Output tileset: ${outputTileset}`);
}

function printUsage() {
  console.log(`Usage:
  node optimize3dtiles/retileByGrid.js [inputTileset.json] [outputTileset.json] [options]

Options:
  --max-triangles <n>  Target maximum triangles per generated child b3dm.
                       Default: 12000
  --max-vertices <n>   Maximum unique vertices per generated primitive.
                       Must be <= 65535. Default: 60000
  --min-bytes <size>   Only split source b3dm files at least this large.
                       Supports raw bytes, kb, mb. Default: 1mb
  --max-parts <n>      Maximum child b3dm files generated from one source b3dm.
                       Default: 16

This is intended for mobile loading granularity. It keeps original attributes,
materials, textures and b3dm metadata. Oversized b3dm contents are replaced by
empty parent tiles with spatial child tiles.`);
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
  return path.join(path.dirname(inputTileset), `${base}_retiled${ext}`);
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

async function retileNode(tile, context) {
  if (!tile) return;

  const children = tile.children ?? [];
  for (const child of children) {
    await retileNode(child, context);
  }

  const content = tile.content;
  const uri = content?.uri ?? content?.url;
  if (!uri || !stripUriQuery(uri).toLowerCase().endsWith(".b3dm")) return;

  const sourcePath = resolveContentPath(uri, context.baseDir, context.fileIndex);
  const sourceName = path.basename(sourcePath, path.extname(sourcePath));
  const sourceBytes = (await fsp.stat(sourcePath)).size;
  const relativePrefix = sanitizeFileName(sourceName);

  context.totals.originalTiles += 1;
  context.totals.originalBytes += sourceBytes;

  if (sourceBytes < context.options.minBytes) {
    const sourceTriangleCount = await countB3dmTriangles(sourcePath);
    const outputName = `${relativePrefix}.b3dm`;
    const outputPath = path.join(context.outputContentDir, outputName);
    await fsp.copyFile(sourcePath, outputPath);
    setContentUri(content, `./${context.outputModelName}/${outputName}`);
    context.totals.copiedTiles += 1;
    context.totals.outputTiles += 1;
    context.totals.outputBytes += sourceBytes;
    context.totals.originalTriangles += sourceTriangleCount;
    context.totals.outputTriangles += sourceTriangleCount;
    return;
  }

  const split = await splitB3dmByGrid(sourcePath, {
    ...context.options,
    sourceName: relativePrefix,
  });

  context.totals.originalTriangles += split.originalTriangles;
  context.totals.outputTriangles += split.outputTriangles;

  if (split.parts.length <= 1) {
    const outputName = `${relativePrefix}.b3dm`;
    const outputPath = path.join(context.outputContentDir, outputName);
    await fsp.writeFile(outputPath, split.parts[0]?.buffer ?? await fsp.readFile(sourcePath));
    setContentUri(content, `./${context.outputModelName}/${outputName}`);
    context.totals.copiedTiles += 1;
    context.totals.outputTiles += 1;
    context.totals.outputBytes += split.parts[0]?.buffer.length ?? sourceBytes;
    if (split.originalTriangles === 0) {
      const sourceTriangleCount = await countB3dmTriangles(sourcePath);
      context.totals.originalTriangles += sourceTriangleCount;
      context.totals.outputTriangles += sourceTriangleCount;
    }
    return;
  }

  delete tile.content;
  tile.boundingVolume = {
    box: unionBoxes(split.parts.map((part) => part.box)),
  };
  tile.children = [
    ...split.parts.map((part, index) => {
      const outputName = `${relativePrefix}_part_${String(index).padStart(3, "0")}.b3dm`;
      part.outputName = outputName;
      return {
        boundingVolume: { box: part.box },
        content: { uri: `./${context.outputModelName}/${outputName}` },
        geometricError: 0,
        refine: "REPLACE",
      };
    }),
    ...children,
  ];

  for (const part of split.parts) {
    const outputPath = path.join(context.outputContentDir, part.outputName);
    await fsp.writeFile(outputPath, part.buffer);
    context.totals.outputBytes += part.buffer.length;
  }

  context.totals.splitTiles += 1;
  context.totals.outputTiles += split.parts.length;
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

async function splitB3dmByGrid(inputPath, options) {
  const b3dm = await fsp.readFile(inputPath);
  const parsed = parseB3dm(b3dm);
  const split = splitGlbByGrid(parsed.glb, options);

  return {
    originalTriangles: split.originalTriangles,
    outputTriangles: split.outputTriangles,
    parts: split.parts.map((part) => {
      const output = Buffer.concat([parsed.prefix, part.glb]);
      output.writeUInt32LE(output.length, 8);
      return {
        buffer: output,
        box: part.box,
      };
    }),
  };
}

async function countB3dmTriangles(inputPath) {
  const b3dm = await fsp.readFile(inputPath);
  const parsed = parseB3dm(b3dm);
  const { gltf } = parseGlb(parsed.glb);
  return countTriangles(gltf);
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

function splitGlbByGrid(sourceGlb, options) {
  const { gltf, bin } = parseGlb(sourceGlb);
  const sourceParts = collectSpatialParts(gltf, bin, options);
  if (sourceParts.length <= 1) {
    const box = computeWholePositionBox(gltf, bin);
    return {
      originalTriangles: sourceParts[0]?.triangles ?? countTriangles(gltf),
      outputTriangles: sourceParts[0]?.triangles ?? countTriangles(gltf),
      parts: [{ glb: Buffer.from(sourceGlb), box }],
    };
  }

  let originalTriangles = 0;
  let outputTriangles = 0;
  const parts = sourceParts.map((sourcePart) => {
    originalTriangles += sourcePart.triangles;
    outputTriangles += sourcePart.triangles;
    return buildPartGlb(gltf, bin, sourcePart, options);
  });

  return { originalTriangles, outputTriangles, parts };
}

function collectSpatialParts(gltf, bin, options) {
  const primitiveInfos = [];
  let totalTriangles = 0;
  const wholeBounds = createBounds();

  for (let meshIndex = 0; meshIndex < (gltf.meshes?.length ?? 0); meshIndex += 1) {
    const mesh = gltf.meshes[meshIndex];
    for (let primitiveIndex = 0; primitiveIndex < (mesh.primitives?.length ?? 0); primitiveIndex += 1) {
      const primitive = mesh.primitives[primitiveIndex];
      if ((primitive.mode ?? 4) !== 4 || primitive.attributes?.POSITION === undefined) {
        return [{ all: true, triangles: countTriangles(gltf) }];
      }

      const positionAccessor = gltf.accessors[primitive.attributes.POSITION];
      const indices = primitive.indices !== undefined
        ? readIndexArray(gltf, bin, gltf.accessors[primitive.indices])
        : makeSequentialIndices(positionAccessor.count);
      const triangles = [];

      for (let i = 0; i + 2 < indices.length; i += 3) {
        const tri = [indices[i], indices[i + 1], indices[i + 2]];
        const center = [0, 0, 0];
        for (const vertexIndex of tri) {
          const position = readPosition(gltf, bin, positionAccessor, vertexIndex);
          expandBounds(wholeBounds, position);
          center[0] += position[0] / 3;
          center[1] += position[1] / 3;
          center[2] += position[2] / 3;
        }
        triangles.push({ indices: tri, center });
      }

      totalTriangles += triangles.length;
      primitiveInfos.push({ meshIndex, primitiveIndex, primitive, triangles });
    }
  }

  if (totalTriangles <= options.maxTriangles) {
    return [{ all: true, triangles: totalTriangles }];
  }

  const targetParts = clamp(
    Math.ceil(totalTriangles / options.maxTriangles),
    2,
    options.maxParts,
  );
  const grid = chooseGrid(wholeBounds, targetParts);
  const buckets = Array.from({ length: grid.x * grid.y }, () => ({
    primitiveBuckets: new Map(),
    bounds: createBounds(),
    triangles: 0,
  }));

  for (const info of primitiveInfos) {
    for (const triangle of info.triangles) {
      const bucketIndex = getBucketIndex(triangle.center, wholeBounds, grid);
      const bucket = buckets[bucketIndex];
      const key = `${info.meshIndex}:${info.primitiveIndex}`;
      let primitiveBucket = bucket.primitiveBuckets.get(key);
      if (!primitiveBucket) {
        primitiveBucket = {
          meshIndex: info.meshIndex,
          primitiveIndex: info.primitiveIndex,
          triangles: [],
        };
        bucket.primitiveBuckets.set(key, primitiveBucket);
      }
      primitiveBucket.triangles.push(triangle.indices);
      bucket.triangles += 1;

      for (const vertexIndex of triangle.indices) {
        const position = readPosition(gltf, bin, gltf.accessors[info.primitive.attributes.POSITION], vertexIndex);
        expandBounds(bucket.bounds, position);
      }
    }
  }

  const parts = buckets
    .filter((bucket) => bucket.triangles > 0)
    .map((bucket) => ({
      primitiveBuckets: [...bucket.primitiveBuckets.values()],
      bounds: bucket.bounds,
      triangles: bucket.triangles,
    }));

  return parts.length > 1 ? parts : [{ all: true, triangles: totalTriangles }];
}

function buildPartGlb(source, bin, sourcePart, options) {
  if (sourcePart.all) {
    return {
      glb: buildCopiedGlb(source, bin),
      box: computeWholePositionBox(source, bin),
    };
  }

  const target = structuredClone(source);
  target.accessors = [];
  target.bufferViews = [];
  target.buffers = [{ byteLength: 0 }];
  const chunks = [];

  remapNonGeometryBufferViews(source, target, bin, chunks);

  const primitiveLookup = new Map();
  for (const primitivePart of sourcePart.primitiveBuckets) {
    primitiveLookup.set(`${primitivePart.meshIndex}:${primitivePart.primitiveIndex}`, primitivePart);
  }

  const meshIndexMap = new Map();
  const meshes = [];

  (source.meshes ?? []).forEach((mesh, meshIndex) => {
    const nextMesh = { ...mesh, primitives: [] };
    for (let primitiveIndex = 0; primitiveIndex < (mesh.primitives?.length ?? 0); primitiveIndex += 1) {
      const primitivePart = primitiveLookup.get(`${meshIndex}:${primitiveIndex}`);
      if (!primitivePart) continue;
      const primitive = mesh.primitives[primitiveIndex];
      const splitPrimitives = buildPrimitiveChunks(
        source,
        bin,
        primitive,
        target,
        chunks,
        primitivePart.triangles,
        options.maxVertices,
      );
      nextMesh.primitives.push(...splitPrimitives);
    }
    if (nextMesh.primitives.length > 0) {
      meshIndexMap.set(meshIndex, meshes.length);
      meshes.push(nextMesh);
    }
  });

  target.meshes = meshes;
  remapNodeMeshIndices(target, meshIndexMap);

  return {
    glb: buildGlb(target, chunks),
    box: boundsToBox(sourcePart.bounds),
  };
}

function buildPrimitiveChunks(source, bin, primitive, target, chunks, triangles, maxVertices) {
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

  return parts.map((part) => buildSplitPrimitive(source, bin, primitive, target, chunks, part));
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

function remapNonGeometryBufferViews(source, target, bin, chunks) {
  const remapped = new Map();

  function remapBufferView(bufferViewIndex) {
    if (bufferViewIndex === undefined) return undefined;
    if (!remapped.has(bufferViewIndex)) {
      const view = source.bufferViews[bufferViewIndex];
      const data = copyBufferView(bin, view);
      remapped.set(bufferViewIndex, addBufferView(target, chunks, data, {
        target: view.target,
        byteStride: view.byteStride,
      }));
    }
    return remapped.get(bufferViewIndex);
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

function remapNodeMeshIndices(gltf, meshIndexMap) {
  for (const node of gltf.nodes ?? []) {
    if (node.mesh === undefined) continue;
    if (meshIndexMap.has(node.mesh)) node.mesh = meshIndexMap.get(node.mesh);
    else delete node.mesh;
  }
}

function buildCopiedGlb(source, bin) {
  const target = structuredClone(source);
  const chunks = [];
  for (let viewIndex = 0; viewIndex < (target.bufferViews?.length ?? 0); viewIndex += 1) {
    const view = target.bufferViews[viewIndex];
    chunks.push({
      viewIndex,
      buffer: copyBufferView(bin, source.bufferViews[viewIndex]),
    });
    view.byteOffset = 0;
  }
  target.buffers ??= [{}];
  target.buffers[0].byteLength = 0;
  return buildGlb(target, chunks);
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

function computeWholePositionBox(gltf, bin) {
  const bounds = createBounds();
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.attributes?.POSITION === undefined) continue;
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      for (let index = 0; index < accessor.count; index += 1) {
        expandBounds(bounds, readPosition(gltf, bin, accessor, index));
      }
    }
  }
  return boundsToBox(bounds);
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

function boundsToBox(bounds) {
  const min = bounds.min;
  const max = bounds.max;
  const center = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const half = [
    Math.max((max[0] - min[0]) / 2, 0.001),
    Math.max((max[1] - min[1]) / 2, 0.001),
    Math.max((max[2] - min[2]) / 2, 0.001),
  ];
  return [
    center[0], center[1], center[2],
    half[0], 0, 0,
    0, half[1], 0,
    0, 0, half[2],
  ];
}

function boxToBounds(box) {
  const center = [box[0], box[1], box[2]];
  const radius = [
    Math.abs(box[3]) + Math.abs(box[6]) + Math.abs(box[9]),
    Math.abs(box[4]) + Math.abs(box[7]) + Math.abs(box[10]),
    Math.abs(box[5]) + Math.abs(box[8]) + Math.abs(box[11]),
  ];
  return {
    min: [
      center[0] - radius[0],
      center[1] - radius[1],
      center[2] - radius[2],
    ],
    max: [
      center[0] + radius[0],
      center[1] + radius[1],
      center[2] + radius[2],
    ],
  };
}

function unionBoxes(boxes) {
  const bounds = createBounds();
  for (const box of boxes) {
    const child = boxToBounds(box);
    expandBounds(bounds, child.min);
    expandBounds(bounds, child.max);
  }
  return boundsToBox(bounds);
}

function updateInternalBoundingVolumes(tile) {
  if (!tile?.children?.length) return boundsFromBoundingVolume(tile?.boundingVolume);

  const childBounds = [];
  for (const child of tile.children) {
    const bounds = updateInternalBoundingVolumes(child);
    if (bounds) childBounds.push(bounds);
  }

  if (!childBounds.length) return boundsFromBoundingVolume(tile.boundingVolume);

  const bounds = createBounds();
  for (const child of childBounds) {
    expandBounds(bounds, child.min);
    expandBounds(bounds, child.max);
  }
  tile.boundingVolume = { box: boundsToBox(bounds) };
  return bounds;
}

function boundsFromBoundingVolume(boundingVolume) {
  if (!boundingVolume?.box) return undefined;
  return boxToBounds(boundingVolume.box);
}

function chooseGrid(bounds, targetParts) {
  const spanX = Math.max(bounds.max[0] - bounds.min[0], 0.001);
  const spanY = Math.max(bounds.max[1] - bounds.min[1], 0.001);
  const ratio = Math.sqrt(spanX / spanY);
  let x = clamp(Math.round(Math.sqrt(targetParts) * ratio), 1, targetParts);
  let y = Math.ceil(targetParts / x);

  while (x * y < targetParts) {
    if (spanX / x > spanY / y) x += 1;
    else y += 1;
  }

  return { x, y };
}

function getBucketIndex(point, bounds, grid) {
  const x = bucketCoord(point[0], bounds.min[0], bounds.max[0], grid.x);
  const y = bucketCoord(point[1], bounds.min[1], bounds.max[1], grid.y);
  return y * grid.x + x;
}

function bucketCoord(value, min, max, count) {
  if (count <= 1 || max <= min) return 0;
  const normalized = (value - min) / (max - min);
  return clamp(Math.floor(normalized * count), 0, count - 1);
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatBytes(value) {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${(abs / 1024 / 1024).toFixed(2)} MB`;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
