#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";

const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;
const IDENTITY = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

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
  if (args.includes("--help") || args.includes("-h") || !args.length) {
    printUsage();
    return;
  }

  const options = {
    epsilon: readNumberOption(args, "--epsilon", 0.001),
    maxFaceKeys: readNumberOption(args, "--max-face-keys", 15000000),
    maxEdgeKeys: readNumberOption(args, "--max-edge-keys", 15000000),
  };
  const files = args.filter((arg) => !arg.startsWith("-"));

  const results = [];
  for (const file of files) {
    results.push(await analyzeTileset(path.resolve(file), options));
  }

  console.log(JSON.stringify(results, null, 2));
}

function printUsage() {
  console.log(`Usage:
  node optimize3dtiles/analyzeTriangleMeshStats.js <tileset.json...> [options]

Options:
  --epsilon <n>        Coordinate quantization tolerance. Default: 0.001
  --max-face-keys <n>  Max face keys to store for duplicate-face stats.
  --max-edge-keys <n>  Max edge keys to store for edge-sharing stats.`);
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

async function analyzeTileset(tilesetPath, options) {
  const baseDir = path.dirname(tilesetPath);
  const tileset = JSON.parse(await fsp.readFile(tilesetPath, "utf8"));
  const jobs = [];
  collectJobs(tileset.root, IDENTITY, jobs);

  const edgeLengths = [];
  const aspects = [];
  const areas = [];
  const faceCounts = new Map();
  const edgeCounts = new Map();
  const topFiles = [];
  const stats = {
    file: tilesetPath,
    b3dm: 0,
    primitives: 0,
    vertices: 0,
    triangles: 0,
    bytes: 0,
    degenerateTriangles: 0,
    longEdgeGt1000: 0,
    longEdgeGt5000: 0,
    aspectGt50: 0,
    aspectGt100: 0,
    maxEdge: 0,
    maxAspect: 0,
    bboxMin: [Infinity, Infinity, Infinity],
    bboxMax: [-Infinity, -Infinity, -Infinity],
    faceKeyLimitHit: false,
    edgeKeyLimitHit: false,
  };

  for (const job of jobs) {
    const b3dmPath = path.resolve(baseDir, safeDecodeUri(stripUriQuery(job.uri)).replaceAll("/", path.sep));
    const b3dm = await fsp.readFile(b3dmPath);
    const { gltf, bin } = parseGlb(parseB3dm(b3dm).glb);
    let fileTriangles = 0;
    let fileVertices = 0;
    let fileMaxEdge = 0;
    let fileAspectGt100 = 0;

    stats.b3dm += 1;
    stats.bytes += b3dm.length;

    for (const mesh of gltf.meshes ?? []) {
      for (const primitive of mesh.primitives ?? []) {
        if ((primitive.mode ?? 4) !== 4 || primitive.attributes?.POSITION === undefined) continue;

        stats.primitives += 1;
        const positionAccessor = gltf.accessors[primitive.attributes.POSITION];
        const indices = primitive.indices !== undefined
          ? readIndexArray(gltf, bin, gltf.accessors[primitive.indices])
          : makeSequentialIndices(positionAccessor.count);

        stats.vertices += positionAccessor.count;
        fileVertices += positionAccessor.count;

        for (let i = 0; i + 2 < indices.length; i += 3) {
          const a = transformPoint(job.transform, readPosition(gltf, bin, positionAccessor, indices[i]));
          const b = transformPoint(job.transform, readPosition(gltf, bin, positionAccessor, indices[i + 1]));
          const c = transformPoint(job.transform, readPosition(gltf, bin, positionAccessor, indices[i + 2]));
          updateBounds(stats, a, b, c);

          const e1 = distance(a, b);
          const e2 = distance(b, c);
          const e3 = distance(c, a);
          const maxEdge = Math.max(e1, e2, e3);
          const minEdge = Math.max(Math.min(e1, e2, e3), 1e-12);
          const aspect = maxEdge / minEdge;
          const triangleArea = area(a, b, c);

          stats.triangles += 1;
          fileTriangles += 1;
          stats.maxEdge = Math.max(stats.maxEdge, maxEdge);
          stats.maxAspect = Math.max(stats.maxAspect, aspect);
          fileMaxEdge = Math.max(fileMaxEdge, maxEdge);

          if (triangleArea < 1e-8) stats.degenerateTriangles += 1;
          if (maxEdge > 1000) stats.longEdgeGt1000 += 1;
          if (maxEdge > 5000) stats.longEdgeGt5000 += 1;
          if (aspect > 50) stats.aspectGt50 += 1;
          if (aspect > 100) {
            stats.aspectGt100 += 1;
            fileAspectGt100 += 1;
          }

          sample(edgeLengths, e1, e2, e3);
          sample(aspects, aspect);
          sample(areas, triangleArea);

          if (faceCounts.size < options.maxFaceKeys || faceCounts.has(faceKey(a, b, c, options.epsilon))) {
            const key = faceKey(a, b, c, options.epsilon);
            faceCounts.set(key, Math.min(3, (faceCounts.get(key) ?? 0) + 1));
          } else {
            stats.faceKeyLimitHit = true;
          }

          for (const key of [
            edgeKey(a, b, options.epsilon),
            edgeKey(b, c, options.epsilon),
            edgeKey(c, a, options.epsilon),
          ]) {
            if (edgeCounts.size < options.maxEdgeKeys || edgeCounts.has(key)) {
              edgeCounts.set(key, Math.min(5, (edgeCounts.get(key) ?? 0) + 1));
            } else {
              stats.edgeKeyLimitHit = true;
            }
          }
        }
      }
    }

    topFiles.push({
      name: path.basename(b3dmPath),
      triangles: fileTriangles,
      vertices: fileVertices,
      maxEdge: round(fileMaxEdge),
      aspectGt100: fileAspectGt100,
    });
  }

  edgeLengths.sort((a, b) => a - b);
  aspects.sort((a, b) => a - b);
  areas.sort((a, b) => a - b);
  topFiles.sort((a, b) => b.triangles - a.triangles);

  let duplicatedFaceKeys = 0;
  let duplicatedFaceInstances = 0;
  for (const count of faceCounts.values()) {
    if (count > 1) {
      duplicatedFaceKeys += 1;
      duplicatedFaceInstances += count;
    }
  }

  let boundaryEdges = 0;
  let manifoldEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of edgeCounts.values()) {
    if (count === 1) boundaryEdges += 1;
    else if (count === 2) manifoldEdges += 1;
    else nonManifoldEdges += 1;
  }

  return {
    file: path.relative(process.cwd(), tilesetPath),
    b3dm: stats.b3dm,
    primitives: stats.primitives,
    triangles: stats.triangles,
    vertices: stats.vertices,
    b3dmSize: formatBytes(stats.bytes),
    bboxSpan: stats.bboxMax.map((value, index) => round(value - stats.bboxMin[index])),
    edgeLength: {
      p50: round(percentile(edgeLengths, 0.50)),
      p90: round(percentile(edgeLengths, 0.90)),
      p99: round(percentile(edgeLengths, 0.99)),
      p999: round(percentile(edgeLengths, 0.999)),
      max: round(stats.maxEdge),
      gt1000: stats.longEdgeGt1000,
      gt5000: stats.longEdgeGt5000,
    },
    triangleAspect: {
      p50: round(percentile(aspects, 0.50)),
      p90: round(percentile(aspects, 0.90)),
      p99: round(percentile(aspects, 0.99)),
      p999: round(percentile(aspects, 0.999)),
      max: round(stats.maxAspect),
      gt50: stats.aspectGt50,
      gt100: stats.aspectGt100,
    },
    area: {
      p001: round(percentile(areas, 0.001)),
      p50: round(percentile(areas, 0.50)),
      p90: round(percentile(areas, 0.90)),
      p99: round(percentile(areas, 0.99)),
      degenerateTriangles: stats.degenerateTriangles,
    },
    duplicateFaces: {
      keys: duplicatedFaceKeys,
      instancesCapped: duplicatedFaceInstances,
      approxRatioByTriangle: round(duplicatedFaceInstances / Math.max(1, stats.triangles)),
      faceKeyLimitHit: stats.faceKeyLimitHit,
    },
    edgeSharing: {
      boundaryEdges,
      manifoldEdges,
      nonManifoldEdges,
      edgeKeyLimitHit: stats.edgeKeyLimitHit,
    },
    topFiles: topFiles.slice(0, 8),
  };
}

function collectJobs(tile, parentTransform, jobs) {
  if (!tile) return;
  const transform = tile.transform ? multiplyMatrix4(parentTransform, tile.transform) : parentTransform;
  const uri = tile.content?.uri ?? tile.content?.url;
  if (uri && stripUriQuery(uri).toLowerCase().endsWith(".b3dm")) {
    jobs.push({ uri, transform });
  }
  for (const child of tile.children ?? []) collectJobs(child, transform, jobs);
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
  return { glb: buffer.subarray(glbOffset) };
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

function readAccessorComponent(gltf, bin, accessor, index, component) {
  const view = gltf.bufferViews[accessor.bufferView];
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

function readPosition(gltf, bin, accessor, index) {
  return [
    readAccessorComponent(gltf, bin, accessor, index, 0),
    readAccessorComponent(gltf, bin, accessor, index, 1),
    readAccessorComponent(gltf, bin, accessor, index, 2),
  ];
}

function readIndexArray(gltf, bin, accessor) {
  const view = gltf.bufferViews[accessor.bufferView];
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

function getAccessorElementSize(accessor) {
  const componentBytes = COMPONENT_BYTES.get(accessor.componentType);
  const components = TYPE_COMPONENTS.get(accessor.type);
  if (!componentBytes || !components) throw new Error(`Unsupported accessor layout: ${accessor.componentType} ${accessor.type}`);
  return componentBytes * components;
}

function makeSequentialIndices(count) {
  return Array.from({ length: count }, (_, index) => index);
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

function updateBounds(stats, ...points) {
  for (const point of points) {
    for (let i = 0; i < 3; i += 1) {
      if (point[i] < stats.bboxMin[i]) stats.bboxMin[i] = point[i];
      if (point[i] > stats.bboxMax[i]) stats.bboxMax[i] = point[i];
    }
  }
}

function distance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function area(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const x = ab[1] * ac[2] - ab[2] * ac[1];
  const y = ab[2] * ac[0] - ab[0] * ac[2];
  const z = ab[0] * ac[1] - ab[1] * ac[0];
  return 0.5 * Math.sqrt(x * x + y * y + z * z);
}

function quantizedPoint(point, epsilon) {
  return `${Math.round(point[0] / epsilon)},${Math.round(point[1] / epsilon)},${Math.round(point[2] / epsilon)}`;
}

function faceKey(a, b, c, epsilon) {
  return [quantizedPoint(a, epsilon), quantizedPoint(b, epsilon), quantizedPoint(c, epsilon)].sort().join("|");
}

function edgeKey(a, b, epsilon) {
  return [quantizedPoint(a, epsilon), quantizedPoint(b, epsilon)].sort().join("|");
}

function sample(target, ...values) {
  if (target.length < 300000 || Math.random() < 0.02) target.push(...values);
}

function percentile(sorted, value) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * value)));
  return sorted[index];
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

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : value;
}

function formatBytes(value) {
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
