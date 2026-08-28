#!/usr/bin/env node

/**
 * Reads the version from packages/@wterm/core/package.json (the canonical
 * source) and writes it to every other @wterm/* package.json.
 *
 * Usage:
 *   node scripts/sync-versions.mjs          # sync
 *   node scripts/sync-versions.mjs --check  # CI check (exit 1 if out of sync)
 */

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const root = join(fileURLToPath(import.meta.url), "../..");
const packagesDir = join(root, "packages/@wterm");

const canonicalPkg = JSON.parse(
  readFileSync(join(packagesDir, "core/package.json"), "utf8"),
);
const version = canonicalPkg.version;

const check = process.argv.includes("--check");
let mismatches = [];

for (const dir of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, dir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    continue;
  }

  if (pkg.version === version) continue;

  if (check) {
    mismatches.push(`${pkg.name}: ${pkg.version} (expected ${version})`);
  } else {
    pkg.version = version;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`Updated ${pkg.name} to ${version}`);
  }
}

if (check && mismatches.length > 0) {
  console.error("Version mismatch:");
  for (const m of mismatches) console.error(`  ${m}`);
  process.exit(1);
} else if (check) {
  console.log(`All @wterm/* packages are at ${version}`);
}
