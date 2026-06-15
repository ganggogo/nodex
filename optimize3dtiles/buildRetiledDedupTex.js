#!/usr/bin/env node

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const positional = args.filter((arg) => !arg.startsWith("-"));
  const inputTileset = path.resolve(positional[0] ?? "static/models/横琴示范区.json");
  const ratio = readNumberOption(args, "--ratio", 0.25);
  const maxTriangles = readStringOption(args, "--max-triangles", "30000");
  const minBytes = readStringOption(args, "--min-bytes", "2mb");
  const maxParts = readStringOption(args, "--max-parts", "16");
  const maxVertices = readStringOption(args, "--max-vertices", "60000");
  const keepStages = args.includes("--keep-stages");

  if (ratio <= 0 || ratio >= 1) throw new Error("--ratio must be greater than 0 and less than 1.");

  const outputTileset = path.resolve(
    positional[1] ?? makeDefaultOutput(inputTileset, ratio),
  );
  const groupedTileset = makeStageOutput(inputTileset, "_grouped");
  const retiledTileset = makeStageOutput(inputTileset, "_retiled_dedup");
  const stageTilesets = [groupedTileset, retiledTileset];

  if (!keepStages) {
    await removeStageOutputs(stageTilesets, "Removing old intermediate output");
  }

  await runNodeScript("groupTilesetByQuadTree.js", [
    inputTileset,
    groupedTileset,
  ]);

  await runNodeScript("retileByGrid.js", [
    groupedTileset,
    retiledTileset,
    "--max-triangles",
    maxTriangles,
    "--min-bytes",
    minBytes,
    "--max-parts",
    maxParts,
    "--max-vertices",
    maxVertices,
  ]);

  await runNodeScript("createTextureScaleTileset.js", [
    retiledTileset,
    outputTileset,
    "--ratio",
    String(ratio),
  ]);

  if (!keepStages) {
    await removeStageOutputs(stageTilesets, "Removing intermediate output");
  }

  console.log(`Done: ${outputTileset}`);
}

function printUsage() {
  console.log(`Usage:
  node optimize3dtiles/buildRetiledDedupTex.js [inputTileset.json] [outputTileset.json] [options]

Options:
  --ratio <n>          Texture scale ratio. Default: 0.25
  --max-triangles <n>  Retile target triangles per child b3dm. Default: 30000
  --min-bytes <size>   Retile source b3dm size threshold. Default: 2mb
  --max-parts <n>      Retile max parts per source b3dm. Default: 16
  --max-vertices <n>   Max vertices per output primitive. Default: 60000
  --keep-stages        Keep intermediate _grouped and _retiled_dedup outputs.

Default output:
  static/models/<name>_retiled_dedup_tex25.json`);
}

async function removeTilesetAndContent(tilesetPath) {
  const contentDir = path.join(
    path.dirname(tilesetPath),
    path.basename(tilesetPath, path.extname(tilesetPath)),
  );
  await fsp.rm(tilesetPath, { force: true });
  await fsp.rm(contentDir, { recursive: true, force: true });
}

async function removeStageOutputs(tilesetPaths, label) {
  for (const tilesetPath of tilesetPaths) {
    const contentDir = path.join(
      path.dirname(tilesetPath),
      path.basename(tilesetPath, path.extname(tilesetPath)),
    );
    console.log(`${label}: ${path.relative(process.cwd(), tilesetPath)}`);
    await removeTilesetAndContent(tilesetPath);
    console.log(`${label}: ${path.relative(process.cwd(), contentDir)}`);
  }
}

function makeStageOutput(inputTileset, suffix) {
  const ext = path.extname(inputTileset);
  const base = path.basename(inputTileset, ext);
  return path.join(path.dirname(inputTileset), `${base}${suffix}${ext}`);
}

function makeDefaultOutput(inputTileset, ratio) {
  const ext = path.extname(inputTileset);
  const base = path.basename(inputTileset, ext);
  return path.join(path.dirname(inputTileset), `${base}_retiled_dedup_tex${Math.round(ratio * 100)}${ext}`);
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

function runNodeScript(scriptName, scriptArgs) {
  const normalizedScriptPath = path.join(SCRIPT_DIR, scriptName);

  console.log(`\n> node ${path.relative(process.cwd(), normalizedScriptPath)} ${scriptArgs.map(formatArg).join(" ")}`);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [normalizedScriptPath, ...scriptArgs], {
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptName} exited with code ${code}`));
    });
  });
}

function formatArg(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
