/**
 * usage-chips — pi extension that surfaces provider quota usage as chips
 * in @wierdbytes/pi-statusline. Self-contained: no dependency on
 * @beyona/pi-zai-usage.
 *
 * Supported providers, shown only while the active model matches:
 *
 *   - `opencode-go/*`  → Opencode Go rolling/weekly/monthly quota,
 *     scraped from the dashboard page configured in
 *     `~/.pi/agent/opencode-go.json` (workspaceId + auth cookie).
 *
 *   - `openai-codex/*` (or `openai/*` codex models) → OpenAI Codex
 *     5-hour/weekly (+spark) windows from the ChatGPT Codex usage
 *     endpoint, authenticated via pi's own provider auth
 *     (`ctx.modelRegistry.getApiKeyAndHeaders`).
 *
 *   - `antigravity/*` → Antigravity quota pools (Gemini weekly,
 *     Claude/GPT 3P weekly) from the Antigravity user quota summary /
 *     available models endpoints, authenticated via pi's provider auth
 *     (`ctx.modelRegistry.getApiKeyForProvider` or `getApiKeyAndHeaders`,
 *     or stored ~/.pi/agent/auth.json).
 *
 * Rendering contract with @wierdbytes/pi-statusline: each provider gets
 * ONE `notify:status` chip on pi's shared event bus. The statusline
 * emits a chip as `<icon> <levelColor><label><reset>` where the icon is
 * verbatim (never truncated or styled) but the label is capped at 16
 * visible chars — too small for a full multi-window row. So the whole
 * row rides in `icon` with an invisible ANSI reset as the label: every
 * window's percentage is burn-colored (green <60% ≤ yellow <85% ≤ red),
 * reset times stay uncolored, windows are single-space separated.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const COOLDOWN_MS = 30_000;
const BUS_CHANNEL = "notify:status";
const CHIP_GO = "go";
const CHIP_CODEX = "codex";
const CHIP_ANTIGRAVITY = "antigravity";

// Tokyo Night Storm truecolor codes, matching the statusline's own
// C_GREEN / C_YELLOW / C_RED in @wierdbytes/pi-statusline blocks.ts.
// Hardcoded because a bare-specifier import of the statusline package
// does not resolve from the extensions directory.
const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[38;2;158;206;106m";
const ANSI_YELLOW = "\x1b[38;2;224;175;104m";
const ANSI_RED = "\x1b[38;2;247;118;142m";

/** Zero-width chip icon: the statusline always emits `<icon> <label>`
 *  and falls back to a visible level glyph (✓/⚠/✗) when `icon` is
 *  absent or empty, so the field must carry something invisible. An
 *  ANSI reset renders as nothing in every terminal and measures 0
 *  columns. (Usage chips instead put their whole row in the icon — see
 *  emitUsageChip.) */
const ICON_NONE = ANSI_RESET;

// ───────────────────────── shared formatting ─────────────────────────

/** Compact reset duration: `45m`, `4h13m`, `2d3h`. */
export function compactDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

/** One-decimal percent, trailing `.0` trimmed: 2.1 → "2.1", 7 → "7". */
export function formatPercent(pct: number): string {
  return String(Math.round(pct * 10) / 10);
}

/** Severity by burn: green < 60% ≤ yellow < 85% ≤ red. */
export function levelFor(pct: number): "success" | "warning" | "error" {
  if (pct >= 85) return "error";
  if (pct >= 60) return "warning";
  return "success";
}

export function ansiForLevel(level: "success" | "warning" | "error"): string {
  if (level === "error") return ANSI_RED;
  if (level === "warning") return ANSI_YELLOW;
  return ANSI_GREEN;
}

/** Colored `pct%(time)` for one window. Only the percentage is colored;
 *  the trailing ANSI reset puts `(time)` back on the default foreground. */
export function pctText(win: UsageWindow, prefix = ""): string {
  const color = ansiForLevel(levelFor(win.usagePercent));
  return `${prefix}${color}${formatPercent(win.usagePercent)}%${ANSI_RESET}(${compactDuration(win.resetInSec)})`;
}

interface UsageWindow {
  usagePercent: number;
  resetInSec: number;
}

// ───────────────────────── Opencode Go scraper ─────────────────────────

const GO_CONFIG_FILE =
  process.env.PI_USAGE_CHIPS_GO_CONFIG ?? join(homedir(), ".pi", "agent", "opencode-go.json");
const GO_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";
const GO_SCRAPE_TIMEOUT_MS = 10_000;

interface GoUsage {
  rolling: UsageWindow | null;
  weekly: UsageWindow | null;
  monthly: UsageWindow | null;
}

function loadGoConfig(): { workspaceId: string; authCookie: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(GO_CONFIG_FILE, "utf8")) as Record<string, unknown>;
    const workspaceId = typeof parsed.workspaceId === "string" ? parsed.workspaceId.trim() : "";
    const authCookie = typeof parsed.authCookie === "string" ? parsed.authCookie.trim() : "";
    if (!workspaceId || !authCookie) return null;
    return { workspaceId, authCookie };
  } catch {
    return null;
  }
}

export function isGoConfigured(): boolean {
  return loadGoConfig() !== null;
}

/** Match the SolidJS SSR hydration output; field order may vary, so each
 *  window regex has a pct-first and a reset-first variant. */
function parseGoWindow(html: string, name: string): UsageWindow | null {
  const num = "(-?\\d+(?:\\.\\d+)?)";
  const res = [
    new RegExp(`${name}:\\$R\\[\\d+\\]=\\{[^}]*usagePercent:${num}[^}]*resetInSec:${num}[^}]*\\}`),
    new RegExp(`${name}:\\$R\\[\\d+\\]=\\{[^}]*resetInSec:${num}[^}]*usagePercent:${num}[^}]*\\}`),
  ];
  for (const re of res) {
    const m = re.exec(html);
    if (!m) continue;
    const usagePercent = Number(re === res[0] ? m[1] : m[2]);
    const resetInSec = Number(re === res[0] ? m[2] : m[1]);
    if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
      return { usagePercent, resetInSec };
    }
  }
  return null;
}

export function parseGoDashboard(html: string): GoUsage {
  return {
    rolling: parseGoWindow(html, "rollingUsage"),
    weekly: parseGoWindow(html, "weeklyUsage"),
    monthly: parseGoWindow(html, "monthlyUsage"),
  };
}

export async function fetchGoUsage(): Promise<GoUsage> {
  const config = loadGoConfig();
  if (!config) {
    throw new Error("No config — create ~/.pi/agent/opencode-go.json");
  }
  if (!/^wrk_[A-Za-z0-9]+$/.test(config.workspaceId)) {
    throw new Error(`Invalid workspaceId format: "${config.workspaceId}"`);
  }
  if (!config.authCookie.startsWith("Fe26.2**")) {
    throw new Error("Invalid authCookie format — expected an Iron-sealed session cookie");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GO_SCRAPE_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://opencode.ai/workspace/${config.workspaceId}/go`,
      {
        headers: { Cookie: `auth=${config.authCookie}`, "User-Agent": GO_USER_AGENT },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    if (!response.url.includes(`/workspace/${config.workspaceId}/go`)) {
      throw new Error("Session expired or auth invalid — refresh your cookie");
    }
    return parseGoDashboard(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── OpenAI Codex scraper ─────────────────────────

const CODEX_USAGE_API_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_SCRAPE_TIMEOUT_MS = 15_000;

interface CodexUsage {
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  weeklySpark: UsageWindow | null;
}

export class CodexAuthError extends Error {}

/** Model is Codex-auth-backed: provider prefix or openai/* codex ids. */
export function isCodexModel(model: unknown): boolean {
  const m = model as { provider?: string; id?: string } | null | undefined;
  if (!m?.provider) return false;
  const provider = m.provider.toLowerCase();
  if (provider.startsWith("openai-codex")) return true;
  return provider === "openai" && (m.id?.toLowerCase() ?? "").includes("codex");
}

interface RegistryModel {
  provider: string;
  id?: string;
}

async function resolveCodexAuthHeaders(ctx: CodexContext): Promise<Record<string, string>> {
  const registry = (ctx as { modelRegistry?: unknown }).modelRegistry as
    | {
        getApiKeyAndHeaders?: (model: unknown) => Promise<{
          ok: boolean;
          apiKey?: string;
          headers?: Record<string, string>;
          error?: string;
        }>;
        getAvailable?: () => RegistryModel[];
        getAll?: () => RegistryModel[];
      }
    | undefined;
  if (!registry?.getApiKeyAndHeaders) {
    throw new CodexAuthError("No model registry available for Codex auth lookup");
  }
  const candidates: RegistryModel[] = [];
  const seen = new Set<string>();
  const add = (model: unknown): void => {
    const m = model as RegistryModel | null | undefined;
    if (!m || !isCodexModel(m)) return;
    const key = `${m.provider}/${m.id ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(m);
    }
  };
  add(ctx.model);
  for (const source of [registry.getAvailable?.() ?? [], registry.getAll?.() ?? []]) {
    for (const model of source) add(model);
  }
  const errors: string[] = [];
  for (const model of candidates) {
    try {
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        errors.push(auth.error ?? "unknown Codex auth error");
        continue;
      }
      const headers: Record<string, string> = { ...(auth.headers ?? {}) };
      const hasAuth = Object.keys(headers).some(
        (k) => k.toLowerCase() === "authorization",
      );
      if (!hasAuth && auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "user-agent")) {
        headers["User-Agent"] = "pi-codex-usage";
      }
      if (Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
        return headers;
      }
      errors.push("codex auth resolved without credentials");
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length > 0) {
    throw new CodexAuthError(errors.join("; "));
  }
  throw new CodexAuthError(
    "No OpenAI Codex subscription auth available. Use /login for OpenAI ChatGPT Plus/Pro (Codex).",
  );
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Normalize one Codex rate-limit window; `bucket` picks fiveHour vs weekly. */
function normalizeCodexWindow(
  value: unknown,
  fallbackBucket: "fiveHour" | "weekly",
): (UsageWindow & { bucket: "fiveHour" | "weekly" }) | null {
  if (!isRecord(value)) return null;
  let usagePercent = asNumber(value.used_percent);
  if (usagePercent === undefined) {
    const used = asNumber(value.used) ?? asNumber(value.used_tokens) ?? asNumber(value.current);
    const limit = asNumber(value.limit) ?? asNumber(value.limit_tokens) ?? asNumber(value.capacity);
    if (used === undefined || limit === undefined || limit <= 0) return null;
    usagePercent = (used / limit) * 100;
  }
  let resetInSec: number | undefined = asNumber(value.reset_after_seconds);
  if (resetInSec === undefined) {
    const resetAt = asNumber(value.reset_at);
    if (resetAt !== undefined) resetInSec = resetAt - Date.now() / 1000;
  }
  if (resetInSec === undefined) resetInSec = 0;
  const windowSeconds = asNumber(value.limit_window_seconds);
  let bucket = fallbackBucket;
  if (windowSeconds !== undefined && windowSeconds > 0) {
    bucket = windowSeconds <= 6 * 60 * 60 ? "fiveHour" : "weekly";
  }
  return { usagePercent, resetInSec, bucket };
}

function normalizeHint(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function extractCodexUsage(payload: unknown, modelHint?: string): CodexUsage {
  const usage: CodexUsage = { fiveHour: null, weekly: null, weeklySpark: null };
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) return usage;
  const base = payload.rate_limit;
  const additional: unknown[] = [
    ...(Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : []),
    ...(Array.isArray(base.additional_rate_limits) ? base.additional_rate_limits : []),
  ];
  // Prefer an additional rate limit matching the active model (spark
  // models get their own meter), else one labeled codex, else the base.
  const hint = normalizeHint(modelHint);
  let chosen: Record<string, unknown> | null = null;
  let isSpark = false;
  for (const entry of additional) {
    if (!isRecord(entry) || !isRecord(entry.rate_limit)) continue;
    const feature = normalizeHint(entry.metered_feature);
    const name = normalizeHint(entry.limit_name);
    const matches =
      hint.length > 0
        ? feature.includes(hint) || name.includes(hint)
        : feature.includes("codex");
    if (!matches) continue;
    chosen = entry.rate_limit;
    isSpark =
      hint.includes("spark") || feature.includes("spark") || name.includes("spark");
    break;
  }
  if (!chosen) {
    for (const entry of additional) {
      if (!isRecord(entry) || !isRecord(entry.rate_limit)) continue;
      const feature = normalizeHint(entry.metered_feature);
      const name = normalizeHint(entry.limit_name);
      if (feature.includes("codex") || (!hint && name.includes("codex"))) {
        chosen = entry.rate_limit;
        isSpark = feature.includes("spark") || name.includes("spark");
        break;
      }
    }
  }
  const rateLimit = chosen ?? base;
  const assign = (window: unknown, fallbackBucket: "fiveHour" | "weekly"): void => {
    const normalized = normalizeCodexWindow(window, fallbackBucket);
    if (!normalized) return;
    if (normalized.bucket === "fiveHour") {
      if (!usage.fiveHour) usage.fiveHour = normalized;
    } else if (isSpark) {
      if (!usage.weeklySpark) usage.weeklySpark = normalized;
    } else if (!usage.weekly) {
      usage.weekly = normalized;
    }
  };
  assign(rateLimit.primary_window, "fiveHour");
  assign(rateLimit.secondary_window, "weekly");
  return usage;
}

function codexWindows(usage: CodexUsage): Array<UsageWindow & { spark?: boolean }> {
  const windows: Array<UsageWindow & { spark?: boolean }> = [];
  if (usage.fiveHour) windows.push(usage.fiveHour);
  if (usage.weekly) windows.push(usage.weekly);
  if (usage.weeklySpark) windows.push({ ...usage.weeklySpark, spark: true });
  return windows;
}

export async function fetchCodexUsage(ctx: CodexContext): Promise<CodexUsage> {
  const headers = await resolveCodexAuthHeaders(ctx);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CODEX_SCRAPE_TIMEOUT_MS);
  try {
    const response = await fetch(CODEX_USAGE_API_URL, {
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Codex usage endpoint returned ${response.status} ${response.statusText}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Codex usage response was not valid JSON: ${err instanceof Error ? err.message : err}`,
      );
    }
    const modelHint = (ctx.model as { id?: string } | null | undefined)?.id;
    const usage = extractCodexUsage(payload, modelHint);
    if (!usage.fiveHour && !usage.weekly && !usage.weeklySpark) {
      throw new Error("Codex usage endpoint did not include any usable usage window");
    }
    return usage;
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── Antigravity scraper ─────────────────────────

export const ANTIGRAVITY_BASE_URL =
  process.env.PI_USAGE_CHIPS_ANTIGRAVITY_BASE_URL ??
  process.env.ANTIGRAVITY_BASE_URL ??
  "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SCRAPE_TIMEOUT_MS = 10_000;
const ANTIGRAVITY_USER_AGENT =
  "antigravity/cli/1.1.23 (aidev_client; os_type=linux; arch=amd64; cl=974125021; auth_method=consumer)";

export interface AntigravityUsage {
  gemini: UsageWindow | null;
  thirdParty: UsageWindow | null;
}

export class AntigravityAuthError extends Error {}

export function isAntigravityModel(model: unknown): boolean {
  const m = model as { provider?: string; id?: string } | null | undefined;
  if (!m?.provider) return false;
  return m.provider.toLowerCase().startsWith("antigravity");
}

function parseResetTime(resetTime?: string): number {
  if (!resetTime) return 0;
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, (ts - Date.now()) / 1000);
}

function clampFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function extractAntigravityUsage(quotaSummaryData: unknown): AntigravityUsage {
  const usage: AntigravityUsage = { gemini: null, thirdParty: null };
  if (!isRecord(quotaSummaryData) || !Array.isArray(quotaSummaryData.groups)) return usage;

  for (const group of quotaSummaryData.groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    const groupName = String(group.displayName ?? "").toLowerCase();
    const isGemini = groupName.includes("gemini");
    const is3P = groupName.includes("claude") || groupName.includes("gpt") || groupName.includes("3p");

    for (const bucket of group.buckets) {
      if (!isRecord(bucket)) continue;
      const bucketId = String(bucket.bucketId ?? "").toLowerCase();
      const remaining = clampFraction(bucket.remainingFraction);
      if (remaining === undefined) continue;
      const usagePercent = (1 - remaining) * 100;
      const resetInSec = parseResetTime(bucket.resetTime ? String(bucket.resetTime) : undefined);

      if (isGemini || bucketId.includes("gemini")) {
        if (!usage.gemini) usage.gemini = { usagePercent, resetInSec };
      } else if (is3P || bucketId.includes("3p")) {
        if (!usage.thirdParty) usage.thirdParty = { usagePercent, resetInSec };
      }
    }
  }

  return usage;
}

export function extractAntigravityFromModels(modelsData: unknown): AntigravityUsage {
  const usage: AntigravityUsage = { gemini: null, thirdParty: null };
  if (!isRecord(modelsData) || !isRecord(modelsData.models)) return usage;

  for (const [modelId, info] of Object.entries(modelsData.models)) {
    if (!isRecord(info)) continue;
    const qi = isRecord(info.quotaInfo) ? info.quotaInfo : undefined;
    if (!qi) continue;
    const remaining = clampFraction(qi.remainingFraction);
    if (remaining === undefined) continue;
    const usagePercent = (1 - remaining) * 100;
    const resetInSec = parseResetTime(qi.resetTime ? String(qi.resetTime) : undefined);

    const lowerId = modelId.toLowerCase();
    if (lowerId.startsWith("gemini")) {
      if (!usage.gemini) usage.gemini = { usagePercent, resetInSec };
    } else if (lowerId.startsWith("claude") || lowerId.startsWith("gpt")) {
      if (!usage.thirdParty) usage.thirdParty = { usagePercent, resetInSec };
    }
  }

  return usage;
}

interface AntigravityCredentials {
  token: string;
  projectId?: string;
}

export function loadStoredAntigravityAuth(): AntigravityCredentials | null {
  try {
    const authPath =
      process.env.PI_USAGE_CHIPS_AUTH_FILE ?? join(homedir(), ".pi", "agent", "auth.json");
    const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
    const ag = raw.antigravity;
    if (!isRecord(ag)) return null;
    const token = typeof ag.access === "string" ? ag.access.trim() : "";
    if (!token) return null;
    const projectId = typeof ag.projectId === "string" ? ag.projectId.trim() : undefined;
    return { token, projectId };
  } catch {
    return null;
  }
}

async function resolveAntigravityCredentials(ctx: CodexContext): Promise<AntigravityCredentials> {
  const registry = (ctx as { modelRegistry?: unknown }).modelRegistry as
    | {
        getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
        getApiKeyAndHeaders?: (model: unknown) => Promise<{
          ok: boolean;
          apiKey?: string;
          headers?: Record<string, string>;
          error?: string;
        }>;
      }
    | undefined;

  if (registry?.getApiKeyForProvider) {
    try {
      const apiKey = await registry.getApiKeyForProvider("antigravity");
      if (apiKey) {
        try {
          const parsed = JSON.parse(apiKey) as Partial<{ token?: string; projectId?: string }>;
          if (parsed.token) {
            return { token: parsed.token, projectId: parsed.projectId };
          }
        } catch {
          return { token: apiKey };
        }
      }
    } catch {
      // fallback
    }
  }

  if (registry?.getApiKeyAndHeaders) {
    try {
      const auth = await registry.getApiKeyAndHeaders({ provider: "antigravity" });
      if (auth.ok && auth.apiKey) {
        try {
          const parsed = JSON.parse(auth.apiKey) as Partial<{ token?: string; projectId?: string }>;
          if (parsed.token) {
            return { token: parsed.token, projectId: parsed.projectId };
          }
        } catch {
          return { token: auth.apiKey };
        }
      }
    } catch {
      // fallback
    }
  }

  const stored = loadStoredAntigravityAuth();
  if (stored) return stored;

  throw new AntigravityAuthError(
    "No Antigravity credentials found. Log in with /login antigravity.",
  );
}

export async function fetchAntigravityUsage(ctx: CodexContext): Promise<AntigravityUsage> {
  const creds = await resolveAntigravityCredentials(ctx);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANTIGRAVITY_SCRAPE_TIMEOUT_MS);

  const headers = {
    Authorization: `Bearer ${creds.token}`,
    "Content-Type": "application/json",
    "User-Agent": ANTIGRAVITY_USER_AGENT,
  };

  try {
    // 1. Try retrieveUserQuotaSummary
    try {
      const res = await fetch(`${ANTIGRAVITY_BASE_URL}/v1internal:retrieveUserQuotaSummary`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      if (res.ok) {
        const text = await res.text();
        const data = JSON.parse(text) as unknown;
        const usage = extractAntigravityUsage(data);
        if (usage.gemini || usage.thirdParty) {
          return usage;
        }
      }
    } catch {
      // Fall through to fetchAvailableModels
    }

    // 2. Fallback to fetchAvailableModels
    const res = await fetch(`${ANTIGRAVITY_BASE_URL}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ project: creds.projectId ?? "" }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Antigravity endpoint returned ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Antigravity response was not valid JSON: ${err instanceof Error ? err.message : err}`,
      );
    }
    const usage = extractAntigravityFromModels(data);
    if (!usage.gemini && !usage.thirdParty) {
      throw new Error("Antigravity endpoint did not include any usable quota window");
    }
    return usage;
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── extension ─────────────────────────

interface CodexContext {
  model?: { provider?: string; id?: string } | null;
  modelRegistry?: unknown;
  [key: string]: unknown;
}

type ProviderId = "go" | "codex" | "antigravity";

function providerOf(model: unknown): ProviderId | null {
  const m = model as { provider?: string; id?: string } | null | undefined;
  if (!m?.provider) return null;
  const provider = m.provider.toLowerCase();
  if (provider.startsWith("opencode-go")) return "go";
  if (isCodexModel(m)) return "codex";
  if (isAntigravityModel(m)) return "antigravity";
  return null;
}

export default function extension(pi: {
  events: { emit(channel: string, data: unknown): void };
  on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>): void;
}): void {
  const caches: Record<ProviderId, { lastFetch: number; data: unknown | null }> = {
    go: { lastFetch: 0, data: null },
    codex: { lastFetch: 0, data: null },
    antigravity: { lastFetch: 0, data: null },
  };

  function emit(payload: Record<string, unknown>): void {
    try {
      pi.events.emit(BUS_CHANNEL, { source: "usage-chips", timestamp: Date.now(), ...payload });
    } catch {
      // The bus is shared — never let a chip update break a sibling listener.
    }
  }

  function clearChip(id: string): void {
    emit({ id, state: "cleared", label: "" });
  }

  function clearAll(): void {
    clearChip(CHIP_GO);
    clearChip(CHIP_CODEX);
    clearChip(CHIP_ANTIGRAVITY);
  }

  /** Emit one usage chip whose visible row rides in `icon` (verbatim,
   *  untruncated) with an invisible label — see the module docstring. */
  function emitUsageChip(
    id: string,
    windows: Array<UsageWindow & { spark?: boolean }>,
  ): void {
    if (windows.length === 0) {
      clearChip(id);
      return;
    }
    emit({
      id,
      state: "active",
      icon: windows.map((w) => pctText(w, w.spark ? "S" : "")).join(" "),
      label: ANSI_RESET,
      level: levelFor(Math.max(...windows.map((w) => w.usagePercent))),
      detail:
        windows
          .map((w) => `${formatPercent(w.usagePercent)}% used, resets in ${compactDuration(w.resetInSec)}`)
          .join(" / "),
    });
  }

  function emitError(id: string, label: string, message: string): void {
    // state "error" replaces the provider's usage chip in-place and is
    // sticky until the next refresh — do not clear it afterwards.
    emit({ id, state: "error", icon: ICON_NONE, label, detail: message });
  }

  async function refresh(provider: ProviderId, ctx: unknown): Promise<void> {
    const cache = caches[provider];
    try {
      if (provider === "go") {
        if (!isGoConfigured()) return;
        const now = Date.now();
        if (!cache.data || now - cache.lastFetch >= COOLDOWN_MS) {
          cache.lastFetch = now;
          cache.data = await fetchGoUsage();
        }
        const usage = cache.data as GoUsage;
        const windows = [usage.rolling, usage.weekly, usage.monthly].filter(
          (w): w is UsageWindow => w !== null,
        );
        emitUsageChip(CHIP_GO, windows);
      } else if (provider === "codex") {
        const now = Date.now();
        if (!cache.data || now - cache.lastFetch >= COOLDOWN_MS) {
          cache.lastFetch = now;
          cache.data = await fetchCodexUsage(ctx as CodexContext);
        }
        emitUsageChip(CHIP_CODEX, codexWindows(cache.data as CodexUsage));
      } else {
        const now = Date.now();
        if (!cache.data || now - cache.lastFetch >= COOLDOWN_MS) {
          cache.lastFetch = now;
          cache.data = await fetchAntigravityUsage(ctx as CodexContext);
        }
        const usage = cache.data as AntigravityUsage;
        const windows = [usage.gemini, usage.thirdParty].filter(
          (w): w is UsageWindow => w !== null,
        );
        emitUsageChip(CHIP_ANTIGRAVITY, windows);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (provider === "go") {
        emitError(CHIP_GO, "Go usage failed", message);
      } else if (provider === "codex") {
        const authMissing = err instanceof CodexAuthError;
        emitError(
          CHIP_CODEX,
          authMissing ? "Codex auth error" : "Codex error",
          message,
        );
      } else {
        const authMissing = err instanceof AntigravityAuthError;
        emitError(
          CHIP_ANTIGRAVITY,
          authMissing ? "Antigravity auth error" : "Antigravity error",
          message,
        );
      }
    }
  }

  async function refreshActive(model: unknown, ctx: unknown): Promise<void> {
    const provider = providerOf(model);
    if (!provider) return;
    await refresh(provider, ctx);
    if (provider !== "go") clearChip(CHIP_GO);
    if (provider !== "codex") clearChip(CHIP_CODEX);
    if (provider !== "antigravity") clearChip(CHIP_ANTIGRAVITY);
  }

  pi.on("session_start", async (_event, ctx) => {
    await refreshActive((ctx as CodexContext).model, ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    const model = (event as { model?: unknown } | null)?.model;
    if (providerOf(model)) {
      await refreshActive(model, ctx);
    } else {
      clearAll();
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const provider = providerOf((ctx as CodexContext).model);
    if (provider) await refresh(provider, ctx);
  });

  pi.on("session_shutdown", async () => {
    clearAll();
  });
}
