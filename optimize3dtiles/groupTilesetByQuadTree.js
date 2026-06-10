#!/usr/bin/env node

import fsp from "node:fs/promises";
import crypto from "node:crypto";
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

function printUsage() {
  console.log(`Usage:
  node optimize3dtiles/groupTilesetByQuadTree.js [inputTileset.json] [outputTileset.json] [options]

Options:
  --target-group-size <n>  Preferred tile count per generated group.
                           Default: 12
  --min-group-size <n>     Try to merge smaller groups when possible.
                           Default: 8
  --max-group-size <n>     Hard upper bound for generated group size.
                           Default: 16
  --refine <ADD|REPLACE>   Refine mode for generated group nodes.
                           Default: ADD
  --group-error <n>        Geometric error for group nodes. If omitted,
                           each group uses the max child geometricError.
  --merge-groups           Merge each spatial group into a new b3dm. This can
                           reduce tile/content count but may break analysis
                           tools that assume original b3dm granularity.
  --no-merge-primitives    Copy b3dm files without merging GLB primitives.
  --no-copy-content        Do not copy b3dm files. Keep original content uri
                           references. Only safe when output stays beside input.

Default:
  input:  static/models/横琴示范区.json
  output: static/models/横琴示范区_grouped.json

This script follows the low-risk tileset reorganization path from s1.md:
it does not simplify geometry or delete triangles. By default it keeps one b3dm
per original feature and only merges compatible primitives inside each b3dm.
Use --merge-groups only for display-only testing where coarser b3dm granularity
is acceptable.`);
}

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
    targetGroupSize: readNumberOption(args, "--target-group-size", 12),
    minGroupSize: readNumberOption(args, "--min-group-size", 8),
    maxGroupSize: readNumberOption(args, "--max-group-size", 16),
    refine: readStringOption(args, "--refine", "ADD").toUpperCase(),
    groupError: readOptionalNumberOption(args, "--group-error"),
    copyContent: !args.includes("--no-copy-content"),
    mergePrimitives: !args.includes("--no-merge-primitives"),
    mergeGroups: args.includes("--merge-groups"),
  };

  validateOptions(options);

  const inputDir = path.dirname(inputTileset);
  const outputDir = path.dirname(outputTileset);
  if (!options.copyContent && path.resolve(inputDir) !== path.resolve(outputDir)) {
    throw new Error("Output tileset must be in the same directory as the input tileset because b3dm files are not copied.");
  }

  const tileset = JSON.parse(await fsp.readFile(inputTileset, "utf8"));
  if (!tileset.root || !Array.isArray(tileset.root.children)) {
    throw new Error("Input tileset root must contain a children array.");
  }

  const originalRootChildren = tileset.root.children.length;
  const originalTileCount = countTiles(tileset.root);
  const rootChildren = tileset.root.children.map((tile, index) => makeTileInfo(tile, index));
  const groupable = rootChildren.filter((info) => info.bounds);
  const ungroupable = rootChildren.filter((info) => !info.bounds);

  if (!groupable.length) {
    throw new Error("No root child with a supported boundingVolume was found.");
  }

  const rawGroups = splitByQuadTree(groupable, options.targetGroupSize);
  const groups = mergeSmallGroups(rawGroups, options.minGroupSize, options.maxGroupSize);
  const outputModelName = path.basename(outputTileset, path.extname(outputTileset));
  const contentCopy = options.copyContent && options.mergeGroups
    ? await writeMergedGroupContents(groups, inputDir, outputDir, outputModelName, options)
    : options.copyContent
      ? await copyContentFilesForGroups(groups, inputDir, outputDir, outputModelName, options)
      : { files: 0, originalBytes: 0, outputBytes: 0, originalPrimitives: 0, outputPrimitives: 0, tiles: [] };

  tileset.root.children = options.copyContent
    ? [
      ...contentCopy.tiles,
      ...ungroupable.map((info) => info.tile),
    ]
    : [
      ...groups.map((group, index) => buildGroupTile(group, index, options)),
      ...ungroupable.map((info) => info.tile),
    ];
  const rootBounds = unionBounds(
    tileset.root.children
      .map((tile) => boundsFromBoundingVolume(tile.boundingVolume))
      .filter(Boolean),
  );
  tileset.root.boundingVolume = { box: boundsToBox(rootBounds) };

  await fsp.mkdir(path.dirname(outputTileset), { recursive: true });
  await fsp.writeFile(outputTileset, `${JSON.stringify(tileset, null, 2)}\n`);

  const groupSizes = groups.map((group) => group.length);
  const finalTileCount = countTiles(tileset.root);
  console.log(`Input tileset: ${inputTileset}`);
  console.log(`Output tileset: ${outputTileset}`);
  console.log(`Root children: ${originalRootChildren} -> ${tileset.root.children.length}`);
  console.log(`Generated groups: ${groups.length}`);
  console.log(`Group size: min ${Math.min(...groupSizes)}, max ${Math.max(...groupSizes)}, avg ${average(groupSizes).toFixed(2)}`);
  console.log(`Total tile nodes: ${originalTileCount} -> ${finalTileCount}`);
  console.log(`Ungrouped root children: ${ungroupable.length}`);
  if (options.copyContent) {
    console.log(`${options.mergeGroups ? "Merged" : "Output"} b3dm files: ${contentCopy.files}`);
    console.log(`Primitives: ${contentCopy.originalPrimitives} -> ${contentCopy.outputPrimitives}`);
    console.log(`Original b3dm size: ${formatBytes(contentCopy.originalBytes)}`);
    console.log(`Output b3dm size: ${formatBytes(contentCopy.outputBytes)}`);
  }
}

function makeDefaultOutput(inputTileset) {
  const ext = path.extname(inputTileset);
  const base = path.basename(inputTileset, ext);
  return path.join(path.dirname(inputTileset), `${base}_grouped${ext}`);
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
  for (const [name, value] of Object.entries({
    "--target-group-size": options.targetGroupSize,
    "--min-group-size": options.minGroupSize,
    "--max-group-size": options.maxGroupSize,
  })) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }

  if (options.minGroupSize > options.maxGroupSize) {
    throw new Error("--min-group-size must be less than or equal to --max-group-size.");
  }
  if (options.targetGroupSize > options.maxGroupSize) {
    throw new Error("--target-group-size must be less than or equal to --max-group-size.");
  }
  if (!["ADD", "REPLACE"].includes(options.refine)) {
    throw new Error("--refine must be ADD or REPLACE.");
  }
  if (options.groupError !== undefined && !Number.isFinite(options.groupError)) {
    throw new Error("--group-error must be a finite number.");
  }
}

function makeTileInfo(tile, index) {
  const bounds = boundsFromBoundingVolume(tile.boundingVolume);
  return {
    tile,
    index,
    bounds,
    center: bounds ? boundsCenter(bounds) : undefined,
  };
}

function splitByQuadTree(tileInfos, targetGroupSize) {
  if (tileInfos.length <= targetGroupSize) return [tileInfos];

  const bounds = unionBounds(tileInfos.map((info) => info.bounds));
  const midpoint = boundsCenter(bounds);
  const buckets = [[], [], [], []];

  for (const info of tileInfos) {
    const east = info.center[0] >= midpoint[0] ? 1 : 0;
    const north = info.center[1] >= midpoint[1] ? 2 : 0;
    buckets[east + north].push(info);
  }

  const nonEmpty = buckets.filter((bucket) => bucket.length > 0);
  if (nonEmpty.length <= 1 || nonEmpty.some((bucket) => bucket.length === tileInfos.length)) {
    return splitByMedian(tileInfos, targetGroupSize);
  }

  return nonEmpty.flatMap((bucket) => splitByQuadTree(bucket, targetGroupSize));
}

function splitByMedian(tileInfos, targetGroupSize) {
  if (tileInfos.length <= targetGroupSize) return [tileInfos];

  const bounds = unionBounds(tileInfos.map((info) => info.bounds));
  const axis = bounds.max[0] - bounds.min[0] >= bounds.max[1] - bounds.min[1] ? 0 : 1;
  const sorted = [...tileInfos].sort((a, b) => {
    const delta = a.center[axis] - b.center[axis];
    return delta || a.index - b.index;
  });
  const middle = Math.ceil(sorted.length / 2);

  return [
    ...splitByMedian(sorted.slice(0, middle), targetGroupSize),
    ...splitByMedian(sorted.slice(middle), targetGroupSize),
  ];
}

function mergeSmallGroups(groups, minGroupSize, maxGroupSize) {
  let next = groups.map((group) => [...group]);
  let changed = true;

  while (changed) {
    changed = false;
    next.sort((a, b) => a.length - b.length);

    const smallIndex = next.findIndex((group) => group.length > 0 && group.length < minGroupSize);
    if (smallIndex < 0) break;

    const small = next[smallIndex];
    const targetIndex = findNearestMergeTarget(next, smallIndex, maxGroupSize);
    if (targetIndex < 0) break;

    next[targetIndex] = [...next[targetIndex], ...small];
    next.splice(smallIndex, 1);
    changed = true;
  }

  return next;
}

function findNearestMergeTarget(groups, sourceIndex, maxGroupSize) {
  const source = groups[sourceIndex];
  const sourceCenter = groupCenter(source);
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < groups.length; index += 1) {
    if (index === sourceIndex) continue;
    const candidate = groups[index];
    if (candidate.length + source.length > maxGroupSize) continue;

    const distance = distanceSquared(sourceCenter, groupCenter(candidate));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function buildGroupTile(group, index, options) {
  const groupBounds = unionBounds(group.map((info) => info.bounds));
  const maxChildError = Math.max(0, ...group.map((info) => Number(info.tile.geometricError) || 0));
  return {
    boundingVolume: { box: boundsToBox(groupBounds) },
    geometricError: options.groupError ?? maxChildError,
    refine: options.refine,
    children: group
      .sort((a, b) => a.index - b.index)
      .map((info) => info.tile),
  };
}

async function copyContentFilesForGroups(groups, inputDir, outputDir, outputModelName, options) {
  const tiles = groups.map((group, index) => buildGroupTile(group, index, options));
  const totals = await copyContentFiles({ children: tiles }, inputDir, outputDir, outputModelName, options);
  return {
    ...totals,
    tiles,
  };
}

async function writeMergedGroupContents(groups, inputDir, outputDir, outputModelName, options) {
  const outputContentDir = path.join(outputDir, outputModelName);
  const totals = {
    files: 0,
    originalBytes: 0,
    outputBytes: 0,
    originalPrimitives: 0,
    outputPrimitives: 0,
    tiles: [],
  };

  await fsp.rm(outputContentDir, { recursive: true, force: true });
  await fsp.mkdir(outputContentDir, { recursive: true });

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index].sort((a, b) => a.index - b.index);
    const outputName = `merged_${String(index).padStart(3, "0")}.b3dm`;
    const outputPath = path.join(outputContentDir, outputName);
    const result = await mergeGroupB3dmFiles(group, inputDir, outputPath);
    const bounds = unionBounds(group.map((info) => info.bounds));
    const maxChildError = Math.max(0, ...group.map((info) => Number(info.tile.geometricError) || 0));

    totals.files += 1;
    totals.originalBytes += result.originalBytes;
    totals.outputBytes += result.outputBytes;
    totals.originalPrimitives += result.originalPrimitives;
    totals.outputPrimitives += result.outputPrimitives;
    totals.tiles.push({
      boundingVolume: { box: boundsToBox(bounds) },
      content: { uri: `./${outputModelName}/${outputName}` },
      geometricError: options.groupError ?? maxChildError,
      refine: options.refine,
    });
  }

  return totals;
}

async function mergeGroupB3dmFiles(group, inputDir, outputPath) {
  const sources = [];
  const totals = {
    originalBytes: 0,
    originalPrimitives: 0,
  };

  let batchOffset = 0;
  for (const info of group) {
    const uri = info.tile.content?.uri ?? info.tile.content?.url;
    if (!uri) continue;

    const sourcePath = path.resolve(inputDir, safeDecodeUri(stripUriQuery(uri)).replaceAll("/", path.sep));
    const b3dm = await fsp.readFile(sourcePath);
    const parsed = parseB3dm(b3dm);
    const glb = parseGlb(parsed.glb);
    const batchLength = Number(parsed.featureJson?.BATCH_LENGTH ?? 0);

    sources.push({
      path: sourcePath,
      b3dm,
      gltf: glb.gltf,
      bin: glb.bin,
      featureJson: parsed.featureJson,
      batchJson: parsed.batchJson,
      batchLength,
      batchOffset,
    });
    totals.originalBytes += b3dm.length;
    totals.originalPrimitives += countPrimitives(glb.gltf);
    batchOffset += batchLength;
  }

  const batchLength = sources.reduce((sum, source) => sum + source.batchLength, 0);
  const batchJson = mergeBatchJson(sources);
  const mergedGlb = mergeSourcesToGlb(sources);
  const output = buildB3dm({
    featureJson: { BATCH_LENGTH: batchLength },
    batchJson,
    glb: mergedGlb.buffer,
  });

  await fsp.writeFile(outputPath, output);

  return {
    ...totals,
    outputBytes: output.length,
    outputPrimitives: mergedGlb.outputPrimitives,
  };
}

function mergeBatchJson(sources) {
  const keys = new Set();
  for (const source of sources) {
    for (const key of Object.keys(source.batchJson ?? {})) keys.add(key);
  }

  const output = {};
  for (const key of keys) {
    output[key] = [];
    for (const source of sources) {
      const value = source.batchJson?.[key];
      if (Array.isArray(value)) {
        output[key].push(...value);
      } else {
        for (let index = 0; index < source.batchLength; index += 1) output[key].push(null);
      }
    }
  }

  return output;
}

function buildB3dm({ featureJson, batchJson, glb }) {
  const headerLength = 28;
  const featureJsonBuffer = padJsonForB3dm(Buffer.from(JSON.stringify(featureJson), "utf8"), headerLength);
  const batchJsonBuffer = padJsonForB3dm(Buffer.from(JSON.stringify(batchJson), "utf8"), headerLength + featureJsonBuffer.length);
  const totalLength = headerLength + featureJsonBuffer.length + batchJsonBuffer.length + glb.length;
  const output = Buffer.allocUnsafe(totalLength);

  output.write("b3dm", 0, 4, "utf8");
  output.writeUInt32LE(1, 4);
  output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(featureJsonBuffer.length, 12);
  output.writeUInt32LE(0, 16);
  output.writeUInt32LE(batchJsonBuffer.length, 20);
  output.writeUInt32LE(0, 24);
  featureJsonBuffer.copy(output, headerLength);
  batchJsonBuffer.copy(output, headerLength + featureJsonBuffer.length);
  glb.copy(output, headerLength + featureJsonBuffer.length + batchJsonBuffer.length);

  return output;
}

function padJsonForB3dm(buffer, startOffset) {
  const targetLength = buffer.length + ((8 - ((startOffset + buffer.length) % 8)) % 8);
  const padded = Buffer.alloc(targetLength, 0x20);
  buffer.copy(padded);
  return padded;
}

async function copyContentFiles(root, inputDir, outputDir, outputModelName, options) {
  const outputContentDir = path.join(outputDir, outputModelName);
  const usedNames = new Set();
  const copied = new Map();
  const totals = {
    files: 0,
    originalBytes: 0,
    outputBytes: 0,
    originalPrimitives: 0,
    outputPrimitives: 0,
  };

  await fsp.rm(outputContentDir, { recursive: true, force: true });
  await fsp.mkdir(outputContentDir, { recursive: true });

  for (const tile of collectContentTiles(root)) {
    const content = tile.content;
    const uri = content?.uri ?? content?.url;
    if (!uri || !stripUriQuery(uri).toLowerCase().endsWith(".b3dm")) continue;

    const sourcePath = path.resolve(inputDir, safeDecodeUri(stripUriQuery(uri)).replaceAll("/", path.sep));
    const sourceKey = sourcePath.toLowerCase();
    let outputName = copied.get(sourceKey);

    if (!outputName) {
      outputName = makeUniqueFileName(path.basename(sourcePath), usedNames);
      const outputPath = path.join(outputContentDir, outputName);
      const result = options.mergePrimitives
        ? await mergeB3dmPrimitivesFile(sourcePath, outputPath)
        : await copyB3dmFile(sourcePath, outputPath);
      copied.set(sourceKey, outputName);
      totals.files += 1;
      totals.originalBytes += result.originalBytes;
      totals.outputBytes += result.outputBytes;
      totals.originalPrimitives += result.originalPrimitives;
      totals.outputPrimitives += result.outputPrimitives;
    }

    setContentUri(content, `./${outputModelName}/${encodeUriPathSegment(outputName)}`);
  }

  return totals;
}

async function copyB3dmFile(sourcePath, outputPath) {
  const source = await fsp.readFile(sourcePath);
  await fsp.writeFile(outputPath, source);
  const primitives = countB3dmPrimitives(source);
  return {
    originalBytes: source.length,
    outputBytes: source.length,
    originalPrimitives: primitives,
    outputPrimitives: primitives,
  };
}

async function mergeB3dmPrimitivesFile(sourcePath, outputPath) {
  const source = await fsp.readFile(sourcePath);
  const parsed = parseB3dm(source);
  const merged = mergeGlbPrimitives(parsed.glb);
  const output = Buffer.concat([parsed.prefix, merged.buffer]);

  output.writeUInt32LE(output.length, 8);
  await fsp.writeFile(outputPath, output);

  return {
    originalBytes: source.length,
    outputBytes: output.length,
    originalPrimitives: merged.originalPrimitives,
    outputPrimitives: merged.outputPrimitives,
  };
}

function countB3dmPrimitives(buffer) {
  const parsed = parseB3dm(buffer);
  const { gltf } = parseGlb(parsed.glb);
  return countPrimitives(gltf);
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
  const featureJsonOffset = 28;
  const featureBinOffset = featureJsonOffset + featureJsonLength;
  const batchJsonOffset = featureBinOffset + featureBinLength;
  const batchBinOffset = batchJsonOffset + batchJsonLength;
  let glbOffset = 28 + featureJsonLength + featureBinLength + batchJsonLength + batchBinLength;

  if (buffer.toString("utf8", glbOffset, glbOffset + 4) !== "glTF") {
    glbOffset = buffer.indexOf(Buffer.from("glTF"), 20);
  }
  if (glbOffset < 0) throw new Error("Could not locate embedded GLB in b3dm.");

  return {
    prefix: Buffer.from(buffer.subarray(0, glbOffset)),
    featureJson: parsePaddedJson(buffer, featureJsonOffset, featureJsonLength),
    featureBin: buffer.subarray(featureBinOffset, featureBinOffset + featureBinLength),
    batchJson: parsePaddedJson(buffer, batchJsonOffset, batchJsonLength),
    batchBin: buffer.subarray(batchBinOffset, batchBinOffset + batchBinLength),
    glb: buffer.subarray(glbOffset),
  };
}

function parsePaddedJson(buffer, offset, length) {
  if (!length) return {};
  const text = buffer.toString("utf8", offset, offset + length).trim();
  return text ? JSON.parse(text) : {};
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

function mergeGlbPrimitives(sourceGlb) {
  const { gltf, bin } = parseGlb(sourceGlb);
  const target = structuredClone(gltf);
  const chunks = [];
  const stats = {
    originalPrimitives: countPrimitives(gltf),
    outputPrimitives: 0,
  };

  target.accessors = [];
  target.bufferViews = [];
  target.buffers = [{ byteLength: 0 }];
  remapNonGeometryBufferViews(gltf, target, bin, chunks);

  target.meshes = (gltf.meshes ?? []).map((mesh) => {
    const primitiveGroups = groupMergeablePrimitives(gltf, mesh.primitives ?? []);
    const nextMesh = { ...mesh, primitives: [] };

    for (const group of primitiveGroups) {
      if (group.length > 1) {
        nextMesh.primitives.push(mergePrimitiveGroup(gltf, bin, group, target, chunks));
      } else {
        nextMesh.primitives.push(copyPrimitive(gltf, bin, group[0], target, chunks));
      }
    }

    stats.outputPrimitives += nextMesh.primitives.length;
    return nextMesh;
  });

  return {
    buffer: buildGlb(target, chunks),
    ...stats,
  };
}

function mergeSourcesToGlb(sources) {
  const base = sources[0]?.gltf;
  if (!base) throw new Error("Cannot merge an empty b3dm group.");

  const target = {
    asset: structuredClone(base.asset ?? { version: "2.0" }),
    ...(base.extensionsUsed ? { extensionsUsed: structuredClone(base.extensionsUsed) } : {}),
    ...(base.extensionsRequired ? { extensionsRequired: structuredClone(base.extensionsRequired) } : {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [] }],
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
    samplers: [],
    images: [],
    textures: [],
    materials: [],
  };
  const chunks = [];
  const resourceCache = {
    samplers: new Map(),
    images: new Map(),
    textures: new Map(),
    materials: new Map(),
  };
  const primitiveEntries = [];
  let entryId = 0;

  for (const source of sources) {
    const resources = remapSourceResources(source, target, chunks, resourceCache);
    for (const mesh of source.gltf.meshes ?? []) {
      for (const primitive of mesh.primitives ?? []) {
        primitiveEntries.push({
          id: entryId,
          source,
          gltf: source.gltf,
          bin: source.bin,
          primitive,
          material: primitive.material !== undefined ? resources.materials.get(primitive.material) : undefined,
          batchOffset: source.batchOffset,
          batchLength: source.batchLength,
        });
        entryId += 1;
      }
    }
  }

  const groups = groupCrossSourcePrimitives(primitiveEntries);
  for (const group of groups) {
    if (group.length > 1) {
      target.meshes[0].primitives.push(mergeCrossPrimitiveGroup(group, target, chunks));
    } else {
      target.meshes[0].primitives.push(copyCrossPrimitive(group[0], target, chunks));
    }
  }

  return {
    buffer: buildGlb(target, chunks),
    outputPrimitives: target.meshes[0].primitives.length,
  };
}

function remapSourceResources(source, target, chunks, cache) {
  const imageMap = new Map();
  const samplerMap = new Map();
  const textureMap = new Map();
  const materialMap = new Map();

  for (let index = 0; index < (source.gltf.samplers?.length ?? 0); index += 1) {
    samplerMap.set(index, ensureSampler(source.gltf.samplers[index], target, cache));
  }

  for (let index = 0; index < (source.gltf.images?.length ?? 0); index += 1) {
    imageMap.set(index, ensureImage(source.gltf, source.bin, source.gltf.images[index], target, chunks, cache));
  }

  for (let index = 0; index < (source.gltf.textures?.length ?? 0); index += 1) {
    const texture = source.gltf.textures[index];
    textureMap.set(index, ensureTexture(texture, target, cache, imageMap, samplerMap));
  }

  for (let index = 0; index < (source.gltf.materials?.length ?? 0); index += 1) {
    materialMap.set(index, ensureMaterial(source.gltf.materials[index], target, cache, textureMap));
  }

  return { materials: materialMap };
}

function ensureSampler(sampler, target, cache) {
  const key = JSON.stringify(sampler ?? {});
  if (cache.samplers.has(key)) return cache.samplers.get(key);

  const index = target.samplers.length;
  target.samplers.push(structuredClone(sampler ?? {}));
  cache.samplers.set(key, index);
  return index;
}

function ensureImage(gltf, bin, image, target, chunks, cache) {
  let imageBytes = null;
  let imageHash = image.uri ?? "";

  if (image.bufferView !== undefined) {
    const view = gltf.bufferViews[image.bufferView];
    imageBytes = copyBufferView(bin, view);
    imageHash = crypto.createHash("sha1").update(imageBytes).digest("hex");
  }

  const imageTemplate = structuredClone(image);
  delete imageTemplate.bufferView;
  const key = JSON.stringify({ ...imageTemplate, imageHash });
  if (cache.images.has(key)) return cache.images.get(key);

  const nextImage = structuredClone(imageTemplate);
  if (imageBytes) {
    nextImage.bufferView = addBufferView(target, chunks, imageBytes);
  }

  const index = target.images.length;
  target.images.push(nextImage);
  cache.images.set(key, index);
  return index;
}

function ensureTexture(texture, target, cache, imageMap, samplerMap) {
  const nextTexture = structuredClone(texture ?? {});
  if (nextTexture.source !== undefined) nextTexture.source = imageMap.get(nextTexture.source);
  if (nextTexture.sampler !== undefined) nextTexture.sampler = samplerMap.get(nextTexture.sampler);

  const key = JSON.stringify(nextTexture);
  if (cache.textures.has(key)) return cache.textures.get(key);

  const index = target.textures.length;
  target.textures.push(nextTexture);
  cache.textures.set(key, index);
  return index;
}

function ensureMaterial(material, target, cache, textureMap) {
  const nextMaterial = remapMaterialTextureIndices(structuredClone(material ?? {}), textureMap);
  const key = JSON.stringify(nextMaterial);
  if (cache.materials.has(key)) return cache.materials.get(key);

  const index = target.materials.length;
  target.materials.push(nextMaterial);
  cache.materials.set(key, index);
  return index;
}

function remapMaterialTextureIndices(value, textureMap) {
  if (Array.isArray(value)) return value.map((item) => remapMaterialTextureIndices(item, textureMap));
  if (!value || typeof value !== "object") return value;

  for (const [key, child] of Object.entries(value)) {
    if (key === "index" && Number.isInteger(child) && textureMap.has(child)) {
      value[key] = textureMap.get(child);
    } else {
      value[key] = remapMaterialTextureIndices(child, textureMap);
    }
  }
  return value;
}

function groupCrossSourcePrimitives(entries) {
  const groups = [];
  const byKey = new Map();

  for (const entry of entries) {
    const key = getCrossPrimitiveMergeKey(entry);
    if (!key) {
      groups.push([entry]);
      continue;
    }

    let group = byKey.get(key);
    if (!group) {
      group = [];
      byKey.set(key, group);
      groups.push(group);
    }
    group.push(entry);
  }

  return groups;
}

function getCrossPrimitiveMergeKey(entry) {
  const { gltf, primitive, material } = entry;
  if ((primitive.mode ?? 4) !== 4) return undefined;
  if (primitive.targets) return undefined;
  if (!primitive.attributes || primitive.attributes.POSITION === undefined) return undefined;

  const entries = Object.entries(primitive.attributes).sort(([a], [b]) => a.localeCompare(b));
  const layout = [];
  let vertexCount;

  for (const [semantic, accessorIndex] of entries) {
    const accessor = gltf.accessors?.[accessorIndex];
    if (!canCopyAccessor(accessor)) return undefined;
    vertexCount ??= accessor.count;
    if (accessor.count !== vertexCount) return undefined;
    layout.push([
      semantic,
      accessor.componentType,
      accessor.type,
      accessor.normalized === true,
    ].join(":"));
  }

  if (primitive.indices !== undefined) {
    const indexAccessor = gltf.accessors?.[primitive.indices];
    if (!canCopyAccessor(indexAccessor)) return undefined;
    if (![5121, 5123, 5125].includes(indexAccessor.componentType) || indexAccessor.type !== "SCALAR") return undefined;
  }

  return JSON.stringify({
    mode: primitive.mode ?? 4,
    material: material ?? -1,
    attributes: layout,
    extensions: primitive.extensions ?? null,
    extras: primitive.extras ?? null,
  });
}

function mergeCrossPrimitiveGroup(entries, target, chunks) {
  const first = entries[0];
  const attributeEntries = Object.entries(first.primitive.attributes).sort(([a], [b]) => a.localeCompare(b));
  const mergedVertices = [];
  const vertexMap = new Map();
  const indexValues = [];

  function getMergedVertexIndex(entry, sourceIndex) {
    const key = `${entry.id}:${sourceIndex}`;
    let localIndex = vertexMap.get(key);
    if (localIndex !== undefined) return localIndex;

    localIndex = mergedVertices.length;
    vertexMap.set(key, localIndex);
    mergedVertices.push({ entry, sourceIndex });
    return localIndex;
  }

  for (const entry of entries) {
    const sourceIndices = entry.primitive.indices !== undefined
      ? readIndexArray(entry.gltf, entry.bin, entry.gltf.accessors[entry.primitive.indices])
      : makeSequentialIndices(entry.gltf.accessors[entry.primitive.attributes.POSITION].count);

    for (const sourceIndex of sourceIndices) {
      indexValues.push(getMergedVertexIndex(entry, sourceIndex));
    }
  }

  const attributes = {};
  for (const [semantic] of attributeEntries) {
    attributes[semantic] = addCrossMergedAttributeAccessor(target, chunks, semantic, mergedVertices);
  }

  const indexComponentType = mergedVertices.length <= 65535 ? 5123 : 5125;
  const indexElementSize = indexComponentType === 5123 ? 2 : 4;
  const indexBuffer = Buffer.allocUnsafe(indexValues.length * indexElementSize);
  let maxIndex = 0;

  for (let index = 0; index < indexValues.length; index += 1) {
    const value = indexValues[index];
    maxIndex = Math.max(maxIndex, value);
    if (indexComponentType === 5123) indexBuffer.writeUInt16LE(value, index * 2);
    else indexBuffer.writeUInt32LE(value, index * 4);
  }

  const indexView = addBufferView(target, chunks, indexBuffer, { target: ELEMENT_ARRAY_BUFFER });
  const indexAccessor = addAccessor(target, {
    bufferView: indexView,
    componentType: indexComponentType,
    count: indexValues.length,
    type: "SCALAR",
    min: [0],
    max: [maxIndex],
  });
  const nextPrimitive = {
    ...first.primitive,
    attributes,
    indices: indexAccessor,
  };

  if (first.material !== undefined) nextPrimitive.material = first.material;
  else delete nextPrimitive.material;
  return nextPrimitive;
}

function copyCrossPrimitive(entry, target, chunks) {
  return mergeCrossPrimitiveGroup([entry], target, chunks);
}

function addCrossMergedAttributeAccessor(target, chunks, semantic, mergedVertices) {
  const firstAccessor = mergedVertices[0].entry.gltf.accessors[mergedVertices[0].entry.primitive.attributes[semantic]];
  const elementSize = getAccessorElementSize(firstAccessor);
  const data = Buffer.allocUnsafe(mergedVertices.length * elementSize);

  for (let index = 0; index < mergedVertices.length; index += 1) {
    const vertex = mergedVertices[index];
    const accessor = vertex.entry.gltf.accessors[vertex.entry.primitive.attributes[semantic]];
    if (isBatchIdSemantic(semantic)) {
      copyBatchIdElement(vertex.entry.gltf, vertex.entry.bin, accessor, vertex.sourceIndex, data, index * elementSize, vertex.entry.batchOffset);
    } else {
      copyAccessorElement(vertex.entry.gltf, vertex.entry.bin, accessor, vertex.sourceIndex, data, index * elementSize);
    }
  }

  const viewIndex = addBufferView(target, chunks, data, { target: ARRAY_BUFFER });
  const nextAccessor = {
    ...firstAccessor,
    bufferView: viewIndex,
    byteOffset: 0,
    count: mergedVertices.length,
  };
  delete nextAccessor.sparse;

  if (isBatchIdSemantic(semantic)) {
    let maxBatchId = 0;
    for (const vertex of mergedVertices) {
      maxBatchId = Math.max(maxBatchId, vertex.entry.batchOffset + vertex.entry.batchLength - 1);
    }
    nextAccessor.min = [0];
    nextAccessor.max = [maxBatchId];
  } else if (firstAccessor.min || firstAccessor.max || semantic === "POSITION") {
    const bounds = computeCrossAccessorBounds(semantic, mergedVertices);
    nextAccessor.min = bounds.min;
    nextAccessor.max = bounds.max;
  }

  return addAccessor(target, nextAccessor);
}

function copyBatchIdElement(gltf, bin, accessor, index, target, targetOffset, batchOffset) {
  const value = readAccessorComponent(gltf, bin, accessor, index, 0) + batchOffset;
  writeAccessorComponent(target, targetOffset, accessor.componentType, value);
}

function writeAccessorComponent(buffer, offset, componentType, value) {
  switch (componentType) {
    case 5120: buffer.writeInt8(value, offset); break;
    case 5121: buffer.writeUInt8(value, offset); break;
    case 5122: buffer.writeInt16LE(value, offset); break;
    case 5123: buffer.writeUInt16LE(value, offset); break;
    case 5125: buffer.writeUInt32LE(value, offset); break;
    case 5126: buffer.writeFloatLE(value, offset); break;
    default: throw new Error(`Unsupported component type: ${componentType}`);
  }
}

function computeCrossAccessorBounds(semantic, mergedVertices) {
  const firstAccessor = mergedVertices[0].entry.gltf.accessors[mergedVertices[0].entry.primitive.attributes[semantic]];
  const components = TYPE_COMPONENTS.get(firstAccessor.type);
  const min = new Array(components).fill(Number.POSITIVE_INFINITY);
  const max = new Array(components).fill(Number.NEGATIVE_INFINITY);

  for (const vertex of mergedVertices) {
    const accessor = vertex.entry.gltf.accessors[vertex.entry.primitive.attributes[semantic]];
    for (let component = 0; component < components; component += 1) {
      const value = readAccessorComponent(vertex.entry.gltf, vertex.entry.bin, accessor, vertex.sourceIndex, component);
      if (value < min[component]) min[component] = value;
      if (value > max[component]) max[component] = value;
    }
  }

  return { min, max };
}

function isBatchIdSemantic(semantic) {
  return semantic === "_BATCHID" || semantic === "BATCHID";
}

function groupMergeablePrimitives(gltf, primitives) {
  const groups = [];
  const byKey = new Map();

  for (const primitive of primitives) {
    const key = getPrimitiveMergeKey(gltf, primitive);
    if (!key) {
      groups.push([primitive]);
      continue;
    }

    let group = byKey.get(key);
    if (!group) {
      group = [];
      byKey.set(key, group);
      groups.push(group);
    }
    group.push(primitive);
  }

  return groups;
}

function getPrimitiveMergeKey(gltf, primitive) {
  if ((primitive.mode ?? 4) !== 4) return undefined;
  if (primitive.targets) return undefined;
  if (!primitive.attributes || primitive.attributes.POSITION === undefined) return undefined;

  const entries = Object.entries(primitive.attributes).sort(([a], [b]) => a.localeCompare(b));
  const layout = [];
  let vertexCount;

  for (const [semantic, accessorIndex] of entries) {
    const accessor = gltf.accessors?.[accessorIndex];
    if (!canCopyAccessor(accessor)) return undefined;
    vertexCount ??= accessor.count;
    if (accessor.count !== vertexCount) return undefined;
    layout.push([
      semantic,
      accessor.componentType,
      accessor.type,
      accessor.normalized === true,
    ].join(":"));
  }

  if (primitive.indices !== undefined) {
    const indexAccessor = gltf.accessors?.[primitive.indices];
    if (!canCopyAccessor(indexAccessor)) return undefined;
    if (![5121, 5123, 5125].includes(indexAccessor.componentType) || indexAccessor.type !== "SCALAR") return undefined;
  }

  return JSON.stringify({
    mode: primitive.mode ?? 4,
    material: primitive.material ?? -1,
    attributes: layout,
    extensions: primitive.extensions ?? null,
    extras: primitive.extras ?? null,
  });
}

function canCopyAccessor(accessor) {
  if (!accessor || accessor.bufferView === undefined || accessor.sparse) return false;
  return COMPONENT_BYTES.has(accessor.componentType) && TYPE_COMPONENTS.has(accessor.type);
}

function mergePrimitiveGroup(source, bin, primitives, target, chunks) {
  const first = primitives[0];
  const attributeEntries = Object.entries(first.attributes).sort(([a], [b]) => a.localeCompare(b));
  const mergedVertices = [];
  const vertexMap = new Map();
  const indexValues = [];

  function getMergedVertexIndex(primitiveIndex, sourceIndex) {
    const primitive = primitives[primitiveIndex];
    const key = makeVertexKey(source, bin, primitive, attributeEntries, sourceIndex);
    let localIndex = vertexMap.get(key);
    if (localIndex !== undefined) return localIndex;

    localIndex = mergedVertices.length;
    vertexMap.set(key, localIndex);
    mergedVertices.push({ primitive: primitives[primitiveIndex], sourceIndex });
    return localIndex;
  }

  for (let primitiveIndex = 0; primitiveIndex < primitives.length; primitiveIndex += 1) {
    const primitive = primitives[primitiveIndex];
    const sourceIndices = primitive.indices !== undefined
      ? readIndexArray(source, bin, source.accessors[primitive.indices])
      : makeSequentialIndices(source.accessors[primitive.attributes.POSITION].count);

    for (const sourceIndex of sourceIndices) {
      indexValues.push(getMergedVertexIndex(primitiveIndex, sourceIndex));
    }
  }

  const attributes = {};
  for (const [semantic] of attributeEntries) {
    attributes[semantic] = addMergedAttributeAccessor(source, bin, target, chunks, primitives, semantic, mergedVertices);
  }

  const indexComponentType = mergedVertices.length <= 65535 ? 5123 : 5125;
  const indexElementSize = indexComponentType === 5123 ? 2 : 4;
  const indexBuffer = Buffer.allocUnsafe(indexValues.length * indexElementSize);
  let maxIndex = 0;

  for (let index = 0; index < indexValues.length; index += 1) {
    const value = indexValues[index];
    maxIndex = Math.max(maxIndex, value);
    if (indexComponentType === 5123) indexBuffer.writeUInt16LE(value, index * 2);
    else indexBuffer.writeUInt32LE(value, index * 4);
  }

  const indexView = addBufferView(target, chunks, indexBuffer, { target: ELEMENT_ARRAY_BUFFER });
  const indexAccessor = addAccessor(target, {
    bufferView: indexView,
    componentType: indexComponentType,
    count: indexValues.length,
    type: "SCALAR",
    min: [0],
    max: [maxIndex],
  });

  return {
    ...first,
    attributes,
    indices: indexAccessor,
  };
}

function copyPrimitive(source, bin, primitive, target, chunks) {
  if (getPrimitiveMergeKey(source, primitive)) {
    return mergePrimitiveGroup(source, bin, [primitive], target, chunks);
  }

  const attributes = {};
  for (const [semantic, accessorIndex] of Object.entries(primitive.attributes ?? {})) {
    attributes[semantic] = addCopiedAccessor(source, bin, target, chunks, accessorIndex, ARRAY_BUFFER);
  }

  const nextPrimitive = { ...primitive, attributes };
  if (primitive.indices !== undefined) {
    nextPrimitive.indices = addCopiedAccessor(source, bin, target, chunks, primitive.indices, ELEMENT_ARRAY_BUFFER);
  } else {
    delete nextPrimitive.indices;
  }
  return nextPrimitive;
}

function makeVertexKey(source, bin, primitive, attributeEntries, sourceIndex) {
  return Buffer.concat(attributeEntries.map(([, accessorIndex]) => {
    return copyAccessorElementToBuffer(source, bin, source.accessors[accessorIndex], sourceIndex);
  })).toString("base64");
}

function addMergedAttributeAccessor(source, bin, target, chunks, primitives, semantic, mergedVertices) {
  const firstAccessor = source.accessors[primitives[0].attributes[semantic]];
  const elementSize = getAccessorElementSize(firstAccessor);
  const data = Buffer.allocUnsafe(mergedVertices.length * elementSize);

  for (let index = 0; index < mergedVertices.length; index += 1) {
    const vertex = mergedVertices[index];
    const accessor = source.accessors[vertex.primitive.attributes[semantic]];
    copyAccessorElement(source, bin, accessor, vertex.sourceIndex, data, index * elementSize);
  }

  const viewIndex = addBufferView(target, chunks, data, { target: ARRAY_BUFFER });
  const nextAccessor = {
    ...firstAccessor,
    bufferView: viewIndex,
    byteOffset: 0,
    count: mergedVertices.length,
  };
  delete nextAccessor.sparse;

  if (firstAccessor.min || firstAccessor.max || semantic === "POSITION") {
    const bounds = computeMergedAccessorBounds(source, bin, semantic, mergedVertices);
    nextAccessor.min = bounds.min;
    nextAccessor.max = bounds.max;
  }

  return addAccessor(target, nextAccessor);
}

function addCopiedAccessor(source, bin, target, chunks, accessorIndex, bufferTarget) {
  const accessor = source.accessors[accessorIndex];
  const elementSize = getAccessorElementSize(accessor);
  const data = Buffer.allocUnsafe(accessor.count * elementSize);

  for (let index = 0; index < accessor.count; index += 1) {
    copyAccessorElement(source, bin, accessor, index, data, index * elementSize);
  }

  const viewIndex = addBufferView(target, chunks, data, { target: bufferTarget });
  const nextAccessor = { ...accessor, bufferView: viewIndex, byteOffset: 0 };
  delete nextAccessor.sparse;
  return addAccessor(target, nextAccessor);
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

function computeMergedAccessorBounds(source, bin, semantic, mergedVertices) {
  const firstAccessor = source.accessors[mergedVertices[0].primitive.attributes[semantic]];
  const components = TYPE_COMPONENTS.get(firstAccessor.type);
  const min = new Array(components).fill(Number.POSITIVE_INFINITY);
  const max = new Array(components).fill(Number.NEGATIVE_INFINITY);

  for (const vertex of mergedVertices) {
    const accessor = source.accessors[vertex.primitive.attributes[semantic]];
    for (let component = 0; component < components; component += 1) {
      const value = readAccessorComponent(source, bin, accessor, vertex.sourceIndex, component);
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

function copyAccessorElementToBuffer(source, bin, accessor, index) {
  const view = source.bufferViews[accessor.bufferView];
  const elementSize = getAccessorElementSize(accessor);
  const stride = view.byteStride ?? elementSize;
  const sourceOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * stride;
  return Buffer.from(bin.subarray(sourceOffset, sourceOffset + elementSize));
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

  for (let index = 0; index < accessor.count; index += 1) {
    const cursor = offset + index * stride;
    if (accessor.componentType === 5125) result[index] = bin.readUInt32LE(cursor);
    else if (accessor.componentType === 5123) result[index] = bin.readUInt16LE(cursor);
    else if (accessor.componentType === 5121) result[index] = bin.readUInt8(cursor);
    else throw new Error(`Unsupported index component type: ${accessor.componentType}`);
  }

  return result;
}

function makeSequentialIndices(count) {
  return Array.from({ length: count }, (_, index) => index);
}

function countPrimitives(gltf) {
  return (gltf.meshes ?? []).reduce((sum, mesh) => sum + (mesh.primitives?.length ?? 0), 0);
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

function collectContentTiles(root) {
  const tiles = [];

  function walk(tile) {
    if (!tile) return;
    if (tile.content?.uri || tile.content?.url) tiles.push(tile);
    for (const child of tile.children ?? []) walk(child);
  }

  walk(root);
  return tiles;
}

function makeUniqueFileName(fileName, usedNames) {
  const parsed = path.parse(fileName);
  let candidate = fileName;
  let index = 1;

  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${parsed.name}_${index}${parsed.ext}`;
    index += 1;
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function setContentUri(content, uri) {
  if (content.uri !== undefined) content.uri = uri;
  else content.url = uri;
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

function encodeUriPathSegment(value) {
  return encodeURIComponent(value).replaceAll("%2E", ".");
}

function boundsFromBoundingVolume(boundingVolume) {
  if (!boundingVolume) return undefined;
  if (Array.isArray(boundingVolume.box) && boundingVolume.box.length >= 12) {
    return boundsFromBox(boundingVolume.box);
  }
  if (Array.isArray(boundingVolume.sphere) && boundingVolume.sphere.length >= 4) {
    return boundsFromSphere(boundingVolume.sphere);
  }
  return undefined;
}

function boundsFromBox(box) {
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

function boundsFromSphere(sphere) {
  const radius = Math.max(0, sphere[3]);
  return {
    min: [sphere[0] - radius, sphere[1] - radius, sphere[2] - radius],
    max: [sphere[0] + radius, sphere[1] + radius, sphere[2] + radius],
  };
}

function unionBounds(boundsList) {
  const result = {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  };

  for (const bounds of boundsList) {
    for (let axis = 0; axis < 3; axis += 1) {
      result.min[axis] = Math.min(result.min[axis], bounds.min[axis]);
      result.max[axis] = Math.max(result.max[axis], bounds.max[axis]);
    }
  }

  return result;
}

function boundsCenter(bounds) {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
}

function boundsToBox(bounds) {
  const center = boundsCenter(bounds);
  const half = [
    Math.max((bounds.max[0] - bounds.min[0]) / 2, 0.001),
    Math.max((bounds.max[1] - bounds.min[1]) / 2, 0.001),
    Math.max((bounds.max[2] - bounds.min[2]) / 2, 0.001),
  ];

  return [
    center[0], center[1], center[2],
    half[0], 0, 0,
    0, half[1], 0,
    0, 0, half[2],
  ];
}

function groupCenter(group) {
  const sum = [0, 0, 0];
  for (const info of group) {
    sum[0] += info.center[0];
    sum[1] += info.center[1];
    sum[2] += info.center[2];
  }
  return [sum[0] / group.length, sum[1] / group.length, sum[2] / group.length];
}

function distanceSquared(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function countTiles(tile) {
  if (!tile) return 0;
  return 1 + (tile.children ?? []).reduce((sum, child) => sum + countTiles(child), 0);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
