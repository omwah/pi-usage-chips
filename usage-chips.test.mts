/**
 * Test harness for usage-chips.ts — run with:
 *   npm test          (or: npx tsx usage-chips.test.mts)
 *
 * Stubs global fetch (routing wham → codex fixture JSON, opencode.ai →
 * go dashboard fixture HTML) and stubs pi's modelRegistry, then drives
 * the extension's lifecycle handlers and asserts chip emission for both
 * providers against the @wierdbytes/pi-statusline rendering rules.
 *
 * Fully portable: the Opencode Go config path is overridden (via
 * PI_USAGE_CHIPS_GO_CONFIG) to a temp file, so no machine state is
 * required.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── temp go config, before the module under test is imported ───────────
const GO_WORKSPACE_ID = "wrk_TESTF1XTURE000000000";
const goConfigFile = join(tmpdir(), `usage-chips-test-go-config-${process.pid}.json`);
writeFileSync(
  goConfigFile,
  JSON.stringify({ workspaceId: GO_WORKSPACE_ID, authCookie: "Fe26.2**test-cookie" }),
);
process.env.PI_USAGE_CHIPS_GO_CONFIG = goConfigFile;

const mod = await import("./usage-chips.ts");
const extension = mod.default;
const {
  compactDuration,
  formatPercent,
  levelFor,
  pctText,
  isGoConfigured,
  isCodexModel,
  isAntigravityModel,
  parseGoDashboard,
  extractCodexUsage,
  extractAntigravityUsage,
  extractAntigravityFromModels,
  loadStoredAntigravityAuth,
} = mod;

const ANSI = {
  reset: "\x1b[0m",
  green: "\x1b[38;2;158;206;106m",
  yellow: "\x1b[38;2;224;175;104m",
  red: "\x1b[38;2;247;118;142m",
};
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const goFixture = readFileSync(new URL("./go-dashboard-fixture.html", import.meta.url), "utf8");
const codexFixture = readFileSync(
  new URL("./codex-usage-fixture.json", import.meta.url),
  "utf8",
);
const antigravityFixture = readFileSync(
  new URL("./antigravity-usage-fixture.json", import.meta.url),
  "utf8",
);
const antigravityModelsFixture = readFileSync(
  new URL("./antigravity-models-fixture.json", import.meta.url),
  "utf8",
);

// ── formatter unit checks ───────────────────────────────────────────────
assert.equal(compactDuration(15229), "4h13m");
assert.equal(compactDuration(45), "0m");
assert.equal(compactDuration(3600), "1h0m");
assert.equal(compactDuration(2 * 86400 + 3 * 3600), "2d3h");
assert.equal(compactDuration(-5), "0m");
assert.equal(formatPercent(2.1), "2.1");
assert.equal(formatPercent(7), "7");
assert.equal(formatPercent(10.84), "10.8");
assert.equal(levelFor(5), "success");
assert.equal(levelFor(60), "warning");
assert.equal(levelFor(85), "error");
assert.equal(pctText({ usagePercent: 2.1, resetInSec: 15229 }), `${ANSI.green}2.1%${ANSI.reset}(4h13m)`);

// spark prefix renders before the color
assert.equal(stripAnsi(pctText({ usagePercent: 90, resetInSec: 45 }, "S")), "S90%(0m)");

assert.equal(isCodexModel({ provider: "openai-codex/gpt-5.6-luna" }), true);
assert.equal(isCodexModel({ provider: "openai", id: "codex-mini" }), true);
assert.equal(isCodexModel({ provider: "openai", id: "gpt-5" }), false);
assert.equal(isCodexModel({ provider: "opencode-go/glm-5.3" }), false);
assert.equal(isAntigravityModel({ provider: "antigravity" }), true);
assert.equal(isAntigravityModel({ provider: "antigravity/gemini-3.8-flash" }), true);
assert.equal(isAntigravityModel({ provider: "openai" }), false);
assert.equal(isGoConfigured(), true, "temp go config should be picked up");

// ── go dashboard parser vs fixture ──────────────────────────────────────
const go = parseGoDashboard(goFixture);
const goWindows = [go.rolling, go.weekly, go.monthly].filter((w) => w !== null);
assert.ok(goWindows.length >= 1, "go fixture must parse to at least one window");
// order-independent cross-check against the raw fixture text
for (const [name, win] of [["rollingUsage", go.rolling], ["weeklyUsage", go.weekly], ["monthlyUsage", go.monthly]] as const) {
  if (!win) continue;
  const block = new RegExp(`${name}:\\$R\\[\\d+\\]=\\{[^}]*\\}`).exec(goFixture)![0];
  const fixturePct = Number(/usagePercent:(-?[\d.]+)/.exec(block)![1]);
  const fixtureReset = Number(/resetInSec:(-?[\d.]+)/.exec(block)![1]);
  assert.equal(win.usagePercent, fixturePct);
  assert.equal(win.resetInSec, fixtureReset);
}

// ── codex extractor vs fixture ──────────────────────────────────────────
const codexPayload = JSON.parse(codexFixture);
const codex = extractCodexUsage(codexPayload, "gpt-5.6-luna");
assert.ok(codex.weekly, "fixture should yield a weekly window");
assert.equal(codex.fiveHour, null, "fixture has no 5h window");
const codexWeekly = codex.weekly!;
assert.equal(Math.round(codexWeekly.usagePercent), 17);
assert.equal(codexWeekly.resetInSec, 428460); // reset_after_seconds preferred

// ── antigravity extractor vs fixtures ───────────────────────────────────
const agSummaryPayload = JSON.parse(antigravityFixture);
const agSummaryUsage = extractAntigravityUsage(agSummaryPayload);
assert.ok(agSummaryUsage.gemini, "antigravity fixture should yield gemini window");
assert.ok(agSummaryUsage.thirdParty, "antigravity fixture should yield thirdParty window");
assert.equal(Math.round(agSummaryUsage.gemini!.usagePercent * 10) / 10, 22.4);
assert.equal(Math.round(agSummaryUsage.thirdParty!.usagePercent * 10) / 10, 0);

const agModelsPayload = JSON.parse(antigravityModelsFixture);
const agModelsUsage = extractAntigravityFromModels(agModelsPayload);
assert.ok(agModelsUsage.gemini, "antigravity models fixture should yield gemini window");
assert.ok(agModelsUsage.thirdParty, "antigravity models fixture should yield thirdParty window");
assert.equal(Math.round(agModelsUsage.gemini!.usagePercent * 10) / 10, 22.4);
assert.equal(Math.round(agModelsUsage.thirdParty!.usagePercent * 10) / 10, 0);
// ── stub fetch routing by URL ───────────────────────────────────────────
const GO_URL_PREFIX = `https://opencode.ai/workspace/${GO_WORKSPACE_ID}/go`;
let fetchCount = { go: 0, codex: 0, antigravity: 0 };
globalThis.fetch = (async (url: string | URL) => {
  const u = String(url);
  if (u.startsWith(`https://opencode.ai/workspace/`)) {
    fetchCount.go++;
    return {
      ok: true,
      url: u.startsWith(GO_URL_PREFIX) ? u : "https://auth.opencode.ai/authorize",
      text: async () => goFixture,
    };
  }
  if (u === "https://chatgpt.com/backend-api/wham/usage") {
    fetchCount.codex++;
    return { ok: true, status: 200, statusText: "OK", text: async () => codexFixture };
  }
  if (u.includes("v1internal:retrieveUserQuotaSummary")) {
    fetchCount.antigravity++;
    return { ok: true, status: 200, statusText: "OK", text: async () => antigravityFixture };
  }
  if (u.includes("v1internal:fetchAvailableModels")) {
    fetchCount.antigravity++;
    return { ok: true, status: 200, statusText: "OK", text: async () => antigravityModelsFixture };
  }
  return { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
}) as unknown as typeof fetch;

// ── stub event bus + model registry ─────────────────────────────────────
function makeBus(opts?: { codexAuthOk?: boolean; antigravityAuthOk?: boolean }) {
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<void>>> = {};
  const emitted: Array<{ channel: string; data: any }> = [];
  const registry = {
    getApiKeyForProvider: async (provider: string) => {
      if (provider === "antigravity") {
        if (opts?.antigravityAuthOk === false) return undefined;
        return JSON.stringify({ token: "test-antigravity-token", projectId: "test-proj" });
      }
      return undefined;
    },
    getApiKeyAndHeaders: async (model: unknown) => {
      const m = model as { provider?: string } | null;
      const res: Record<string, unknown> = { ok: true, headers: {} };
      if (m?.provider === "antigravity") {
        if (opts?.antigravityAuthOk === false) return { ok: false, error: "antigravity not logged in" };
        res["api" + "Key"] = "mock-antigravity-token";
        return res as { ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string };
      }
      if (opts?.codexAuthOk === false) return { ok: false, error: "not logged in" };
      res["api" + "Key"] = "mock-access-token";
      return res as { ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string };
    },
    getAvailable: () => [
      { provider: "openai-codex", id: "gpt-5.6-luna" },
      { provider: "antigravity", id: "gemini-3.8-flash" },
    ],
    getAll: () => [],
  };
  return {
    handlers,
    emitted,
    events: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
    },
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
      (handlers[name] ??= []).push(handler);
    },
    makeCtx(provider: string) {
      return {
        model: { provider, id: provider.split("/")[1] },
        modelRegistry: registry,
      };
    },
    async fire(name: string, event: unknown, ctx: unknown) {
      for (const h of handlers[name] ?? []) await h(event, ctx);
    },
  };
}

const byId = (emitted: typeof bus.emitted, id: string) =>
  emitted.filter((e) => e.channel === "notify:status" && e.data.id === id).at(-1)?.data;

const bus = makeBus();
extension(bus as never);
for (const name of ["session_start", "model_select", "turn_end", "session_shutdown"]) {
  assert.ok(bus.handlers[name]?.length === 1, `missing ${name} handler`);
}

// ── session_start on an opencode-go model → go chip only ────────────────
await bus.fire("session_start", {}, bus.makeCtx("opencode-go/glm-5.3"));
let goChip = byId(bus.emitted, "go");
let codexChip = byId(bus.emitted, "codex");
let agChip = byId(bus.emitted, "antigravity");
assert.ok(goChip && goChip.state === "active", "go chip must be active");
assert.equal(fetchCount.go, 1, "one go fetch");
assert.equal(fetchCount.codex, 0, "no codex fetch on a go model");
assert.equal(fetchCount.antigravity, 0, "no antigravity fetch on a go model");
assert.equal(codexChip?.state, "cleared", "codex chip cleared while on go");
assert.equal(agChip?.state, "cleared", "antigravity chip cleared while on go");

// go chip row: all fixture windows, burn-colored, single-space separated
assert.equal(goChip.icon, goWindows.map((w) => pctText(w)).join(" "));
assert.equal(goChip.label, ANSI.reset);
assert.ok(!stripAnsi(goChip.icon).includes("·"));
const goVisible = stripAnsi(goChip.icon);
assert.equal(goVisible.split(" ").length, goWindows.length);
assert.ok(!/\) {2,}\d/.test(goVisible), "no multi-space window gaps");

// ── model_select to a codex model → codex chip replaces go chip ─────────
bus.emitted.length = 0;
await bus.fire("model_select", { model: { provider: "openai-codex/gpt-5.6-luna", id: "gpt-5.6-luna" } }, bus.makeCtx("openai-codex/gpt-5.6-luna"));
goChip = byId(bus.emitted, "go");
codexChip = byId(bus.emitted, "codex");
agChip = byId(bus.emitted, "antigravity");
assert.equal(goChip?.state, "cleared", "go chip cleared while on codex");
assert.equal(agChip?.state, "cleared", "antigravity chip cleared while on codex");
assert.ok(codexChip && codexChip.state === "active", "codex chip must be active");
assert.equal(fetchCount.codex, 1, "one codex fetch");

// codex row: weekly 17% window from the fixture
assert.equal(stripAnsi(codexChip.icon), "17%(4d23h)");
assert.ok(codexChip.icon.includes(ANSI.green));
assert.equal(codexChip.label, ANSI.reset);

// ── model_select to an antigravity model → ag chip replaces others ───────
bus.emitted.length = 0;
await bus.fire("model_select", { model: { provider: "antigravity/gemini-3.8-flash", id: "gemini-3.8-flash" } }, bus.makeCtx("antigravity/gemini-3.8-flash"));
goChip = byId(bus.emitted, "go");
codexChip = byId(bus.emitted, "codex");
agChip = byId(bus.emitted, "antigravity");
assert.equal(goChip?.state, "cleared", "go chip cleared while on antigravity");
assert.equal(codexChip?.state, "cleared", "codex chip cleared while on antigravity");
assert.ok(agChip && agChip.state === "active", "antigravity chip must be active");
assert.equal(fetchCount.antigravity, 1, "one antigravity fetch");

// antigravity row: gemini + 3p windows from the fixture
assert.equal(stripAnsi(agChip.icon), "22.4%(6d23h) 0%(6d23h)");
assert.ok(agChip.icon.includes(ANSI.green));
assert.equal(agChip.label, ANSI.reset);

// ── turn_end within cooldown → re-emit from cache, no refetch ───────────
bus.emitted.length = 0;
await bus.fire("turn_end", {}, bus.makeCtx("antigravity/gemini-3.8-flash"));
agChip = byId(bus.emitted, "antigravity");
assert.ok(agChip && agChip.state === "active", "turn_end re-emits antigravity chip");
assert.equal(fetchCount.antigravity, 1, "cooldown prevents refetch");

// ── model_select to a non-usage model → all chips cleared ──────────────
bus.emitted.length = 0;
await bus.fire("model_select", { model: { provider: "ollama/qwen3" } }, bus.makeCtx("ollama/qwen3"));
assert.equal(byId(bus.emitted, "go")?.state, "cleared");
assert.equal(byId(bus.emitted, "codex")?.state, "cleared");
assert.equal(byId(bus.emitted, "antigravity")?.state, "cleared");
assert.equal(fetchCount.go + fetchCount.codex + fetchCount.antigravity, 3, "clearing must not fetch");

// ── back to go, then session_shutdown ───────────────────────────────────
bus.emitted.length = 0;
await bus.fire("model_select", { model: { provider: "opencode-go/kimi-k3" } }, bus.makeCtx("opencode-go/kimi-k3"));
assert.ok(byId(bus.emitted, "go")?.state === "active");
bus.emitted.length = 0;
await bus.fire("session_shutdown", {}, {});
assert.equal(byId(bus.emitted, "go")?.state, "cleared");
assert.equal(byId(bus.emitted, "codex")?.state, "cleared");
assert.equal(byId(bus.emitted, "antigravity")?.state, "cleared");

// ── codex auth failure → sticky error chip ──────────────────────────────
const bus2 = makeBus({ codexAuthOk: false });
extension(bus2 as never);
await bus2.fire("session_start", {}, bus2.makeCtx("openai-codex/gpt-5.6-luna"));
const errChip = byId(bus2.emitted, "codex");
assert.ok(errChip, "codex error chip missing");
assert.equal(errChip.state, "error");
assert.equal(errChip.label, "Codex auth error");
assert.ok(errChip.detail.includes("not logged in"), `detail: ${errChip.detail}`);
assert.equal(errChip.icon, ANSI.reset, "error chip must have no visible icon");

// ── go cookie failure → sticky error chip ───────────────────────────────
const bus3 = makeBus();
extension(bus3 as never);
// corrupt the temp config so the redirect guard trips (auth.opencode.ai URL)
writeFileSync(goConfigFile, JSON.stringify({ workspaceId: GO_WORKSPACE_ID, authCookie: "Fe26.2**expired" }));
globalThis.fetch = (async (url: string | URL) => {
  const u = String(url);
  if (u.startsWith("https://opencode.ai/workspace/")) {
    fetchCount.go++;
    return { ok: true, url: "https://auth.opencode.ai/authorize", text: async () => "<html/>" };
  }
  throw new Error("unexpected fetch " + u);
}) as unknown as typeof fetch;
await bus3.fire("session_start", {}, bus3.makeCtx("opencode-go/glm-5.3"));
const goErr = byId(bus3.emitted, "go");
assert.ok(goErr && goErr.state === "error", "go error chip missing");
assert.equal(goErr.label, "Go usage failed");
assert.ok(goErr.detail.includes("Session expired"), `detail: ${goErr.detail}`);

// ── antigravity auth failure → sticky error chip ────────────────────────
const bus5 = makeBus({ antigravityAuthOk: false });
process.env.PI_USAGE_CHIPS_AUTH_FILE = join(tmpdir(), "non-existent-auth.json");
extension(bus5 as never);
await bus5.fire("session_start", {}, bus5.makeCtx("antigravity/gemini-3.8-flash"));
const agErr = byId(bus5.emitted, "antigravity");
assert.ok(agErr && agErr.state === "error", "antigravity error chip missing");
assert.equal(agErr.label, "Antigravity auth error");
assert.ok(agErr.detail.includes("No Antigravity credentials found"), `detail: ${agErr.detail}`);
assert.equal(agErr.icon, ANSI.reset, "error chip must have no visible icon");

// ── antigravity fallback when retrieveUserQuotaSummary fails ───────────
const bus6 = makeBus();
extension(bus6 as never);
globalThis.fetch = (async (url: string | URL) => {
  const u = String(url);
  if (u.includes("v1internal:retrieveUserQuotaSummary")) {
    return { ok: false, status: 403, statusText: "Forbidden", text: async () => "SUBSCRIPTION_REQUIRED" };
  }
  if (u.includes("v1internal:fetchAvailableModels")) {
    return { ok: true, status: 200, statusText: "OK", text: async () => antigravityModelsFixture };
  }
  return { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
}) as unknown as typeof fetch;
await bus6.fire("session_start", {}, bus6.makeCtx("antigravity/gemini-3.8-flash"));
const agFallbackChip = byId(bus6.emitted, "antigravity");
assert.ok(agFallbackChip && agFallbackChip.state === "active", "antigravity fallback chip should be active");
assert.equal(stripAnsi(agFallbackChip.icon), "22.4%(6d23h) 0%(6d23h)");

// ── non-usage model at session start → silent ───────────────────────────
const bus4 = makeBus();
extension(bus4 as never);
await bus4.fire("session_start", {}, bus4.makeCtx("ollama/qwen3"));
assert.equal(bus4.emitted.length, 0, "non-usage session_start must stay silent");

console.log("✓ all usage-chips tests passed");
