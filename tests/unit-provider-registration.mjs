#!/usr/bin/env node

/**
 * Provider registration across extension loads.
 *
 * omp replays registrations per load: creating a session (a task subagent's,
 * on the parent's own registry) clears what the bridge's source registered and
 * applies only what this load queued. A load that skipped registerProvider
 * deleted the provider for the whole process ("No API key for provider:
 * claude-bridge" in every subagent). Every load registers — with the stream fn
 * of the instance already serving, so a freshly evaluated module never points
 * the shared registry at its own empty state.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const PROVIDER_ID = "claude-bridge";

const { default: activate } = await import("../src/index.js");

function activateWithMockPi(activateFn, options = {}) {
	// pi appends handlers (a later bridge instance registers two session_start
	// handlers: clearSession + deferred registration), so the mock does too.
	const handlers = new Map();
	const registered = [];
	(activateFn ?? activate)({
		on: (event, handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider: (name, config) => registered.push({ name, config }),
		registerTool: () => {},
	});
	const emit = (event, ...args) => {
		for (const handler of handlers.get(event) ?? []) handler(...args);
	};
	return { handlers, registered, emit };
}

function registryWith(provider) {
	return { getProvider: (id) => (id === provider ? { name: provider } : undefined) };
}

describe("provider registration across module instances", () => {
	it("first instance registers at activation", () => {
		const { registered } = activateWithMockPi();
		assert.equal(registered.length, 1, "exactly one activation-time registration");
		assert.equal(registered[0].name, PROVIDER_ID);
	});

	it("every later load registers too, with the serving instance's stream fn", async () => {
		const first = activateWithMockPi();
		const served = first.registered[0].config.streamSimple;
		// The same module loaded again (omp shares it across a parent and its subagents)...
		const again = activateWithMockPi();
		assert.equal(again.registered.length, 1, "a load that registers nothing would delete the provider");
		assert.equal(again.registered[0].config.streamSimple, served);
		// ...and a freshly evaluated instance.
		const { default: activateFresh } = await import("../src/index.js?fresh-instance");
		const fresh = activateWithMockPi(activateFresh);
		assert.equal(fresh.registered.length, 1);
		assert.equal(fresh.registered[0].config.streamSimple, served, "the parent's state keeps serving");
	});
});
