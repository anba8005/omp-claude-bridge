#!/usr/bin/env node
/**
 * Publish staging for `@thealtoclef/omp-claude-bridge`.
 *
 * The repository is a fork of elidickinson/pi-claude-bridge and keeps upstream's
 * own `package.json` (name, version, pi peers, dev tooling). Publishing happens
 * from a staged copy whose manifest is an overlay — publish/package.template.json
 * plus the release version — so upstream's file never carries release-only
 * fields and a rebase cannot conflict on them.
 *
 * The overlay is not cosmetic. omp installs a plugin with `bun install` from the
 * manifest it ships, so:
 *   - `dependencies` must carry the runtime the extension imports (the Agent SDK,
 *     the MCP SDK, cc-session-io, change-case). They are taken from the repo's
 *     package.json at stage time, so a dependency bump there is what ships.
 *   - there must be no `@earendil-works/*` peer: omp serves those specifiers from
 *     its own bundled packages, so installing pi's copies is dead weight, and
 *     typebox is aliased the same way.
 *   - `omp.extensions` is the entry omp loads; there is no `pi` entry, because
 *     the port follows omp's provider contract and pi users have upstream.
 *
 * Usage:
 *   node publish/stage.mjs --version 2026.10.17[-post.N] [--out DIR] [--require-omp]
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PUBLISH_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(PUBLISH_DIR);
export const PACKAGE_DIR_NAME = "omp-claude-bridge";

/** Imported at runtime by src/; a published manifest without any of them fails to load. */
export const RUNTIME_DEPENDENCIES = [
  "@anthropic-ai/claude-agent-sdk",
  "@modelcontextprotocol/sdk",
  "cc-session-io",
  "change-case",
];

export function isPublishableVersion(value) {
  const match = /^([1-9]\d{3})\.([1-9]|1[0-2])\.([1-9]|[12]\d|3[01])(?:-post\.[1-9]\d*)?$/.exec(String(value || ""));
  if (!match) return false;
  const [, year, month, day] = match;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return Number(day) <= daysInMonth;
}

/**
 * The manifest that ships: the template, the release version, and the repo's
 * runtime dependencies.
 *
 * Pure, so the release gate can assert its shape without writing anything.
 */
export function buildPublishManifest(template, repoManifest, version) {
  if (!isPublishableVersion(version)) {
    throw new Error(`version must be CalVer YYYY.M.D or YYYY.M.D-post.N (N >= 1), got ${JSON.stringify(version)}`);
  }
  return { ...template, version, dependencies: { ...(repoManifest.dependencies ?? {}) } };
}

/** Field-by-field checks the published package must satisfy to be usable under omp. */
export function assertPublishableManifest(manifest) {
  const fail = (message) => {
    throw new Error(`publish manifest is unusable: ${message}`);
  };
  if (manifest.name !== "@thealtoclef/omp-claude-bridge") fail("name must be @thealtoclef/omp-claude-bridge");
  if (manifest.private !== false) fail("private must be false");
  for (const dependency of RUNTIME_DEPENDENCIES) {
    if (!manifest.dependencies?.[dependency]) fail(`dependencies must carry ${dependency} or the extension fails to import`);
  }
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith("@earendil-works/") || name === "typebox") {
        fail(`${field} must not carry ${name}: omp serves it from its own bundled packages`);
      }
    }
  }
  for (const entry of ["src", "README.md", "LICENSE"]) {
    if (!manifest.files?.includes(entry)) fail(`files must include ${entry}`);
  }
  if (manifest.omp?.extensions?.[0] !== "./src/index.ts") fail("omp.extensions must point at ./src/index.ts");
  if (manifest.pi) fail("the omp port must not register a pi entry");
  return manifest;
}

async function stage({ version, outDir }) {
  const template = JSON.parse(await readFile(join(PUBLISH_DIR, "package.template.json"), "utf8"));
  const repoManifest = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  const manifest = assertPublishableManifest(buildPublishManifest(template, repoManifest, version));

  await rm(outDir, { recursive: true, force: true });
  const staged = join(outDir, PACKAGE_DIR_NAME);
  await mkdir(staged, { recursive: true });
  for (const entry of manifest.files) {
    const source = join(REPO_ROOT, entry);
    if (!existsSync(source)) throw new Error(`files lists ${entry}, which does not exist`);
    await cp(source, join(staged, entry), { recursive: true });
  }
  await writeFile(join(staged, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { staged, manifest };
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, stdio: options.capture ? "pipe" : "inherit", encoding: "utf8" });
  if (result.status !== 0) {
    if (options.capture) process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
  return result.stdout ?? "";
}

function hasOmp() {
  return spawnSync("omp", ["--version"], { stdio: "ignore" }).status === 0;
}

/**
 * Install the packed tarball the way a user would get it and load it in omp.
 *
 * This is the check that matters most for this package: omp serves the
 * `@earendil-works/*` imports from its own bundled packages, so a symbol omp
 * does not export fails only at load time, inside omp, and never in the unit
 * suite (which runs against pi's packages). Loading the installed tarball also
 * proves the overlay's `dependencies` resolve.
 */
async function ompSmoke(staged) {
  const work = await mkdtemp(join(tmpdir(), "omp-claude-bridge-smoke-"));
  try {
    const tarball = run("npm", ["pack", "--silent", "--pack-destination", work], staged, { capture: true }).trim().split("\n").pop();
    await writeFile(join(work, "package.json"), '{ "name": "smoke", "private": true }\n');
    run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(work, tarball)], work, { capture: true });
    const entry = join(work, "node_modules", "@thealtoclef", "omp-claude-bridge", "src", "index.ts");
    run("node", [join(REPO_ROOT, "tests", "omp-smoke.mjs"), entry], work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf("--version");
  const version = versionIndex >= 0 ? args[versionIndex + 1] : "";
  const outIndex = args.indexOf("--out");
  const outDir = resolve(REPO_ROOT, outIndex >= 0 ? args[outIndex + 1] : "dist/omp-claude-bridge-stage");
  const requireOmp = args.includes("--require-omp");

  if (!isPublishableVersion(version)) {
    console.error("usage: node publish/stage.mjs --version YYYY.M.D[-post.N] [--out DIR] [--require-omp] (N >= 1)");
    process.exit(2);
  }

  // Tests and typecheck run against the source tree, which has the dev
  // dependencies; what ships is then validated from the staged copy.
  run("npm", ["run", "typecheck"], REPO_ROOT);
  run("npm", ["run", "test:unit"], REPO_ROOT);

  const { staged, manifest } = await stage({ version, outDir });
  console.log(`staged ${manifest.name}@${manifest.version} -> ${staged}`);
  run("npm", ["pack", "--dry-run"], staged);

  if (hasOmp()) {
    await ompSmoke(staged);
  } else if (requireOmp) {
    throw new Error("--require-omp: no omp on PATH to load the package in");
  } else {
    console.warn("omp not on PATH; skipped loading the packed extension in omp");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
