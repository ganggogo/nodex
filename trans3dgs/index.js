#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";

const IDENTITY = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

const COMPONENT_SIZE = new Map([
  [5120, 1],
  [5121, 1],
  [5122, 2],
  [5123, 2],
  [5125, 4],
  [5126, 4],
]);

const TYPE_SIZE = new Map([
  ["SCALAR", 1],
  ["VEC2", 2],
  ["VEC3", 3],
  ["VEC4", 4],
  ["MAT2", 4],
  ["MAT3", 9],
  ["MAT4", 16],
]);

const SH_C0 = 0.28209479177387814;
const RECORD_FLOATS = 17;
const RECORD_BYTES = RECORD_FLOATS * 4;

function printUsage() {
  console.log(`Usage:
  node trans3dgs/index.js [tileset.json] [output.ply] [options]

Options:
  --max-points <n>       Maximum splats to write. Default: 250000
  --all                  Disable max point decimation
  --splat-size <n>       Scale multiplier for triangle-sized splats. Default: 0.45
  --opacity <n>          Splat opacity in 0..1. Default: 0.85
  --seed <n>             Deterministic sampling seed. Default: 1
  --help                 Show this help

Default input:
  static/models/海南岛_1.json

Output format:
  Binary little-endian PLY compatible with common 3D Gaussian Splatting viewers.`);
}

function parseArgs(argv) {
  const args = [...argv];
  const positional = [];
  const options = {
    input: path.resolve("static/models/海南岛_1.json"),
    output: null,
    maxPoints: 250000,
    splatSize: 0.5,
    opacity: 0.85,
    seed: 1,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--all") {
      options.maxPoints = Infinity;
    } else if (arg === "--max-points") {
      options.maxPoints = parsePositiveNumber(args[++i], "--max-points");
    } else if (arg.startsWith("--max-points=")) {
      options.maxPoints = parsePositiveNumber(arg.slice("--max-points=".length), "--max-points");
    } else if (arg === "--splat-size") {
      options.splatSize = parsePositiveNumber(args[++i], "--splat-size");
    } else if (arg.startsWith("--splat-size=")) {
      options.splatSize = parsePositiveNumber(arg.slice("--splat-size=".length), "--splat-size");
    } else if (arg === "--opacity") {
      options.opacity = parseOpacity(args[++i]);
    } else if (arg.startsWith("--opacity=")) {
      options.opacity = parseOpacity(arg.slice("--opacity=".length));
    } else if (arg === "--seed") {
      options.seed = parseInteger(args[++i], "--seed");
    } else if (arg.startsWith("--seed=")) {
      options.seed = parseInteger(arg.slice("--seed=".length), "--seed");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional[0]) options.input = path.resolve(positional[0]);
  if (positional[1]) options.output = path.resolve(positional[1]);
  if (!options.output) {
    const base = path.basename(options.input, path.extname(options.input));
    options.output = path.resolve("trans3dgs", "output", `${base}.3dgs.ply`);
  }

  return options;
}

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

function parseOpacity(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    throw new Error("--opacity must be between 0 and 1.");
  }
  return parsed;
}

function parseInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer.`);
  }
  return parsed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const tileset = await readJson(options.input);
  const tilesetDir = path.dirname(options.input);
  const fileIndex = await buildFileIndex(tilesetDir);
  const jobs = [];

  collectTileJobs(tileset.root, tilesetDir, fileIndex, IDENTITY, jobs);
  if (jobs.length === 0) {
    throw new Error(`No b3dm content found in ${options.input}`);
  }

  const stats = await preScanJobs(jobs);
  const stride = Number.isFinite(options.maxPoints)
    ? Math.max(1, Math.ceil(stats.triangleCount / options.maxPoints))
    : 1;

  await fsp.mkdir(path.dirname(options.output), { recursive: true });
  const result = await convertJobsToPly(jobs, {
    ...options,
    source: options.input,
    stride,
    triangleCount: stats.triangleCount,
  });

  console.log(`Converted ${jobs.length} b3dm tile(s).`);
  console.log(`Triangles scanned: ${stats.triangleCount}`);
  console.log(`Splats written: ${result.pointCount}`);
  console.log(`Output: ${options.output}`);
}

async function readJson(filePath) {
  const text = await fsp.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function buildFileIndex(rootDir) {
  const index = new Map();

  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        return;
      }

      const key = entry.name.toLowerCase();
      const bucket = index.get(key);
      if (bucket) bucket.push(fullPath);
      else index.set(key, [fullPath]);
    }));
  }

  await walk(rootDir);
  return index;
}

function collectTileJobs(tile, baseDir, fileIndex, parentTransform, jobs) {
  if (!tile) return;

  const tileTransform = tile.transform
    ? multiplyMat4(parentTransform, tile.transform)
    : parentTransform;

  const content = tile.content;
  const uri = content?.uri ?? content?.url;
  if (uri && isSupportedContent(uri)) {
    const contentPath = resolveContentPath(uri, baseDir, fileIndex);
    jobs.push({
      path: contentPath,
      transform: tileTransform,
    });
  }

  for (const child of tile.children ?? []) {
    collectTileJobs(child, baseDir, fileIndex, tileTransform, jobs);
  }
}

function isSupportedContent(uri) {
  const clean = stripUriQuery(uri).toLowerCase();
  return clean.endsWith(".b3dm") || clean.endsWith(".glb") || clean.endsWith(".gltf");
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
    const suffixMatch = matches.find((item) => item.toLowerCase().endsWith(normalized));
    if (suffixMatch) return suffixMatch;
    return matches[0];
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

async function preScanJobs(jobs) {
  let triangleCount = 0;

  for (const job of jobs) {
    const parsed = await readTileModel(job.path);
    const gltf = parsed.gltf;

    for (const mesh of gltf.meshes ?? []) {
      for (const primitive of mesh.primitives ?? []) {
        if ((primitive.mode ?? 4) !== 4) continue;

        const positionAccessor = gltf.accessors?.[primitive.attributes?.POSITION];
        if (!positionAccessor) continue;

        if (primitive.indices !== undefined) {
          const indexAccessor = gltf.accessors?.[primitive.indices];
          triangleCount += Math.floor((indexAccessor?.count ?? 0) / 3);
        } else {
          triangleCount += Math.floor(positionAccessor.count / 3);
        }
      }
    }
  }

  return { triangleCount };
}

async function convertJobsToPly(jobs, options) {
  const tmpBody = path.join(
    path.dirname(options.output),
    `.${path.basename(options.output)}.${Date.now()}.${process.pid}.body`,
  );
  const bodyStream = fs.createWriteStream(tmpBody);
  const writer = new SplatWriter(bodyStream);
  const opacity = logit(options.opacity);

  let pointCount = 0;
  let triangleCursor = 0;

  try {
    for (const job of jobs) {
      const parsed = await readTileModel(job.path);
      const rootTransform = parsed.rtcCenter
        ? multiplyMat4(job.transform, translationMat4(parsed.rtcCenter))
        : job.transform;

      const sceneIndex = parsed.gltf.scene ?? 0;
      const scene = parsed.gltf.scenes?.[sceneIndex] ?? parsed.gltf.scenes?.[0];
      const sceneNodes = scene?.nodes ?? parsed.gltf.nodes?.map((_, index) => index) ?? [];

      for (const nodeIndex of sceneNodes) {
        await convertNode(parsed, nodeIndex, rootTransform, options, opacity, writer, {
          get triangleCursor() { return triangleCursor; },
          set triangleCursor(value) { triangleCursor = value; },
          get pointCount() { return pointCount; },
          set pointCount(value) { pointCount = value; },
        });
      }
    }
  } finally {
    bodyStream.end();
    await once(bodyStream, "finish");
  }

  const header = makePlyHeader(pointCount, options);
  const headerStream = fs.createReadStream(tmpBody);
  const out = fs.createWriteStream(options.output);
  out.write(header);
  await pipeline(headerStream, out, { end: true });
  await fsp.unlink(tmpBody).catch(() => {});

  return { pointCount };
}

async function convertNode(parsed, nodeIndex, parentTransform, options, opacity, writer, counters) {
  const gltf = parsed.gltf;
  const node = gltf.nodes?.[nodeIndex];
  if (!node) return;

  const local = nodeToMat4(node);
  const nodeTransform = multiplyMat4(parentTransform, local);

  if (node.mesh !== undefined) {
    await convertMesh(parsed, gltf.meshes?.[node.mesh], nodeTransform, options, opacity, writer, counters);
  }

  for (const childIndex of node.children ?? []) {
    await convertNode(parsed, childIndex, nodeTransform, options, opacity, writer, counters);
  }
}

async function convertMesh(parsed, mesh, transform, options, opacity, writer, counters) {
  if (!mesh) return;

  for (const primitive of mesh.primitives ?? []) {
    if (counters.pointCount >= options.maxPoints) return;
    if ((primitive.mode ?? 4) !== 4) continue;
    if (primitive.attributes?.POSITION === undefined) continue;

    const positions = makeAccessorReader(parsed, primitive.attributes.POSITION);
    const colorReader = primitive.attributes.COLOR_0 !== undefined
      ? makeColorReader(parsed, primitive.attributes.COLOR_0)
      : null;
    const indices = primitive.indices !== undefined
      ? makeScalarReader(parsed, primitive.indices)
      : null;
    const triangleCount = indices
      ? Math.floor(indices.count / 3)
      : Math.floor(positions.count / 3);
    const materialColor = getPrimitiveColor(parsed.gltf, primitive);

    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const globalTriangle = counters.triangleCursor;
      counters.triangleCursor = globalTriangle + 1;
      if (globalTriangle % options.stride !== 0) continue;

      const i0 = indices ? indices.get(triangle * 3) : triangle * 3;
      const i1 = indices ? indices.get(triangle * 3 + 1) : triangle * 3 + 1;
      const i2 = indices ? indices.get(triangle * 3 + 2) : triangle * 3 + 2;
      const color = colorReader
        ? averageColor(colorReader.get(i0), colorReader.get(i1), colorReader.get(i2))
        : materialColor;

      const p0 = transformPoint(transform, positions.get(i0));
      const p1 = transformPoint(transform, positions.get(i1));
      const p2 = transformPoint(transform, positions.get(i2));

      const edgeA = sub3(p1, p0);
      const edgeB = sub3(p2, p0);
      const cross = cross3(edgeA, edgeB);
      const crossLen = length3(cross);
      if (crossLen <= 1e-12) continue;

      const area = crossLen * 0.5;

      const normal =
        mul3(cross, 1 / crossLen);

      const quat =
        normalToQuaternion(
          normal
        );

      const density = 0.08;

      const splatCount =
        Math.max(
          1,
          Math.min(
            20,
            Math.ceil(
              area * density
            )
          )
        );

      for (
        let s = 0;
        s < splatCount;
        s++
      ) {
        if (counters.pointCount >= options.maxPoints) return;

        const center =
          randomPointInTriangle(
            p0,
            p1,
            p2,
            options.seed,
            globalTriangle,
            s
          );

        const scale =
          triangleScale(
            edgeA,
            edgeB,
            options.splatSize
          );

        await writer.write(
          center,
          normal,
          color,
          opacity,
          scale,
          quat
        );

        counters.pointCount++;
      }
    }
  }
}

async function readTileModel(filePath) {
  const buffer = await fsp.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".b3dm") return parseB3dm(buffer);
  if (ext === ".glb") return parseGlb(buffer);
  if (ext === ".gltf") {
    const gltf = JSON.parse(buffer.toString("utf8"));
    throw new Error(`External .gltf buffers are not supported yet: ${filePath}`);
  }

  throw new Error(`Unsupported content type: ${filePath}`);
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
  const featureJsonStart = 28;
  const featureJsonEnd = featureJsonStart + featureJsonLength;
  const featureTable = parseJsonChunk(buffer, featureJsonStart, featureJsonEnd);
  let glbOffset = featureJsonEnd + featureBinLength + batchJsonLength + batchBinLength;

  if (buffer.toString("utf8", glbOffset, glbOffset + 4) !== "glTF") {
    glbOffset = buffer.indexOf(Buffer.from("glTF"), 20);
  }
  if (glbOffset < 0) {
    throw new Error("Could not locate embedded GLB in b3dm.");
  }

  const model = parseGlb(buffer.subarray(glbOffset));
  model.rtcCenter = Array.isArray(featureTable.RTC_CENTER) ? featureTable.RTC_CENTER : null;
  return model;
}

function parseJsonChunk(buffer, start, end) {
  if (end <= start) return {};
  const text = buffer.toString("utf8", start, end).trim();
  if (!text) return {};
  return JSON.parse(text);
}

function parseGlb(buffer) {
  if (buffer.toString("utf8", 0, 4) !== "glTF") {
    throw new Error("Invalid GLB magic.");
  }

  const version = buffer.readUInt32LE(4);
  if (version !== 2) {
    throw new Error(`Only GLB v2 is supported. Found v${version}.`);
  }

  const length = buffer.readUInt32LE(8);
  let offset = 12;
  let gltf = null;
  let binary = null;

  while (offset + 8 <= length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.toString("utf8", offset + 4, offset + 8);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;

    if (chunkType === "JSON") {
      gltf = JSON.parse(buffer.toString("utf8", chunkStart, chunkEnd).trim());
    } else if (chunkType === "BIN\0") {
      binary = buffer.subarray(chunkStart, chunkEnd);
    }

    offset = chunkEnd;
  }

  if (!gltf || !binary) {
    throw new Error("GLB must contain JSON and BIN chunks.");
  }

  return { gltf, binary, rtcCenter: null };
}

function makeAccessorReader(parsed, accessorIndex) {
  const accessor = parsed.gltf.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`Missing accessor ${accessorIndex}`);

  const componentCount = TYPE_SIZE.get(accessor.type);
  if (!componentCount) throw new Error(`Unsupported accessor type: ${accessor.type}`);

  const scalar = makeScalarReader(parsed, accessorIndex);
  return {
    count: accessor.count,
    componentCount,
    get(index) {
      const out = new Array(componentCount);
      for (let component = 0; component < componentCount; component += 1) {
        out[component] = scalar.getComponent(index, component);
      }
      return out;
    },
  };
}

function makeScalarReader(parsed, accessorIndex) {
  const gltf = parsed.gltf;
  const accessor = gltf.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`Missing accessor ${accessorIndex}`);

  const view = gltf.bufferViews?.[accessor.bufferView];
  if (!view) throw new Error(`Accessor ${accessorIndex} is missing bufferView data.`);

  const componentSize = COMPONENT_SIZE.get(accessor.componentType);
  const componentCount = TYPE_SIZE.get(accessor.type);
  if (!componentSize || !componentCount) {
    throw new Error(`Unsupported accessor layout: ${accessor.componentType} ${accessor.type}`);
  }

  const baseOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? componentSize * componentCount;

  return {
    count: accessor.count,
    componentType: accessor.componentType,
    normalized: Boolean(accessor.normalized),
    get(index) {
      return readComponent(parsed.binary, baseOffset + index * stride, accessor.componentType);
    },
    getComponent(index, component) {
      const value = readComponent(
        parsed.binary,
        baseOffset + index * stride + component * componentSize,
        accessor.componentType,
      );
      return normalizeComponent(value, accessor.componentType, Boolean(accessor.normalized));
    },
  };
}

function makeColorReader(parsed, accessorIndex) {
  const reader = makeAccessorReader(parsed, accessorIndex);
  return {
    get(index) {
      const value = reader.get(index);
      return [
        clampByte(value[0] * 255),
        clampByte(value[1] * 255),
        clampByte(value[2] * 255),
        value[3] === undefined ? 255 : clampByte(value[3] * 255),
      ];
    },
  };
}

function readComponent(buffer, offset, componentType) {
  switch (componentType) {
    case 5120: return buffer.readInt8(offset);
    case 5121: return buffer.readUInt8(offset);
    case 5122: return buffer.readInt16LE(offset);
    case 5123: return buffer.readUInt16LE(offset);
    case 5125: return buffer.readUInt32LE(offset);
    case 5126: return buffer.readFloatLE(offset);
    default: throw new Error(`Unsupported component type: ${componentType}`);
  }
}

function normalizeComponent(value, componentType, normalized) {
  if (!normalized || componentType === 5126) return value;

  switch (componentType) {
    case 5120: return Math.max(value / 127, -1);
    case 5121: return value / 255;
    case 5122: return Math.max(value / 32767, -1);
    case 5123: return value / 65535;
    case 5125: return value / 4294967295;
    default: return value;
  }
}

function getPrimitiveColor(gltf, primitive) {
  const material = gltf.materials?.[primitive.material];
  const pbr = material?.pbrMetallicRoughness;

  if (pbr?.baseColorFactor) {
    const [r, g, b, a = 1] = pbr.baseColorFactor;
    return [clampByte(r * 255), clampByte(g * 255), clampByte(b * 255), clampByte(a * 255)];
  }

  const textureIndex = pbr?.baseColorTexture?.index;
  const texture = gltf.textures?.[textureIndex];
  const image = gltf.images?.[texture?.source];
  const nameColor = parseColorFromName(image?.name);
  if (nameColor) return nameColor;

  return [220, 220, 220, 255];
}

function parseColorFromName(name) {
  if (!name) return null;
  const match = /_(\d{1,3})_(\d{1,3})_(\d{1,3})(?:_(\d{1,3}))?$/.exec(name);
  if (!match) return null;
  return [
    clampByte(Number(match[1])),
    clampByte(Number(match[2])),
    clampByte(Number(match[3])),
    match[4] === undefined ? 255 : clampByte(Number(match[4])),
  ];
}

function averageColor(a, b, c) {
  return [
    clampByte((a[0] + b[0] + c[0]) / 3),
    clampByte((a[1] + b[1] + c[1]) / 3),
    clampByte((a[2] + b[2] + c[2]) / 3),
    clampByte((a[3] + b[3] + c[3]) / 3),
  ];
}

function triangleScale(edgeA, edgeB, multiplier) {

  const a = length3(edgeA);

  const b = length3(edgeB);

  const c = length3(
    sub3(edgeA, edgeB)
  );

  const radiusA =
    Math.max(
      a * multiplier,
      1e-4
    );

  const radiusB =
    Math.max(
      b * multiplier,
      1e-4
    );

  const radiusC =
    Math.max(
      c * 0.05,
      1e-4
    );

  return [

    Math.log(radiusA),

    Math.log(radiusB),

    Math.log(radiusC)
  ];
}

class SplatWriter {
  constructor(stream) {
    this.stream = stream;
  }

  async write(
  position,
  normal,
  color,
  opacity,
  scale,
  quat
) {
    const buffer = Buffer.allocUnsafe(RECORD_BYTES);
    const sh = [
      (color[0] / 255 - 0.5) / SH_C0,
      (color[1] / 255 - 0.5) / SH_C0,
      (color[2] / 255 - 0.5) / SH_C0,
    ];
    const values = [
      position[0], position[1], position[2],
      normal[0], normal[1], normal[2],
      sh[0], sh[1], sh[2],
      opacity,
      scale[0], scale[1], scale[2],
      quat[0],
      quat[1],
      quat[2],
      quat[3]
    ];

    for (let i = 0; i < values.length; i += 1) {
      buffer.writeFloatLE(Number.isFinite(values[i]) ? values[i] : 0, i * 4);
    }

    if (!this.stream.write(buffer)) {
      await once(this.stream, "drain");
    }
  }
}

function makePlyHeader(pointCount, options) {
  return [
    "ply",
    "format binary_little_endian 1.0",
    "comment generated by trans3dgs/index.js",
    `comment source ${path.basename(options.source)}`,
    `comment source_triangles ${options.triangleCount}`,
    `comment triangle_stride ${options.stride}`,
    `element vertex ${pointCount}`,
    "property float x",
    "property float y",
    "property float z",
    "property float nx",
    "property float ny",
    "property float nz",
    "property float f_dc_0",
    "property float f_dc_1",
    "property float f_dc_2",
    "property float opacity",
    "property float scale_0",
    "property float scale_1",
    "property float scale_2",
    "property float rot_0",
    "property float rot_1",
    "property float rot_2",
    "property float rot_3",
    "end_header",
    "",
  ].join("\n");
}

function nodeToMat4(node) {
  if (node.matrix) return node.matrix;

  const translation = node.translation ?? [0, 0, 0];
  const rotation = node.rotation ?? [0, 0, 0, 1];
  const scale = node.scale ?? [1, 1, 1];
  return composeMat4(translation, rotation, scale);
}

function composeMat4(translation, rotation, scale) {
  const [x, y, z, w] = rotation;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const [sx, sy, sz] = scale;

  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    translation[0],
    translation[1],
    translation[2],
    1,
  ];
}

function translationMat4(translation) {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    translation[0], translation[1], translation[2], 1,
  ];
}

function multiplyMat4(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0]
        + a[1 * 4 + row] * b[col * 4 + 1]
        + a[2 * 4 + row] * b[col * 4 + 2]
        + a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function mul3(a, scalar) {
  return [a[0] * scalar, a[1] * scalar, a[2] * scalar];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function length3(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function normalize3(v) {

  const len = length3(v);

  if (len < 1e-12) {
    return [0, 0, 1];
  }

  return [
    v[0] / len,
    v[1] / len,
    v[2] / len,
  ];
}

function randomPointInTriangle(p0, p1, p2, seed, triangleIndex, splatIndex) {

  let r1 = hashRandom(seed, triangleIndex, splatIndex * 2);
  let r2 = hashRandom(seed, triangleIndex, splatIndex * 2 + 1);

  if (r1 + r2 > 1) {
    r1 = 1 - r1;
    r2 = 1 - r2;
  }

  return [

    p0[0]
      + (p1[0] - p0[0]) * r1
      + (p2[0] - p0[0]) * r2,

    p0[1]
      + (p1[1] - p0[1]) * r1
      + (p2[1] - p0[1]) * r2,

    p0[2]
      + (p1[2] - p0[2]) * r1
      + (p2[2] - p0[2]) * r2,
  ];
}

function hashRandom(seed, a, b) {
  let x =
    (seed
      ^ 0x9e3779b9
      ^ Math.imul(a + 1, 0x85ebca6b)
      ^ Math.imul(b + 1, 0xc2b2ae35)) >>> 0;

  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;

  return x / 0x100000000;
}

function normalToQuaternion(normal) {

  const z = normalize3(normal);

  let x = [1, 0, 0];

  if (Math.abs(z[0]) > 0.9) {
    x = [0, 1, 0];
  }

  let y = cross3(z, x);

  y = normalize3(y);

  x = cross3(y, z);

  const m00 = x[0];
  const m01 = y[0];
  const m02 = z[0];

  const m10 = x[1];
  const m11 = y[1];
  const m12 = z[1];

  const m20 = x[2];
  const m21 = y[2];
  const m22 = z[2];

  const trace = m00 + m11 + m22;

  let qw, qx, qy, qz;

  if (trace > 0) {

    const s = Math.sqrt(trace + 1) * 2;

    qw = 0.25 * s;
    qx = (m21 - m12) / s;
    qy = (m02 - m20) / s;
    qz = (m10 - m01) / s;

  } else if (m00 > m11 && m00 > m22) {

    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;

    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;

  } else if (m11 > m22) {

    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;

    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;

  } else {

    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;

    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }

  const len = Math.hypot(qw, qx, qy, qz);
  if (len < 1e-12) return [1, 0, 0, 0];

  return [
    qw / len,
    qx / len,
    qy / len,
    qz / len,
  ];
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function logit(value) {
  return Math.log(value / (1 - value));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
