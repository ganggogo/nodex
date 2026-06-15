#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const positional = args.filter((arg) => !arg.startsWith("-"));
  const inputTileset = path.resolve(positional[0] ?? "static/models/横琴示范区_retiled_dedup.json");
  const ratio = readNumberOption(args, "--ratio", 0.5);
  const outputTileset = path.resolve(positional[1] ?? makeDefaultOutput(inputTileset, ratio));

  if (ratio <= 0 || ratio >= 1) throw new Error("--ratio must be greater than 0 and less than 1.");

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
    images: 0,
    originalBytes: 0,
    outputBytes: 0,
    originalImageBytes: 0,
    outputImageBytes: 0,
  };

  for (const job of jobs) {
    const result = await scaleB3dmTextures(job.sourcePath, job.outputPath, ratio);
    totals.files += 1;
    totals.images += result.images;
    totals.originalBytes += result.originalBytes;
    totals.outputBytes += result.outputBytes;
    totals.originalImageBytes += result.originalImageBytes;
    totals.outputImageBytes += result.outputImageBytes;
  }

  await fsp.mkdir(path.dirname(outputTileset), { recursive: true });
  await fsp.writeFile(outputTileset, `${JSON.stringify(tileset, null, 2)}\n`);

  console.log(`Ratio: ${ratio}`);
  console.log(`Processed b3dm files: ${totals.files}`);
  console.log(`Scaled images: ${totals.images}`);
  console.log(`Image bytes: ${formatBytes(totals.originalImageBytes)} -> ${formatBytes(totals.outputImageBytes)}`);
  console.log(`B3dm size: ${formatBytes(totals.originalBytes)} -> ${formatBytes(totals.outputBytes)}`);
  console.log(`Output tileset: ${outputTileset}`);
}

function printUsage() {
  console.log(`Usage:
  node optimize3dtiles/createTextureScaleTileset.js [inputTileset.json] [outputTileset.json] [options]

Options:
  --ratio <n>  Texture scale ratio. Default: 0.5

This script rewrites embedded PNG images in b3dm GLB bufferViews. It does not
change geometry, indices, batch tables, feature ids, transforms, or tile tree.`);
}

function makeDefaultOutput(inputTileset, ratio) {
  const ext = path.extname(inputTileset);
  const base = path.basename(inputTileset, ext);
  const suffix = `tex${Math.round(ratio * 100)}`;
  return path.join(path.dirname(inputTileset), `${base}_${suffix}${ext}`);
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

async function scaleB3dmTextures(inputPath, outputPath, ratio) {
  const b3dm = await fsp.readFile(inputPath);
  const parsed = parseB3dm(b3dm);
  const scaled = scaleGlbTextures(parsed.glb, ratio);
  const output = Buffer.concat([parsed.prefix, scaled.buffer]);

  output.writeUInt32LE(output.length, 8);
  await fsp.writeFile(outputPath, output);

  return {
    originalBytes: b3dm.length,
    outputBytes: output.length,
    images: scaled.images,
    originalImageBytes: scaled.originalImageBytes,
    outputImageBytes: scaled.outputImageBytes,
  };
}

function parseB3dm(buffer) {
  if (buffer.toString("utf8", 0, 4) !== "b3dm") throw new Error("Invalid b3dm magic.");
  const featureJsonLength = buffer.readUInt32LE(12);
  const featureBinLength = buffer.readUInt32LE(16);
  const batchJsonLength = buffer.readUInt32LE(20);
  const batchBinLength = buffer.readUInt32LE(24);
  let glbOffset = 28 + featureJsonLength + featureBinLength + batchJsonLength + batchBinLength;
  if (buffer.toString("utf8", glbOffset, glbOffset + 4) !== "glTF") {
    glbOffset = buffer.indexOf(Buffer.from("glTF"), 20);
  }
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

function scaleGlbTextures(sourceGlb, ratio) {
  const { gltf, bin } = parseGlb(sourceGlb);
  const nextGltf = structuredClone(gltf);
  const replacements = new Map();
  const usedImageViews = new Set();
  let originalImageBytes = 0;
  let outputImageBytes = 0;
  let images = 0;

  for (const image of nextGltf.images ?? []) {
    if (image.bufferView === undefined) continue;
    if (image.mimeType !== "image/png") continue;
    const view = gltf.bufferViews[image.bufferView];
    const source = Buffer.from(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
    const scaled = scalePngRgb(source, ratio);
    replacements.set(image.bufferView, scaled);
    usedImageViews.add(image.bufferView);
    originalImageBytes += source.length;
    outputImageBytes += scaled.length;
    images += 1;
  }

  return {
    buffer: rebuildGlbWithBufferViewReplacements(nextGltf, bin, replacements),
    images,
    originalImageBytes,
    outputImageBytes,
  };
}

function rebuildGlbWithBufferViewReplacements(gltf, sourceBin, replacements) {
  const chunks = [];
  let binOffset = 0;

  for (let viewIndex = 0; viewIndex < (gltf.bufferViews?.length ?? 0); viewIndex += 1) {
    const view = gltf.bufferViews[viewIndex];
    const source = replacements.get(viewIndex)
      ?? Buffer.from(sourceBin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));

    binOffset = align4(binOffset);
    chunks.push({ offset: binOffset, buffer: source });
    view.byteOffset = binOffset;
    view.byteLength = source.length;
    binOffset += source.length;
  }

  const bin = Buffer.alloc(align4(binOffset));
  for (const chunk of chunks) chunk.buffer.copy(bin, chunk.offset);
  gltf.buffers ??= [{}];
  gltf.buffers[0].byteLength = bin.length;
  return buildGlb(gltf, bin);
}

function scalePngRgb(buffer, ratio) {
  const png = decodePngRgb(buffer);
  const nextWidth = Math.max(1, Math.floor(png.width * ratio));
  const nextHeight = Math.max(1, Math.floor(png.height * ratio));
  const nextData = Buffer.alloc(nextWidth * nextHeight * 3);

  for (let y = 0; y < nextHeight; y += 1) {
    for (let x = 0; x < nextWidth; x += 1) {
      const x0 = Math.floor((x * png.width) / nextWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * png.width) / nextWidth));
      const y0 = Math.floor((y * png.height) / nextHeight);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * png.height) / nextHeight));
      const sum = [0, 0, 0];
      let count = 0;

      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const sourceOffset = (sy * png.width + sx) * 3;
          sum[0] += png.data[sourceOffset];
          sum[1] += png.data[sourceOffset + 1];
          sum[2] += png.data[sourceOffset + 2];
          count += 1;
        }
      }

      const targetOffset = (y * nextWidth + x) * 3;
      nextData[targetOffset] = Math.round(sum[0] / count);
      nextData[targetOffset + 1] = Math.round(sum[1] / count);
      nextData[targetOffset + 2] = Math.round(sum[2] / count);
    }
  }

  return encodePngRgb(nextWidth, nextHeight, nextData);
}

function decodePngRgb(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Invalid PNG signature.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (bitDepth !== 8 || colorType !== 2 || interlace !== 0) {
    throw new Error(`Unsupported PNG layout: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rowLength = width * 3;
  const data = Buffer.alloc(width * height * 3);
  let rawOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const row = Buffer.from(raw.subarray(rawOffset, rawOffset + rowLength));
    rawOffset += rowLength;
    const prevRow = y > 0 ? data.subarray((y - 1) * rowLength, y * rowLength) : null;
    unfilterRow(row, prevRow, filter, 3);
    row.copy(data, y * rowLength);
  }

  return { width, height, data };
}

function unfilterRow(row, prevRow, filter, bytesPerPixel) {
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
    const up = prevRow ? prevRow[i] : 0;
    const upLeft = prevRow && i >= bytesPerPixel ? prevRow[i - bytesPerPixel] : 0;
    let value = row[i];

    if (filter === 1) value += left;
    else if (filter === 2) value += up;
    else if (filter === 3) value += Math.floor((left + up) / 2);
    else if (filter === 4) value += paeth(left, up, upLeft);
    else if (filter !== 0) throw new Error(`Unsupported PNG filter: ${filter}`);

    row[i] = value & 0xff;
  }
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function encodePngRgb(width, height, data) {
  const rowLength = width * 3;
  const raw = Buffer.alloc((rowLength + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (rowLength + 1);
    raw[rowStart] = 0;
    data.copy(raw, rowStart + 1, y * rowLength, (y + 1) * rowLength);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", zlib.deflateSync(raw)),
    makePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function makePngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return output;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildGlb(gltf, bin) {
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
