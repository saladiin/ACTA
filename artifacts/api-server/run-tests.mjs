import { spawnSync } from "node:child_process";
import { rm, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(root, "src");
const outDir = path.join(root, ".test-dist");

async function collectFiles(dir, predicate) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(fullPath, predicate);
    return predicate(fullPath) ? [fullPath] : [];
  }));
  return files.flat();
}

await rm(outDir, { recursive: true, force: true });

const testFiles = await collectFiles(srcDir, file => file.endsWith(".test.ts"));
if (testFiles.length === 0) {
  console.log("No API server tests found.");
  process.exit(0);
}

try {
  await build({
    entryPoints: testFiles,
    outdir: outDir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: "inline",
    outExtension: { ".js": ".mjs" },
    packages: "external",
    logLevel: "silent",
  });

  const builtTests = await collectFiles(outDir, file => file.endsWith(".mjs"));
  const result = spawnSync(process.execPath, ["--test", ...builtTests], {
    cwd: root,
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outDir, { recursive: true, force: true });
}
