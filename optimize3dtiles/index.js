#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;

function printUsage() {
  console.log(`Usage:
  node optimize3dtiles/index.js [inputTileset.json] [outputTileset.json] [options]

Options:
  --keep-uint32-indices  Keep original uint32 index buffers for analysis tools
                         that assume UNSIGNED_INT indices.

Default:
  input:  static/models/横琴示范区.json
  output: static/models/横琴示范区_optimized.json

This optimizer is lossless for model attributes. It keeps vertex attributes and
batch data, and only rewrites eligible uint32 index buffers to uint16.`);
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
    keepUint32Indices: args.includes("--keep-uint32-indices"),
  };
  const inputDir = path.dirname(inputTileset);
  const outputDir = path.dirname(outputTileset);
  const outputModelName = path.basename(outputTileset, path.extname(outputTileset));
  const outputContentDir = path.join(outputDir, outputModelName);

  const tileset = JSON.parse(await fsp.readFile(inputTileset, "utf8"));
  const fileIndex = await buildFileIndex(inputDir);
  const jobs = [];
  collectContentJobs(tileset.root, inputDir, fileIndex, outputContentDir, outputModelName, jobs);

  if (jobs.length === 0) {
    throw new Error(`No b3dm content found in ${inputTileset}`);
  }

  await fsp.mkdir(outputContentDir, { recursive: true });

  const totals = {
    files: 0,
    originalBytes: 0,
    optimizedBytes: 0,
    convertedAccessors: 0,
    savedIndexBytes: 0,
    skippedAccessors: 0,
  };

  for (const job of jobs) {
    const result = await optimizeB3dmFile(job.sourcePath, job.outputPath, options);
    totals.files += 1;
    totals.originalBytes += result.originalBytes;
    totals.optimizedBytes += result.optimizedBytes;
    totals.convertedAccessors += result.convertedAccessors;
    totals.savedIndexBytes += result.savedIndexBytes;
    totals.skippedAccessors += result.skippedAccessors;
  }

  await fsp.mkdir(path.dirname(outputTileset), { recursive: true });
  await fsp.writeFile(outputTileset, `${JSON.stringify(tileset, null, 2)}\n`);

  console.log(`Optimized ${totals.files} b3dm tile(s).`);
  console.log(`Index accessors converted: ${totals.convertedAccessors}`);
  console.log(`Index accessors skipped: ${totals.skippedAccessors}`);
  console.log(`Original size: ${formatBytes(totals.originalBytes)}`);
  console.log(`Optimized size: ${formatBytes(totals.optimizedBytes)}`);
  console.log(`Saved: ${formatBytes(totals.originalBytes - totals.optimizedBytes)}`);
  console.log(`Output tileset: ${outputTileset}`);
}

function makeDefaultOutput(inputTileset) {
  const ext = path.extname(inputTileset);
  const base = path.basename(inputTileset, ext);
  return path.join(path.dirname(inputTileset), `${base}_optimized${ext}`);
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

async function optimizeB3dmFile(inputPath, outputPath, options) {
  const b3dm = await fsp.readFile(inputPath);
  const parsed = parseB3dm(b3dm);
  const optimizedGlb = optimizeGlb(parsed.glb, options);
  const output = Buffer.concat([
    parsed.prefix,
    optimizedGlb.buffer,
  ]);

  output.writeUInt32LE(output.length, 8);
  await fsp.writeFile(outputPath, output);

  return {
    originalBytes: b3dm.length,
    optimizedBytes: output.length,
    convertedAccessors: optimizedGlb.convertedAccessors,
    savedIndexBytes: optimizedGlb.savedIndexBytes,
    skippedAccessors: optimizedGlb.skippedAccessors,
  };
}

function parseB3dm(buffer) {
  if (buffer.toString("utf8", 0, 4) !== "b3dm") {
    throw new Error("Invalid b3dm magic.");
  }

  const version = buffer.readUInt32LE(4);
  if (version !== 1) {
    throw new Error(`Unsupported b3dm version: ${version}`);
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

function optimizeGlb(glb, options) {
  const parsed = parseGlb(glb);
  if (options.keepUint32Indices) {
    return {
      buffer: Buffer.from(glb),
      convertedAccessors: 0,
      savedIndexBytes: 0,
      skippedAccessors: 0,
    };
  }

  const usage = countBufferViewAccessorUsage(parsed.gltf);
  const conversions = new Map();
  let skippedAccessors = 0;
  let savedIndexBytes = 0;

  for (let accessorIndex = 0; accessorIndex < (parsed.gltf.accessors?.length ?? 0); accessorIndex += 1) {
    const accessor = parsed.gltf.accessors[accessorIndex];
    if (!canConvertIndexAccessor(parsed.gltf, accessor, usage)) continue;

    const source = readIndexAccessor(parsed.gltf, parsed.bin, accessor);
    const max = source.reduce((highest, value) => Math.max(highest, value), 0);
    if (max > 65535) {
      skippedAccessors += 1;
      continue;
    }

    const converted = Buffer.allocUnsafe(source.length * 2);
    for (let i = 0; i < source.length; i += 1) {
      converted.writeUInt16LE(source[i], i * 2);
    }

    conversions.set(accessor.bufferView, { accessorIndex, buffer: converted });
    savedIndexBytes += source.length * 2;
  }

  const rebuilt = rebuildGlb(parsed.gltf, parsed.bin, conversions);

  return {
    buffer: rebuilt,
    convertedAccessors: conversions.size,
    skippedAccessors,
    savedIndexBytes,
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

function countBufferViewAccessorUsage(gltf) {
  const usage = new Map();
  for (const accessor of gltf.accessors ?? []) {
    usage.set(accessor.bufferView, (usage.get(accessor.bufferView) ?? 0) + 1);
  }
  return usage;
}

function canConvertIndexAccessor(gltf, accessor, usage) {
  if (!accessor || accessor.componentType !== 5125 || accessor.type !== "SCALAR") return false;
  if (accessor.bufferView === undefined) return false;
  if ((usage.get(accessor.bufferView) ?? 0) !== 1) return false;

  const view = gltf.bufferViews?.[accessor.bufferView];
  if (!view) return false;
  if (view.byteStride !== undefined) return false;
  if ((accessor.byteOffset ?? 0) !== 0) return false;
  if (view.target !== undefined && view.target !== 34963) return false;

  return true;
}

function readIndexAccessor(gltf, bin, accessor) {
  const view = gltf.bufferViews[accessor.bufferView];
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const values = new Array(accessor.count);

  for (let i = 0; i < accessor.count; i += 1) {
    values[i] = bin.readUInt32LE(offset + i * 4);
  }

  return values;
}

function rebuildGlb(gltf, sourceBin, conversions) {
  const nextGltf = structuredClone(gltf);
  const chunks = [];
  let binOffset = 0;

  for (let viewIndex = 0; viewIndex < (nextGltf.bufferViews?.length ?? 0); viewIndex += 1) {
    const view = nextGltf.bufferViews[viewIndex];
    const conversion = conversions.get(viewIndex);
    const source = conversion
      ? conversion.buffer
      : sourceBin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);

    binOffset = align4(binOffset);
    chunks.push({ offset: binOffset, buffer: source });
    view.byteOffset = binOffset;
    view.byteLength = source.length;

    if (conversion) {
      nextGltf.accessors[conversion.accessorIndex].componentType = 5123;
    }

    binOffset += source.length;
  }

  const binLength = align4(binOffset);
  const bin = Buffer.alloc(binLength);
  for (const chunk of chunks) {
    chunk.buffer.copy(bin, chunk.offset);
  }

  nextGltf.buffers ??= [{}];
  nextGltf.buffers[0].byteLength = bin.length;

  const jsonBuffer = padJson(Buffer.from(JSON.stringify(nextGltf), "utf8"));
  const binBuffer = padBin(bin);
  const totalLength = 12 + 8 + jsonBuffer.length + 8 + binBuffer.length;
  const glb = Buffer.allocUnsafe(totalLength);

  glb.write("glTF", 0, 4, "utf8");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(totalLength, 8);
  glb.writeUInt32LE(jsonBuffer.length, 12);
  glb.writeUInt32LE(GLB_JSON, 16);
  jsonBuffer.copy(glb, 20);
  const binHeader = 20 + jsonBuffer.length;
  glb.writeUInt32LE(binBuffer.length, binHeader);
  glb.writeUInt32LE(GLB_BIN, binHeader + 4);
  binBuffer.copy(glb, binHeader + 8);

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
