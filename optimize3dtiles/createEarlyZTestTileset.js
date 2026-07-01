#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;

function printUsage() {
  console.log(`Usage:
  node optimize3dtiles/createEarlyZTestTileset.js [inputTileset.json] [outputTileset.json] [options]

Options:
  --keep-double-sided  Keep material.doubleSided values. Default forces false.
  --keep-textures      Keep texture references. Default removes texture maps.
  --unlit              Add KHR_materials_unlit after material rewrite.
  --color <r,g,b,a>    Base color in 0..1 range. Default: 0.72,0.68,0.55,1

This is a diagnosis/preview script for fill-rate and Early-Z bottlenecks. It
forces opaque materials by removing BLEND/MASK alpha state, alpha cutoff,
discard-prone alpha textures, and double-sided rendering by default. It does
not change geometry, indices, batch tables, transforms, or tileset structure.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const positional = args.filter((arg) => !arg.startsWith("-"));
  const inputTileset = path.resolve(positional[0] ?? "static/models/横琴示范区_retiled_dedup_tex25_shell.json");
  const outputTileset = path.resolve(positional[1] ?? makeDefaultOutput(inputTileset));
  const options = {
    keepDoubleSided: args.includes("--keep-double-sided"),
    keepTextures: args.includes("--keep-textures"),
    unlit: args.includes("--unlit"),
    color: readColorOption(args, "--color", [0.72, 0.68, 0.55, 1]),
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
    materialsChanged: 0,
    alphaModesRemoved: 0,
    doubleSidedDisabled: 0,
    textureSlotsRemoved: 0,
  };

  for (const [index, job] of jobs.entries()) {
    const result = await rewriteB3dm(job.sourcePath, job.outputPath, options);
    for (const key of Object.keys(totals)) totals[key] += result[key] ?? 0;
    console.log(`[${index + 1}/${jobs.length}] ${path.basename(job.sourcePath)} materials ${result.materialsChanged}, texture slots removed ${result.textureSlotsRemoved}`);
  }

  await fsp.mkdir(path.dirname(outputTileset), { recursive: true });
  await fsp.writeFile(outputTileset, `${JSON.stringify(tileset, null, 2)}\n`);

  console.log(`Keep double sided: ${options.keepDoubleSided}`);
  console.log(`Keep textures: ${options.keepTextures}`);
  console.log(`Unlit: ${options.unlit}`);
  console.log(`Processed b3dm files: ${totals.files}`);
  console.log(`Materials changed: ${totals.materialsChanged}`);
  console.log(`Alpha modes removed: ${totals.alphaModesRemoved}`);
  console.log(`Double sided disabled: ${totals.doubleSidedDisabled}`);
  console.log(`Texture slots removed: ${totals.textureSlotsRemoved}`);
  console.log(`B3dm size: ${formatBytes(totals.originalBytes)} -> ${formatBytes(totals.outputBytes)}`);
  console.log(`Output tileset: ${outputTileset}`);
}

function makeDefaultOutput(inputTileset) {
  const ext = path.extname(inputTileset);
  const base = path.basename(inputTileset, ext);
  return path.join(path.dirname(inputTileset), `${base}_earlyz${ext}`);
}

function readStringOption(args, name, fallback = undefined) {
  const equal = args.find((arg) => arg.startsWith(`${name}=`));
  if (equal) return equal.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return fallback;
}

function readColorOption(args, name, fallback) {
  const raw = readStringOption(args, name);
  if (!raw) return fallback;
  const values = raw.split(",").map((item) => Number(item.trim()));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${name} must be four comma separated numbers.`);
  }
  return values;
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

async function rewriteB3dm(inputPath, outputPath, options) {
  const b3dm = await fsp.readFile(inputPath);
  const parsed = parseB3dm(b3dm);
  const rewritten = rewriteGlb(parsed.glb, options);
  const output = Buffer.concat([parsed.prefix, rewritten.buffer]);
  output.writeUInt32LE(output.length, 8);
  await fsp.writeFile(outputPath, output);

  return {
    files: 1,
    originalBytes: b3dm.length,
    outputBytes: output.length,
    ...rewritten.stats,
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
    else if (chunkType === GLB_BIN) bin = Buffer.from(buffer.subarray(chunkStart, chunkEnd));
    offset = chunkEnd;
  }

  if (!gltf || !bin) throw new Error("GLB must contain JSON and BIN chunks.");
  return { gltf, bin };
}

function rewriteGlb(sourceGlb, options) {
  const { gltf, bin } = parseGlb(sourceGlb);
  const stats = {
    materialsChanged: 0,
    alphaModesRemoved: 0,
    doubleSidedDisabled: 0,
    textureSlotsRemoved: 0,
  };

  gltf.materials = (gltf.materials?.length ? gltf.materials : [{}]).map((material) => {
    const next = structuredClone(material);
    stats.materialsChanged += 1;

    if (next.alphaMode !== undefined) {
      delete next.alphaMode;
      stats.alphaModesRemoved += 1;
    }
    if (next.alphaCutoff !== undefined) delete next.alphaCutoff;

    if (!options.keepDoubleSided && next.doubleSided !== false) {
      next.doubleSided = false;
      stats.doubleSidedDisabled += 1;
    }

    next.pbrMetallicRoughness ??= {};
    next.pbrMetallicRoughness.baseColorFactor = options.color;
    next.pbrMetallicRoughness.metallicFactor = 0;
    next.pbrMetallicRoughness.roughnessFactor = 1;

    if (!options.keepTextures) {
      stats.textureSlotsRemoved += removeMaterialTextures(next);
    }

    if (options.unlit) {
      next.extensions ??= {};
      next.extensions.KHR_materials_unlit = {};
    }

    return next;
  });

  if (!options.keepTextures) removeGlobalTextureData(gltf);
  if (options.unlit) addExtensionUsed(gltf, "KHR_materials_unlit");

  return { buffer: buildGlb(gltf, bin), stats };
}

function removeMaterialTextures(material) {
  let removed = 0;
  for (const key of ["normalTexture", "occlusionTexture", "emissiveTexture"]) {
    if (material[key] !== undefined) {
      delete material[key];
      removed += 1;
    }
  }
  if (material.pbrMetallicRoughness) {
    for (const key of ["baseColorTexture", "metallicRoughnessTexture"]) {
      if (material.pbrMetallicRoughness[key] !== undefined) {
        delete material.pbrMetallicRoughness[key];
        removed += 1;
      }
    }
  }
  return removed;
}

function removeGlobalTextureData(gltf) {
  delete gltf.textures;
  delete gltf.images;
  delete gltf.samplers;
}

function addExtensionUsed(gltf, extensionName) {
  const used = new Set(gltf.extensionsUsed ?? []);
  used.add(extensionName);
  gltf.extensionsUsed = [...used];
}

function buildGlb(gltf, bin) {
  gltf.buffers ??= [{}];
  gltf.buffers[0].byteLength = bin.length;

  const jsonBuffer = padJson(Buffer.from(JSON.stringify(gltf), "utf8"));
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
