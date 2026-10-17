#!/usr/bin/env node
// The npm overlay for @thealtoclef/omp-claude-bridge (publish/stage.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	RUNTIME_DEPENDENCIES,
	assertPublishableManifest,
	buildPublishManifest,
	isPublishableVersion,
} from "../publish/stage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = JSON.parse(await readFile(join(ROOT, "publish", "package.template.json"), "utf8"));
const REPO = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

test("release versions use calendar dates and positive same-day post counters", () => {
	for (const version of ["2026.10.17", "2026.10.17-post.1", "2026.10.17-post.12", "2024.2.29", "2026.12.31-post.1"]) {
		assert.ok(isPublishableVersion(version), version);
	}
	for (const version of [
		"0.8.0", "2026.10", "2026.0.2", "2026.13.2", "2026.10.0",
		"2026.2.29", "2026.4.31", "2026.10.32", "2026.010.2", "2026.10.02",
		"2026.10.2-post.0", "2026.10.2-post.01", "2026.10.2-post",
		"2026.10.2-post.-1", "2026.10.2-post.1.2", "2026.10.2+post.1",
	]) {
		assert.ok(!isPublishableVersion(version), version);
		assert.throws(() => buildPublishManifest(TEMPLATE, REPO, version), /CalVer/);
	}
});

test("the overlay carries what an omp install needs", () => {
	const manifest = assertPublishableManifest(buildPublishManifest(TEMPLATE, REPO, "2026.10.17"));
	assert.equal(manifest.name, "@thealtoclef/omp-claude-bridge");
	assert.equal(manifest.version, "2026.10.17");
	assert.equal(manifest.private, false);
	assert.deepEqual(manifest.omp.extensions, ["./src/index.ts"]);
	assert.equal(manifest.pi, undefined, "omp-only: pi users have upstream");
	for (const dependency of RUNTIME_DEPENDENCIES) {
		assert.equal(manifest.dependencies[dependency], REPO.dependencies[dependency], `${dependency} comes from the repo manifest`);
	}
	assert.equal(manifest.peerDependencies, undefined, "omp serves @earendil-works/* itself");
	assert.equal(manifest.devDependencies, undefined);
	assert.ok(!manifest.files.includes("tests"), "tests validate the artifact, they do not ship in it");
});

test("every runtime import of src/ is a declared dependency", async () => {
	const { readdir } = await import("node:fs/promises");
	const sources = (await readdir(join(ROOT, "src"))).filter((name) => name.endsWith(".ts"));
	const external = new Set();
	for (const name of sources) {
		const text = await readFile(join(ROOT, "src", name), "utf8");
		// `import type` lines are erased at load, so only value imports count.
		for (const [, specifier] of text.matchAll(/^import\s+(?!type\s)[^;]*?from\s+"([^"]+)"/gm)) {
			if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
			external.add(specifier);
		}
	}
	const builtins = new Set(["fs", "os", "path", "crypto", "child_process", "url", "events", "stream", "util"]);
	const hostProvided = (specifier) => specifier.startsWith("@earendil-works/") || specifier === "typebox";
	const manifest = buildPublishManifest(TEMPLATE, REPO, "2026.10.17");
	for (const specifier of external) {
		if (builtins.has(specifier) || hostProvided(specifier)) continue;
		const pkg = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
		assert.ok(manifest.dependencies[pkg], `src imports ${specifier} at runtime but the published manifest does not depend on ${pkg}`);
	}
});

test("an unusable manifest is rejected rather than published", () => {
	const manifest = buildPublishManifest(TEMPLATE, REPO, "2026.10.17");
	assert.throws(() => assertPublishableManifest({ ...manifest, dependencies: {} }), /dependencies/);
	assert.throws(
		() => assertPublishableManifest({ ...manifest, peerDependencies: { "@earendil-works/pi-ai": "*" } }),
		/omp serves it/,
	);
	assert.throws(() => assertPublishableManifest({ ...manifest, files: ["src"] }), /files/);
	assert.throws(() => assertPublishableManifest({ ...manifest, omp: undefined }), /omp\.extensions/);
	assert.throws(() => assertPublishableManifest({ ...manifest, pi: { extensions: ["./src/index.ts"] } }), /pi entry/);
	assert.throws(() => assertPublishableManifest({ ...manifest, private: true }), /private/);
});
