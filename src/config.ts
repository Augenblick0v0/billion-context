import { defaultConfig, DEFAULT_CCR_CONFIG, type Config, type Prompts } from "acp-kernel";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFile } from "./paths.js";
import { log as loggerLog } from "./logger.js";
import { validateHttpProxy, type ProxyFallbackOptions } from "./upstream-proxy.js";
import { maskUrlForLog } from "./log-mask.js";
import { resolveOutputHeadroomCap } from "./util.js";

import { parseCompatRoles } from "./compat-roles.js";
import type { ImageBillingMode } from "./image-tokens.js";
import type { ReasoningGuardConfig } from "./reasoning-guard.js";
import type { OutputSteeringConfig } from "./output-steering.js";

export function safeReadJson(path: string): unknown {
    try {
        // Strip a leading UTF-8 BOM: Windows Notepad saves UTF-8 "with BOM",
        // and JSON.parse("\uFEFF...") throws SyntaxError, silently dropping
        // the whole config file.
        const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
        return JSON.parse(raw);
    } catch (e) {
        // Surface config parse failures instead of silently swallowing them;
        // a malformed providers file would otherwise run the proxy with
        // defaults and the user would not know why routing is wrong.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            loggerLog("error", `[acp-config] failed to parse ${path}: ${String(e)}`);
        }
        return undefined;
    }
}

/** Each upstream URL may declare per-model context/output limits, mirroring the
 *  structure agents like opencode carry in their own model registry. This is
 *  the source of truth for the proxy: the LLM `/models` endpoint does NOT
 *  return context windows (verified across OpenAI/Anthropic/zhipu/comfly),
 *  so the proxy cannot discover them at runtime — the user must declare them.
 */
export type ProviderRoute = {
    models?: Record<string, ModelEntry>;
    /** Per-URL upstream HTTP proxy. Overrides the global `proxy`. Empty string
     *  means "explicitly direct" (override global with no proxy). Format:
     *  `http://host:port`. SOCKS5 is not supported yet. */
    proxy?: string;
    /** Per-URL Responses compress protocol. "marker" = text-trigger protocol
     *  (for upstreams that cannot coexist with a declared tools field).
     *  Default / "tools" = native function tools. */
    compressProtocol?: "tools" | "marker";
    /** Per-provider compression overrides (level 2 of 3). See CompressSettings. */
    compress?: CompressSettings;
    /** Per-provider wire-compat overrides. `roles` maps message roles to the
     *  role name this upstream accepts (e.g. `"developer": "system"`) —
     *  applied at the forward boundary to the FINAL wire body, covering
     *  client-sent roles and bili's own injected prompt alike (#552). Wins
     *  per key over the global `compat` block. */
    compat?: { roles?: Record<string, string> };
    /** Route-scoped passthrough (#661): same semantics as the global
     *  `passthrough` flag, but only for requests whose upstream URL matches
     *  this route — request body forwarded byte-for-byte (no kernel
     *  round-trip, no render tags, no re-serialization), response piped
     *  verbatim, no session state. For upstreams whose anti-cheat fingerprints
     *  the request body (e.g. ZCode 405/3012). */
    passthrough?: boolean;
    /** Client-side routing exemption (#1622): this upstream never gets pointed
     *  through bili at all. Store-rewriting native lanes (zcode today) skip
     *  matching entries instead of wrapping them, so traffic flows
     *  client→upstream untouched — unlike `passthrough`, which still
     *  terminates at the proxy. Matched by the same longest-URL-prefix rule
     *  as every other provider field, so it is generic across lanes (an MITM
     *  lane could honor it by skipping interception for the domain). */
    direct?: boolean;
    /** Per-provider image billing mode (#767): "bytes" = ceil(base64/4)
     *  (conservative, matches byte-counting relays); "pixels" = dimension-
     *  based tile estimate (matches first-party pixel-tile upstreams);
     *  "auto" (default) classifies known first-party pixel hosts. Wins over
     *  the global `imageBilling` (env BILI_IMAGE_BILLING retired in #1714). */
    imageBilling?: ImageBillingMode;
};
export type ProviderRoutes = Record<string, ProviderRoute>; // key = upstream URL prefix (the /bili/<this> string)

/** Per-model declaration under a provider route. `context` / `output` are the
 *  legacy fields; `compress` is the level-3 override (deepest, highest priority). */
export type ModelEntry = {
    context?: number;
    output?: number;
    /** Per-model compression overrides (level 3 of 3, wins over provider
     *  and global). See CompressSettings. */
    compress?: CompressSettings;
};

/** User-facing compression tuning. Configurable at three levels — global
 *  (config root `compress`), per-provider (`providers[url].compress`), per-model
 *  (`providers[url].models[model].compress`) — merged deepest-field-wins by
 *  {@link mergeCompress} (child covers parent, per field, not whole-object). Every
 *  field is optional; unset fields fall through to the kernel default. */
export type CompressSettings = {
    /** Effective context window used by the compression engine — this is the
     *  model's context size. It is the **denominator** the kernel uses for its
     *  usage ratio (`usage = tokens / modelContextLimit`); it is NOT a
     *  truncation cap. Accepts two forms:
     *  - **absolute** (`number`): exact token budget, e.g. `200000`.
     *  - **percentage** (`string` like `"70%"`): a fraction of the model's
     *    native window (from the built-in table / models.dev registry).
     *  When unset at every level, the default is the model's **native window**.
     *  Highest-priority source for the model limit; overrides the built-in
     *  table / registry and the legacy `modelContextLimit` / per-model
     *  `context`. See {@link resolveContextLimitValue}. */
    modelContextLimit?: number | string;
    /** Cap on the output-headroom reservation as a fraction of the context
     *  window: reserved = min(max_tokens, pct × window), so the kernel's
     *  nudge/truncate bands sit below (window − reserved). Accepts a ratio
     *  (0.25) or percent string ("25%"). Default: 0.25 (aligned with
     *  billion-context-pi #207). Set 0 to disable the reservation entirely;
     *  >= 1 restores the legacy full-capability reservation (input + a response
     *  using its ENTIRE output budget always fits — what strict backends like
     *  SGLang/vLLM enforce). A reply longer than the reservation overflows
     *  once; the overflow self-heal recovers it next turn (#896). Negative or
     *  unparseable values reject the whole compress block. Anthropic wire is
     *  exempt (its input limit is enforced independently of max_tokens). */
    outputHeadroomMaxPct?: number | string;
    /** Context usage percentage that triggers forced compression nudges
     *  (bypasses growth-gate + cadence). Accepts a ratio (0.75) or percent
     *  string ("75%"). Maps to kernel `nudge.maxContextLimitPct`. */
    maxContextLimit?: number | string;
    /** Context usage percentage that triggers emergency truncation of large
     *  tool outputs. Accepts a ratio (0.95) or percent string ("95%"). Must
     *  be >= maxContextLimit. Maps to kernel `nudge.emergencyThresholdPct` +
     *  `truncate.threshold`. */
    emergencyThresholdPercent?: number | string;
    /** Nudge growth magnitude in tokens — a compression nudge fires roughly
     *  every time this many tokens become compressible. Flattens the kernel's
     *  adaptive band to a fixed step (sets both `nudge.growthFloor` and
     *  `nudge.growthCap`). */
    nudgeGrowthTokens?: number;
    /** Trailing messages never offered for compression
     *  (kernel `preserveRecentMessages`). */
    preserveRecentMessages?: number;
    /** Token budget reserved for recent messages (kernel `preserveRecentTokens`). */
    preserveRecentTokens?: number;
    /** Minimum compressible range size, in CHARACTERS (not tokens); smaller
     *  ranges are skipped. English/code averages ~4 chars per token, CJK
     *  ~1-2 chars per token, so the same number is ~4× more permissive for
     *  English text than a token-based reading. Maps to kernel
     *  `compress.minCompressRange` (default 5000 chars). */
    minCompressRangeChars?: number;
    /** Deprecated alias of {@link minCompressRangeChars} kept for backward
     *  compatibility. When both keys are set at the same level the new name
     *  wins; across levels the deeper level wins regardless of which name it
     *  uses. */
    minCompressRange?: number;
    /** Enable multi-tier (T2/T3) distillation (kernel `tiers.enabled`). */
    tiers?: boolean;
    /** Tool-name patterns whose LATEST tool-call + paired result are never
     *  compressed (kernel `protectedLatestTools`, acp-kernel >= 0.0.80).
     *  Built for cumulative-snapshot tools (e.g. a client's todo/task list):
     *  every newer result supersedes the older ones, so only the newest
     *  instance is the source of truth — protecting ALL of them (via
     *  `protectedTools`) would make that tool's history grow unboundedly,
     *  while protecting the LATEST keeps the live snapshot in context and
     *  lets every superseded instance fold normally. Patterns match like
     *  kernel tool patterns (exact name or `*` glob, e.g. `"todo_list"`,
     *  `"TodoWrite"`, `"todo*"`). Protection is a HARD exclusion: neither
     *  suggested nor explicit compress ranges can cover the latest instance.
     *  Deepest level wins (global → provider → model), whole-array replace.
     *  Default: none — opt in per client/agent, since tool names are
     *  client-specific. */
    protectedLatestTools?: string[];
    /** Tool-name patterns whose tool-calls AND paired results are NEVER
     *  compressed — every instance, full history (kernel `protectedTools`,
     *  hard exclusion: matching refs render as `BLOCKED`, so neither suggested
     *  nor explicit compress ranges can cover them; applies identically in
     *  both compression modes and on every wire). Built for low-frequency,
     *  high-value tools whose instances are INDEPENDENT content rather than
     *  cumulative snapshots (e.g. opencode/pi `skill` loads, one-shot
     *  references): each load carries unique information that no later result
     *  supersedes, so folding older loads loses it permanently (#1109).
     *  ⚠ Trade-off (#639 rationale): protecting ALL instances of a chatty or
     *  cumulative-snapshot tool makes its history grow unboundedly — use
     *  `protectedLatestTools` for those instead. Patterns match like kernel
     *  tool patterns (exact name or `*` glob, e.g. `"skill"`, `"skill_*"`).
     *  Deepest level wins (global → provider → model), whole-array replace.
     *  Default: none — opt in per client/agent, since tool names are
     *  client-specific. */
    protectedTools?: string[];
    /** Tool-name patterns EXCLUDED from the soft-protected recent zone —
     *  matching tool results inside the recent zone become compressible
     *  immediately instead of aging out first (kernel
     *  `neverPreserveRecentTools`, acp-kernel >= 0.0.92). The kernel default
     *  is `["decompress", "search_context", "read", "bash"]`: read/bash are
     *  the largest reclaimable mass, so fresh results SHOULD re-enter the
     *  foldable pool right away. Removing a pattern (recommended: only
     *  `read`, → `["decompress", "search_context", "bash"]`) keeps freshly
     *  read files inside the recent zone so batch-read workflows stop hitting
     *  the fold→re-read death loop (#1198/#1277) — the results age out of the
     *  zone by position later instead of being pinned forever (unlike
     *  `protectedLatestTools`). Keep `decompress`/`search_context` excluded:
     *  re-including them pins just-restored blocks in the recent zone where
     *  they become unreclaimable — a different disease (#1277 owner note).
     *  ⚠ Empty array `[]` is VALID and excludes nothing (max-protection
     *  escape hatch); unlike `protectedTools`/`protectedLatestTools` an empty
     *  array is not rejected. Unset → kernel built-in default list. Patterns
     *  match like kernel tool patterns (exact name or `*` glob). Deepest
     *  level wins (global → provider → model), whole-array replace. */
    neverPreserveRecentTools?: string[];
    /** Tool-name patterns REMOVED from the effective recent-zone exclusion
     *  list — the positive-facing knob: "protect these tools in the recent
     *  zone" without restating the built-in list (kernel
     *  `preserveRecentTools`, acp-kernel >= 0.0.93). Effective exclusion =
     *  `(neverPreserveRecentTools ?? kernel built-in) minus
     *  preserveRecentTools`, so the #1198/#1277 batch-read fold→re-read
     *  remedy is a one-entry `[
     *  "read"]` that keeps following built-in list evolution — no hand-copied
     *  list to go stale. Composable with an explicit `neverPreserveRecentTools`
     *  (subtraction applies to it too). Unset/empty = no subtraction — NOT
     *  the protect-everything hatch (that is `neverPreserveRecentTools: []`).
     *  Patterns match like kernel tool patterns (exact name or `*` glob).
     *  Deepest level wins (global → provider → model), whole-array replace. */
    preserveRecentTools?: string[];
    /** Emit 📦/❌ ACP visibility markers after proxy tool executions
     *  (compress / decompress / search_context / acp_status) — both the marker
     *  line streamed to the client and the marker message re-injected into
     *  rebuilt history. `false` suppresses them entirely, for deployments where
     *  models imitate or narrate around the markers (#862). Default `true`. */
    visibilityMarkers?: boolean;
    /** Override the kernel's compression prompt text (compressPhilosophy /
     *  howToCompressRules / tier2DistillRules / tier3CondenseRules). All four
     *  fields are LOAD-BEARING: the kernel rules were tuned in production and
     *  overriding them can degrade summary quality (lost paths / signatures /
     *  decisions → broken retrieval). Ignored unless `acknowledgePromptsRisk`
     *  resolves to `true` after the merge (the flag merges independently,
     *  deepest defined level wins — no co-location with this block required).
     *  Same three-level merge as the other
     *  fields, but the object is merged via kernel `resolvePrompts` (non-string
     *  fields silently dropped), not a raw pass-through. */
    prompts?: Partial<Prompts>;
    /** Must be true for `prompts` overrides to take effect. Acknowledges the
     *  summary-quality risk documented on `prompts`. */
    acknowledgePromptsRisk?: boolean;
    /** Named prompt pack (kernel pack registry): a curated surface preset —
     *  tool descriptions, system-prompt sections, nudge sections — resolved
     *  from [project `./.billion-context/packs` > user `<configDir>/packs` >
     *  builtin (`default`, `lean`)]. Deepest-wins like every other field;
     *  unknown names fall back to the identity surface. Kernel >= 0.0.66. */
    promptPack?: string;
    /** Instant tool-result absorption (kernel absorb API, acp-kernel >= 0.0.54).
     *  When `enabled`, eligible large tool results carry a forced [ACP absorb]
     *  instruction and the model distills them via the injected `absorb` tool;
     *  the original output is then hidden from every wire view until the next
     *  fold round (and its token cost is netted out of usage credits, like
     *  compress). Maps to kernel `Config.absorb`. Off unless explicitly
     *  enabled at some level. NOT supported on Responses marker/text-protocol
     *  routes (no native tool surface there). */
    absorb?: {
        /** Enable absorb for this scope. Absent/false = off (kernel semantics). */
        enabled?: boolean;
        /** Tool results smaller than this many tokens never get the absorb
         *  instruction (kernel default 1000). */
        minToolTokens?: number;
        /** Only emit instructions once context usage reaches this fraction of
         *  the model window (kernel `contextThresholdPct`). Accepts a ratio
         *  (0.5) or percent string ("50%"); 0 = size gate alone (kernel
         *  default). */
        contextThresholdPct?: number | string;
        /** Tool names whose results are never absorbable (glob-suffix
         *  patterns, e.g. "read"). Kernel default: none. */
        excludeTools?: string[];
        /** Rename the wire tool (default "absorb"). Must stay unique against
         *  the client's own tool names or the agent will call its own tool. */
        toolName?: string;
    };
    /** [#1097] Kernel CCR content store (kernel `Config.ccr`, acp-kernel
     *  0.0.84). When `enabled`, oversized tool results (>= minToolTokens) are
     *  ID-referenced at arrival by the kernel's ccr-store node (prune →
     *  ccr-store → absorb): the wire keeps a deterministic `[acp-stored` …
     *  placeholder and the original goes into the session's kernel
     *  `MessageContentStore`, retrievable via the injected retrieve tool.
     *  Lossless by default — a retrieve not made costs one cheap tool call,
     *  whereas a distilled-away detail is gone for good. ID-reference wins
     *  over absorb (kernel ordering). Off unless explicitly enabled at some
     *  level. Merged sub-field-wise across the three levels like `absorb`. */
    ccr?: {
        /** Enable CCR for this scope. Absent/false = off (kernel semantics). */
        enabled?: boolean;
        /** Tool results smaller than this many tokens stay verbatim
         *  (kernel default 4000). */
        minToolTokens?: number;
        /** Tool-name patterns (glob suffix allowed) never CCR-stored
         *  (kernel default: none). */
        excludeTools?: string[];
        /** Rename the retrieve tool (default "acp_retrieve"). Must stay unique
         *  against the client's own tool names. */
        toolName?: string;
        /** Max characters for the placeholder head/command preview (kernel
         *  default 96). */
        maxHeadChars?: number;
    };
    /** [#1336] Planning-aware retrieval: when `planAware` is true,
     *  search_context re-ranks its candidate blocks against the session's
     *  current todo/task state (the latest protectedLatestTools snapshot in
     *  context plus the most recent user turn) and appends a short steering
     *  section to the result. Pure host-side policy — the kernel's lexical
     *  candidate surface, the content store, folding and injection mechanics
     *  are all reused unchanged. Disabled or no plan state in context ⇒
     *  byte-identical output to the plain lexical ranking. Off by default;
     *  measure before enabling in shared configs. Merged sub-field-wise across
     *  the three levels like `absorb`/`ccr`. See src/decompress-shared.ts. */
    search?: {
        /** Enable plan-aware re-ranking + steering for search_context.
         *  Absent/false = off (byte-identical output). */
        planAware?: boolean;
    };
    /** [#1095] Image pre-compression (kernel `Config.imageCompression`,
     *  acp-kernel >= 0.0.84). When `enabled`, screenshot-like images in tool
     *  results are downscaled ONCE at arrival before entering the wire
     *  (kernel routing decision + recipe, host executes with optional `sharp`);
     *  non-screenshot originals pass through byte-identical. Lossy by nature —
     *  backstopped by the injected `image_full` tool: the model requests the
     *  original resolution for a ref and it applies for the rest of the
     *  session (originals cached in memory). Off unless explicitly enabled at
     *  some level; disabled ⇒ byte-identical pass-through. Merged sub-field-wise
     *  across the three levels like `absorb`/`ccr`. */
    imageCompression?: {
        /** Enable image pre-compression for this scope. Absent/false = off
         *  (byte-identical pass-through). */
        enabled?: boolean;
        /** Only route images whose token estimate >= this (kernel default
         *  512). */
        minTokens?: number;
        /** Longest side (px) of the downsample recipe (kernel default 1280). */
        maxDimension?: number;
        /** Lossy encode quality 1-100 of the downsample recipe (kernel
         *  default 80). */
        quality?: number;
        /** Encode format of the downsample recipe (kernel default "webp"). */
        format?: "webp" | "jpeg" | "png";
    };
    /** Persistent rule reminders (kernel `Config.rules`, acp-kernel >= 0.0.70).
     *  When `enabled`, an `acp_rule` tool is injected (or advertised in the
     *  plugin manifest): passing a short `rule` records a principle-level
     *  reminder that is hard-protected from compression and stays in context
     *  for the life of the session; omitting the argument lists recorded
     *  rules for human review. `delete` removes one rule by id, `clear: true`
     *  removes all (#1399: the model has full rights over session rules and
     *  may call any of these unprompted). The feature deliberately adds NO
     *  system-prompt content (all guidance rides in the tool description).
     *  Maps to kernel `Config.rules = { enabled }`. Off unless explicitly
     *  enabled at some level. Deepest-wins like every other scalar field. */
    rules?: boolean;

    /** Opt-in removal of historical image payloads, executed by the kernel's
     *  wire-layer primitive `stripHistoricalImages` from "acp-kernel/wire"
     *  (kernel #215; host-side policy only). When true, every message except
     *  the most recent {@link stripImagesKeepRecent} has its image parts dropped
     *  before the wire rebuild (image-only content collapses to an "[image]"
     *  placeholder). Off by default — the #488 image floor / overflow 502 stays
     *  the opt-in signal until this is enabled. */
    stripImages?: boolean;
    /** With {@link stripImages}, how many trailing messages keep their images
     *  verbatim (default 5). Ignored unless stripImages is true. */
    stripImagesKeepRecent?: number;
    /** [#651] Drop oversized reasoning (thinking) from closed-turn `compress`
     *  tool calls at request time (src/reasoning-drop.ts, aligned with
     *  billion-context-pi #336/#339 and opencode-acp #377). Compress turns
     *  are hard-exempt from compression, so their reasoning is otherwise an
     *  unreclaimable context floor. Merged sub-field-wise across the three
     *  config levels like `absorb`. */
    reasoning?: {
        /** Master switch (default true). Set `drop: false` per-provider for
         *  models whose reasoning must round-trip unmodified. */
        drop?: boolean;
        /** A closed turn's reasoning run must exceed this many chars to be
         *  dropped (default 2048). */
        threshold?: number;
    };
    /** [#739] Opt-in guard against gpt-5.x/gpt-6.x "lattice" reasoning truncation
     *  (reasoning stops at exactly base*n+offset tokens, default 518n-2 -> 516,
     *  1034, ..., mid-thought). When engaged on a matched-model terminal round that
     *  hits the lattice AND carries an encrypted_content blob, bili buffers the
     *  response, replays its own reasoning plus a continue nudge (up to maxContinue
     *  rounds), and folds to ONE response with true summed usage. Merged sub-field-wise
     *  across the three levels like `absorb`/`reasoning`; off unless enabled at some
     *  level. See src/reasoning-guard.ts. */
    reasoningGuard?: ReasoningGuardConfig;
    /** [#1093] Output-side compression levers — verbosity steering (a conciseness
     *  directive appended to the system-prompt tail) and effort routing (clamp an
     *  already-sent effort field down on mechanical continuation turns). Resolved
     *  through this same three-level cascade; sub-fields are validated by the
     *  kernel's resolveOutputSteeringConfig at resolution time (an out-of-range value
     *  falls back to its default with a warning rather than rejecting the whole block).
     *  Off unless enabled at some level. See src/output-steering.ts. */
    outputSteering?: Partial<OutputSteeringConfig>;
    /** [#1279] Price profile for the session cache-economics report
     *  (`acp_cache` / `/acp-cache` / `GET /__bili/cache-report`). Normalized
     *  multipliers over the input-token unit (p_in = 1): `w` = cacheWrite/input,
     *  `r` = cacheRead/input, `q` = output/input — e.g. Anthropic ≈ {w:1, r:0.1,
     *  q:4}, DeepSeek-V3 ≈ {w:1, r:0.1, q:1.5}. Drives ONLY the per-fold
     *  one-time-cost / breakeven-turns / paid-back verdicts in the report — it
     *  never affects compression triggers, cadence, or any wire behavior. Each
     *  unset field falls back to the kernel default (w=1, r=0.1, q=4); a fully
     *  unset profile yields byte-identical reports to pre-#1279 behavior. The
     *  last request's effective value is stamped onto the session and used by
     *  every report face. Merged sub-field-wise across the three levels like
     *  `absorb`. */
    priceProfile?: { w?: number; r?: number; q?: number };
};
export type PromptCacheRouting = "auto" | "enabled" | "disabled";
export type UpstreamProxyMode = "auto" | "manual" | "direct";

/** Built-in context window for common model families, keyed by a lowercase
 *  prefix. This is a FALLBACK used when the per-route model declaration in
 *  providers.json does not cover a model. The per-route declaration (which
 *  the user controls) always wins, because the same model name can have
 *  different windows behind different relays. Generic family guesses (no
 *  specific known window) default to 200k, not 128k — a too-small guess
 *  strands the session in the preflight fail-fast loop while a too-large
 *  one self-heals on the first upstream overflow (#852). */
const CONTEXT_LIMIT_TABLE: Array<{ match: RegExp; limit: number }> = [
    { match: /^claude-/i, limit: 200_000 },
    { match: /^gpt-5/i, limit: 400_000 },
    { match: /^gpt-4\.1/i, limit: 1_000_000 },
    { match: /^gpt-4o/i, limit: 128_000 },
    { match: /^gpt-4-turbo/i, limit: 128_000 },
    { match: /^o[13]-/i, limit: 200_000 },
    { match: /^gemini-3/i, limit: 1_048_576 },
    { match: /^gemini-2\.5/i, limit: 1_000_000 },
    { match: /^gemini-1\.5/i, limit: 1_000_000 },
    { match: /^glm-4\.6/i, limit: 128_000 },
    { match: /^glm-5/i, limit: 1_000_000 },
    { match: /^glm-/i, limit: 200_000 },
    // DeepSeek: flagship line (chat/reasoner/v4*/flash) is 1M on models.dev; only legacy r1/v3/ocr stay ~128k (#852).
    { match: /^deepseek-(r1|v3|ocr)/i, limit: 128_000 },
    { match: /^deepseek/i, limit: 1_000_000 },
    { match: /^minimax/i, limit: 204_800 },
    { match: /^qwen/i, limit: 200_000 },
    { match: /^kimi/i, limit: 200_000 },
    { match: /^llama-/i, limit: 200_000 },
];

// Relay/vLLM deployments serve models under "prefix/name" ids that miss
// every ^-anchored pattern ("meta-llama/Llama-4" vs /^llama-/i). Try the bare
// basename too; the full name keeps precedence (#736).
function modelRoots(model: string): string[] {
    const roots = [model];
    const slash = model.lastIndexOf("/");
    if (slash > 0 && slash < model.length - 1) roots.push(model.slice(slash + 1));
    return roots;
}

export function lookupContextLimit(model: string | undefined): number | undefined {
    if (!model) return undefined;
    for (const root of modelRoots(model)) {
        for (const entry of CONTEXT_LIMIT_TABLE) {
            if (entry.match.test(root)) return entry.limit;
        }
    }
    return undefined;
}

// #1321: model families where ONE id serves multiple context tiers and the
// larger tier requires explicit per-request negotiation — Anthropic's
// context-Nm beta header or an [Nm]-suffixed model name. models.dev
// advertises the MAX tier, but a plain plan serves the standard window until
// that negotiation happens; budgeting against the advertised max pushes every
// percentage threshold beyond the client's own wall (#1310 item 2 → #1321).
// The proxy caps registry-derived windows at the built-in standard window for
// these families when no tier evidence is present. Every other family keeps
// fresher-source-wins (#344/#852): a stale-low table entry must never pin a
// grown registry window.
const TIER_GATED_FAMILIES: Array<{ match: RegExp }> = [
    { match: /^claude-/i },
];

export function tierGatedStandardWindow(model: string | undefined): number | undefined {
    if (!model) return undefined;
    for (const root of modelRoots(model)) {
        if (!TIER_GATED_FAMILIES.some((fam) => fam.match.test(root))) continue;
        for (const entry of CONTEXT_LIMIT_TABLE) {
            if (entry.match.test(root)) return entry.limit;
        }
    }
    return undefined;
}

/** Floor for the EFFECTIVE context window (after output-headroom reservation)
 *  when the window came from a low-confidence fallback — the built-in table
 *  above or the env default — rather than an authoritative source (plugin
 *  report, launcher declaration, models.dev registry, per-route config). Fallback values are guesses, and the two error
 *  directions are asymmetric: a too-small guess strands the session on a
 *  permanent compression treadmill (issue #282: 128k table value − 64k
 *  max_tokens → 64k effective for a 1M-window model), while a too-large guess
 *  self-heals on the first upstream overflow. */
export const FALLBACK_EFFECTIVE_WINDOW_FLOOR = 100_000;

/** Resolve the context-window limit for a request. Priority:
 *  1. Per-URL per-model declaration in config (user-controlled, most accurate).
 *     The upstreamUrl is matched against config keys by **longest-prefix wins**
 *     (the key is a string the user wrote, identical to what follows /bili/ in
 *     the zero-config baseURL). A shallow key like "https://open.bigmodel.cn"
 *     matches all paths on that host; a deep key like
 *     "https://open.bigmodel.cn/api/anthropic" matches only that endpoint.
 *  2. Built-in CONTEXT_LIMIT_TABLE (by model name prefix)
 *  Returns undefined if neither matches — caller falls back to the env default. */
export function resolveContextLimit(
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
    model: string | undefined,
): number | undefined {
    return resolveConfiguredContextLimit(routes, upstreamUrl, model) ?? lookupContextLimit(model);
}

/** Longest-URL-prefix match over the providers map. Returns the most specific
 *  ProviderRoute whose key is a prefix of `upstreamUrl`, or undefined. Shared
 *  by context-limit / compress-protocol / compress-settings resolution. */
export function findRoute(routes: ProviderRoutes, upstreamUrl: string | undefined): ProviderRoute | undefined {
    if (!upstreamUrl) return undefined;
    // A key matches if upstreamUrl === key OR upstreamUrl starts with key + "/".
    // The boundary check ("/" or end-of-string) avoids "https://x.com" matching
    // "https://x.com.evil". Longest (most specific) key wins.
    let bestKey = "";
    for (const key of Object.keys(routes)) {
        if (upstreamUrl === key || upstreamUrl.startsWith(key + "/")) {
            if (key.length > bestKey.length) bestKey = key;
        }
    }
    return bestKey ? routes[bestKey] : undefined;
}

export function resolveConfiguredContextLimit(
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
    model: string | undefined,
): number | undefined {
    if (!model || !upstreamUrl) return undefined;
    const m = findRoute(routes, upstreamUrl)?.models?.[model];
    if (m?.context && m.context > 0) return m.context;
    return undefined;
}

/** #924: the operator-declared max OUTPUT of a model (ModelEntry.output,
 *  documented as the model's max output size) — the mirror of
 *  resolveConfiguredContextLimit for the output-headroom fallback chain. When
 *  the request carries no output budget at all (Codex native Responses sends
 *  no max_output_tokens), this outranks the auto-fetched models.dev ceiling —
 *  same order as the window resolution (#344). */
export function resolveConfiguredOutputLimit(
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
    model: string | undefined,
): number | undefined {
    if (!model || !upstreamUrl) return undefined;
    const m = findRoute(routes, upstreamUrl)?.models?.[model];
    if (m?.output && m.output > 0) return m.output;
    return undefined;
}

export function resolveCompressProtocol(routes: ProviderRoutes, upstreamUrl: string | undefined): "tools" | "marker" | undefined {
    return findRoute(routes, upstreamUrl)?.compressProtocol;
}

export type ProxyOptions = {
    port: number;
    host: string;
    upstream: string;
    routes: ProviderRoutes;
    /** Global default upstream HTTP proxy. Per-URL `proxy` overrides this.
     *  Empty string explicitly disables environment/system proxy fallback. */
    proxy?: string;
    proxyMode?: UpstreamProxyMode;
    proxySource?: "web-manual" | "config" | "auto" | "direct";
    proxyFallback?: ProxyFallbackOptions;
    /** Auxiliary-egress fallback (#1012): same shape as proxyFallback but its
     *  env tier is filled from the launcher-forwarded BILI_INHERITED_* vars.
     *  Consumed ONLY by the MITM blind-tunnel resolver — client-side aux
     *  traffic (MCP/web) regains the user's shell proxy, while model egress
     *  keeps the clean-env direct semantics (e1c6c92). */
    auxProxyFallback?: ProxyFallbackOptions;
    modelContextLimit: number;
    kernelConfig: Config;
    /** Global-level compression settings (level 1) — the tuning fields from the
     *  user-facing `compress` block, passed through for per-request resolution
     *  (provider = level 2, model = level 3). `injectTool` / `injectNudge` are
     *  the env-resolved booleans (honored globally only). */
    compress: CompressSettings & {
        injectTool: boolean;
        injectNudge: boolean;
    };
    promptCache: { routing: PromptCacheRouting };
    /** Wire-compat role map (global level; per-provider `compat.roles` overlays
     *  it per key). `{"developer":"system"}` rewrites developer→system on the
     *  forwarded body for upstreams without the developer role (#552). Empty =
     *  byte-for-byte transparent. */
    compat: { roles: Record<string, string> };
    /** #1455: how upstream stream failures are presented to the client on the
     *  anthropic/openai wire — "protocol" (default) = protocol-native error
     *  frames; "completion" = legacy synthesized-completion shape for hosts
     *  whose SDK cannot surface in-band errors. File-only since #1714 — env
     *  BILI_STREAM_ERROR_SHAPE is retired. */
    streamErrorShape: "protocol" | "completion";
    /** Global-level image billing mode (#767); per-provider route entries
     *  override it. undefined = auto. (env BILI_IMAGE_BILLING retired in
     *  #1714.) */
    imageBilling?: ImageBillingMode;
    sessionHeader: string;
    log: boolean;
    debug: boolean;
    dumpSse?: string;
    passthrough: boolean;
    /** Where `passthrough` came from: "file" (config `passthrough: true`) or
     *  null (default off; a --passthrough launch flag also enables it at
     *  runtime while source stays null). Drives the #405 boot warning and the
     *  web panel's source display. (#1714: env ACP_PASSTHROUGH retired.) */
    passthroughSource: "file" | null;
    autoUpdate: boolean;
    /** Opt-in self-restart when a newer version is already installed on disk
     *  (#811): re-exec at zero in-flight requests. Default OFF. */
    autoRestartOnUpdate: boolean;
    /** Dist-tag channel the auto-updater follows (default "latest"). */
    updateTag: string;
    /** Critical-defect advisory watcher (#1481): runs INDEPENDENTLY of
     *  autoUpdate and force-installs the owner-recommended version when the
     *  local version falls inside an affected range. Default ON. */
    advisoryCheck: boolean;
    /** Override for the advisory document URL (file-only since #1714 — env
     *  BILI_ADVISORY_URL retired). */
    advisoryUrl?: string;
    logFile?: string;
    /** MITM transparent-proxy mode. When enabled, an HTTP CONNECT handler is
     *  attached so clients that only know how to set HTTP_PROXY (ZCode with a
     *  locked-in endpoint) can route through the proxy. Whitelisted model
     *  hosts are TLS-terminated locally and fed back into the same request
     *  pipeline; all other hosts are blind-tunnelled. */
    mitm: { enabled: boolean; domains: string[] };
    /** Mask non-public target hosts in proxy logs (#255, default on when
     *  omitted). Opt out for local debugging with `maskHosts: false` (#897);
     *  credential masking stays on either way. (env BILI_LOG_MASK_HOSTS
     *  retired in #1714.) */
    maskHosts?: boolean;
    /** Split Claude Code subagent requests (parent+agent header pair) into
     *  their own session id so they don't queue on the main session's lock
     *  (#970, default on). Opt out with `subagentSplit: false` in the config
     *  file (env BILI_SUBAGENT_SPLIT retired in #1714). */
    subagentSplit?: boolean;
    /** Opt-in fork block-adoption (#629, default off). Anonymous clients
     *  (prefix-affinity) that fork their history inherit the parent's
     *  fully-present compression blocks instead of restarting at zero.
     *  Enable with `forkAdoption: true` (env BILI_FORK_ADOPTION retired in
     *  #1714). */
    forkAdoption?: boolean;
    /** Resume-fork inheritance (#1486, default ON). Identified clients that
     *  resume a conversation under a NEW client-provided session id (Claude
     *  Code --resume forks a fresh UUID while replaying the full transcript)
     *  would otherwise start at zero compression state and renumber refs from
     *  m00001, so the model's stale citations mis-hit renumbered messages.
     *  The proxy detects the resume by byte-exact full-history match against
     *  tracked chains and inherits the parent's ref assignments, its
     *  fully-present compression blocks (when forkAdoption is on), and the
     *  derivedFrom lineage. Disable with `resumeInheritance: false` (env
     *  BILI_RESUME_INHERITANCE retired in #1714). */
    resumeInheritance?: boolean;
    /** Body-content detection of the bili→bili chain awareness: when an inbound
     *  request carries ACP artifacts / a `<bili-chain …/>` checkpoint in the
     *  BODY but no x-bili-hop header, record an advisory observation and/or apply
     *  first-processor-wins passthrough (#1086/#1421). OFF by default (#1683
     *  follow-up): scanning the body can false-positive on CCR/file-introduced
     *  text and model-echoed tags, so by default ONLY the x-bili-hop header drives
     *  chain recognition. Re-enable via `chainContentDetection: true` in the config
     *  file (env BILI_CHAIN_CONTENT retired in #1714). The
     *  x-bili-hop signal is unaffected by this switch. */
    chainContentDetection?: boolean;
    /** Egress emission of the model-visible `<bili-chain …/>` checkpoint
     *  carrier (#1683): when set, every request THIS instance processes leaves
     *  with a digest-bearing stamp so a downstream bili applies first-processor-
     *  wins even if x-bili-hop was stripped in transit (#1421). The carrier
     *  lands in a slot the terminal MODEL also reads (trailing user message on
     *  openai/responses; trailing text part on anthropic/google), so models
     *  treat it as phantom user input and burn tokens commenting on it — hence
     *  OFF by default. Enable it for the narrow multi-bili + hop-header-
     *  stripped-middlebox case via `chainEgressStamp: true` in the config file
     *  (env BILI_CHAIN_STAMP retired in #1714). Independent of
     *  chainContentDetection (inbound body-detection is also default OFF); the
     *  x-bili-hop passthrough is unaffected either way. */
    chainEgressStamp?: boolean;
    /** #1085: freeze the client's head-system text into a per-session sticky
     *  anchor and append detected changes to the conversation as trailing
     *  notes, keeping the forwarded prefix byte-stable for the provider's
     *  prefix cache when instruction files (AGENTS.md & co.) change mid-
     *  session. Default OFF; enable with `stableSystemAnchor: true` in the
     *  config file (env BILI_STABLE_SYSTEM_ANCHOR retired in #1714). */
    stableSystemAnchor?: boolean;
    // #1714: behavior knobs migrated from BILI_*/ACP_* env inputs to config.json.
    upstreamTimeoutMs?: number;
    streamKeepAliveMs?: number;
    replayRetryMax?: number;
    replayRetryBaseMs?: number;
    maxShrinkPerCompress?: number;
    exposureLogIntervalMs?: number;
    preflightHoldMs?: number;
    preflightDeadEndCooldownMs?: number;
    requestWatchdogMs?: number;
    keepAliveTimeoutMs?: number;
    clientErrorBackstopMs?: number;
    ccrRetrievalTtlMs?: number;
    fakeCompletionRetries?: number;
    fakeBufCap?: number;
    maxSessions?: number;
    sessionGc?: boolean;
    sessionGcMaxAgeDays?: number;
    sessionGcMaxTokens?: number;
    sessionGcIntervalMs?: number;
    persistEnabled?: boolean;
    persistDebounceMs?: number;
    persistTailTokens?: number;
    persistZstd?: boolean;
    persistEpermAlertThreshold?: number;
    persistEpermAlertRepeatMs?: number;
    mitmHandshakeTimeoutMs?: number;
    proxyKeepAliveMaxMs?: number;
    zonePort?: number;
    zcodeNativePort?: number;
    decompressTmpCap?: number;
    imageTokenCap?: number;
    dump4xx?: boolean;
    dump4xxMaxBytes?: number;
    sessionsDir?: string;
    tunnelAllowedHosts?: string[];
};

/** Re-read ONLY the routes from the current config sources, returning a fresh
 *  ProviderRoutes object. Used by the web UI's "Apply" (hot-reload) button so
 *  provider/route changes take effect without restarting bili. Only routes are
 *  re-read — port/host/upstream can't change on a running server (the listen
 *  socket is already bound), so those stay as they were at startup. Mirrors the
 *  exact precedence of loadOptions: external ACP_PROVIDERS path > inline
 *  providers in the config file. */
export function loadRoutes(env: NodeJS.ProcessEnv = process.env): ProviderRoutes {
    const fileConfig = loadConfigFile();
    const routes: ProviderRoutes = {};
    const routesPath = env.ACP_PROVIDERS ?? fileConfig.providersPath ?? "";
    if (routesPath) {
        const parsed = safeReadJson(routesPath);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                rejectLegacyRoute(k, v);
                const route = parseRouteEntry(v);
                if (route) routes[normalizeUrlKey(k)] = route;
            }
        }
    }
    if (fileConfig.providers) {
        for (const [k, v] of Object.entries(fileConfig.providers)) {
            rejectLegacyRoute(k, v);
            const route = parseRouteEntry(v);
            if (route && !routes[normalizeUrlKey(k)]) routes[normalizeUrlKey(k)] = route;
        }
    }
    return routes;
}

/** Resolved passthrough state shared by loadOptions and the web config API
 *  (single source of truth — the GET handler must not re-derive it).
 *  File-only since #1714: the ACP_PASSTHROUGH env input is retired. */
export function passthroughState(): { enabled: boolean; source: "file" | null } {
    const filePassthrough = loadConfigFile().passthrough === true;
    return { enabled: filePassthrough, source: filePassthrough ? "file" : null };
}

// #1359: provider/model absorb.* overrides apply only to the proxy lane (plugin
// lane follows the base block). Warn once per load so the divergence isn't silent.
const ABSORB_DIVERGENCE_FIELDS = ["enabled", "toolName", "minToolTokens", "contextThresholdPct", "excludeTools"] as const;
const seenAbsorbDivergenceWarnings = new Set<string>();

function normAbsorbValue(field: string, v: unknown): unknown {
    if (field === "contextThresholdPct" && typeof v === "string") {
        const m = v.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
        if (m) return Number(m[1]) / 100;
    }
    return v;
}

export function findAbsorbPluginDivergences(routes: ProviderRoutes, baseAbsorb?: CompressSettings["absorb"]): string[] {
    const out: string[] = [];
    const check = (scope: string, level?: CompressSettings["absorb"]) => {
        if (!level) return;
        for (const field of ABSORB_DIVERGENCE_FIELDS) {
            if (level[field] === undefined) continue;
            if (JSON.stringify(normAbsorbValue(field, level[field])) !== JSON.stringify(normAbsorbValue(field, baseAbsorb?.[field]))) {
                out.push(`${scope}.absorb.${field}=${JSON.stringify(level[field])} (base=${JSON.stringify(baseAbsorb?.[field])})`);
            }
        }
    };
    for (const [url, route] of Object.entries(routes)) {
        check(url, route.compress?.absorb);
        for (const [model, entry] of Object.entries(route.models ?? {})) check(`${url}/${model}`, entry.compress?.absorb);
    }
    return out;
}

function warnAbsorbPluginDivergences(routes: ProviderRoutes, baseAbsorb?: CompressSettings["absorb"]): void {
    const divs = findAbsorbPluginDivergences(routes, baseAbsorb);
    if (divs.length === 0) return;
    const sig = divs.join("\u0000");
    if (seenAbsorbDivergenceWarnings.has(sig)) return;
    seenAbsorbDivergenceWarnings.add(sig);
    loggerLog("warn", `[acp-config] provider/model absorb override diverges from base [${divs.join("; ")}] — plugin-mode sessions follow the base value, proxy-mode sessions honor the override (#1359)`);
}


/** [#1345] A provider/model-level `ccr` field that diverges from what plugin
 *  sessions actually execute. In plugin mode the static manifest is the ONLY
 *  declaration of the retrieve surface, so the whole ccr block follows the base
 *  config; such overrides only take effect on proxy-mode sessions. */
export interface CcrOverrideDivergence {
    /** Where the override lives, e.g. "provider https://api.x.com" or "provider https://api.x.com model gpt-4". */
    level: string;
    field: "enabled" | "toolName" | "minToolTokens" | "excludeTools" | "maxHeadChars";
    value: unknown;
    effective: unknown;
}

const CCR_FIELDS = ["enabled", "toolName", "minToolTokens", "excludeTools", "maxHeadChars"] as const;

/** Pure: list every provider/model ccr field that would be ignored in plugin
 *  sessions (base config governs there). Empty when base ccr is not enabled —
 *  no plugin session can arm then, so nothing diverges (#1273 keeps
 *  route-scoped-only enablement proxy-mode-only by design). */
export function findCcrPluginDivergences(routes: ProviderRoutes, globalCompress?: CompressSettings): CcrOverrideDivergence[] {
    const base = globalCompress?.ccr;
    if (base?.enabled !== true) return [];
    const out: CcrOverrideDivergence[] = [];
    const report = (level: string, ccr?: CompressSettings["ccr"]): void => {
        if (!ccr) return;
        for (const f of CCR_FIELDS) {
            if (!(f in ccr)) continue;
            const value = ccr[f];
            const effective = base[f] ?? DEFAULT_CCR_CONFIG[f];
            const differs = Array.isArray(value) && Array.isArray(effective)
                ? JSON.stringify(value) !== JSON.stringify(effective)
                : value !== effective;
            if (differs) out.push({ level, field: f, value, effective });
        }
    };
    for (const [url, route] of Object.entries(routes)) {
        report(`provider ${url}`, route.compress?.ccr);
        for (const [model, entry] of Object.entries(route.models ?? {})) {
            report(`provider ${url} model ${model}`, entry.compress?.ccr);
        }
    }
    return out;
}

function formatCcrValue(v: unknown): string {
    return typeof v === "string" ? `"${v}"` : JSON.stringify(v);
}

/** Log every #1345 divergence once per config load (called from loadOptions;
 *  hot-reload funnels through it too — see handleConfigReload). */
function warnCcrPluginDivergences(routes: ProviderRoutes, globalCompress?: CompressSettings): void {
    for (const dv of findCcrPluginDivergences(routes, globalCompress)) {
        loggerLog("warn", `[acp-config] ccr override ignored in plugin sessions: ${dv.level} ccr.${dv.field}=${formatCcrValue(dv.value)} — plugin sessions use ${formatCcrValue(dv.effective)} (base config governs the plugin manifest surface, #1345); proxy-mode sessions honor the override`);
    }

}

export function loadOptions(env: NodeJS.ProcessEnv = process.env): ProxyOptions {
    // --- Source 1: JSON config file (~/.config/billion-context/billion-context.json) ---
    // The canonical, user-editable config. Loaded first so env vars below can
    // override it (env wins for environment-specific overrides).
    const fileConfig = loadConfigFile();

    // --- Source 2: env vars (highest priority) ---
    const port = parseInt(env.ACP_PORT ?? env.PORT ?? `${fileConfig.port ?? 8787}`, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port ${Number.isNaN(port) ? "(not a number)" : port}; must be 1-65535`);
    }
    const rawHost = env.ACP_HOST ?? fileConfig.host ?? "127.0.0.1";
    const host = rawHost === "localhost" ? "127.0.0.1" : rawHost;
    const upstream = (env.ACP_UPSTREAM ?? fileConfig.upstream ?? "https://api.anthropic.com").replace(/\/$/, "");
    const routes = loadRoutes(env);
    warnAbsorbPluginDivergences(routes, fileConfig.compress?.absorb);
    warnCcrPluginDivergences(routes, fileConfig.compress);
    const passthrough = passthroughState();
    const modelContextLimit = parseInt(`${fileConfig.modelContextLimit ?? 200000}`, 10);
    const webProxy = nonEmpty(fileConfig.upstreamProxy);
    const configProxy = nonEmpty(fileConfig.proxy);
    // #1714: BILI_UPSTREAM_PROXY / BILI_UPSTREAM_PROXY_MODE retired — file fields only.
    const rawProxyMode = fileConfig.upstreamProxyMode ?? (webProxy ? "manual" : undefined);
    // Unset mode means "direct" (matches the web UI's 直连（默认） and ZCode's
    // default), NOT auto-detect. To follow the system/env proxy, set mode "auto".
    const effectiveMode = rawProxyMode ?? "direct";
    const proxyMode = parseUpstreamProxyMode(effectiveMode);
    // explicitDirect short-circuits an EMPTY global proxy to "direct" (instead of
    // env/system auto-detect). True for the unset-defaults-to-direct case and
    // explicit "direct" mode (#1714: the BILI_UPSTREAM_PROXY env override is gone,
    // so an explicit file proxy no longer suppresses this short-circuit — with a
    // non-empty globalProxy the short-circuit is skipped regardless).
    const explicitDirect = proxyMode === "direct";
    const proxy = proxyMode === "direct" ? "" : proxyMode === "manual" ? webProxy ?? configProxy : configProxy;
    const proxySource: ProxyOptions["proxySource"] = proxyMode === "direct"
        ? "direct"
        : proxyMode === "manual" && webProxy
          ? "web-manual"
          : configProxy
            ? "config"
            : "auto";
    const httpProxy = nonEmpty(env.HTTP_PROXY ?? env.http_proxy);
    const httpsProxy = nonEmpty(env.HTTPS_PROXY ?? env.https_proxy);
    const allProxy = nonEmpty(env.ALL_PROXY ?? env.all_proxy);
    const noProxy = nonEmpty(env.NO_PROXY ?? env.no_proxy);
    const proxyFallback: ProxyFallbackOptions = {
        ...(httpProxy ? { httpProxy } : {}),
        ...(httpsProxy ? { httpsProxy } : {}),
        ...(allProxy ? { allProxy } : {}),
        ...(noProxy ? { noProxy } : {}),
        biliPort: port,
        globalSource: proxySource,
        explicitDirect,
    };
    // #1012: the launcher forwards the user's pre-strip proxy vars under
    // BILI_INHERITED_* (the child's own env tier is intentionally empty —
    // e1c6c92). They feed ONLY the aux (blind-tunnel) fallback; explicit
    // routes / global config / explicitDirect keep outranking them, and the
    // biliPort loop guard inside parseFallbackProxy still drops self-loops.
    const inheritedHttpProxy = nonEmpty(env.BILI_INHERITED_HTTP_PROXY);
    const inheritedHttpsProxy = nonEmpty(env.BILI_INHERITED_HTTPS_PROXY);
    const inheritedAllProxy = nonEmpty(env.BILI_INHERITED_ALL_PROXY);
    const inheritedNoProxy = nonEmpty(env.BILI_INHERITED_NO_PROXY);
    const auxProxyFallback: ProxyFallbackOptions = {
        ...proxyFallback,
        // #1012 review catch: the DEFAULT (unset) mode resolves to "direct"
        // too (explicitDirect=true + empty global) which short-circuits
        // resolveProxyDecision BEFORE the env tier — killing the inherited
        // aux tier for every default-config user. Only an EXPLICIT "direct"
        // mode (config.json upstreamProxyMode; env input retired in #1714)
        // opts aux egress out of the inherited tier; unset means "no preference".
        explicitDirect: rawProxyMode === "direct",
        ...(httpProxy ? {} : inheritedHttpProxy ? { httpProxy: inheritedHttpProxy } : {}),
        ...(httpsProxy ? {} : inheritedHttpsProxy ? { httpsProxy: inheritedHttpsProxy } : {}),
        ...(allProxy ? {} : inheritedAllProxy ? { allProxy: inheritedAllProxy } : {}),
        ...(noProxy ? {} : inheritedNoProxy ? { noProxy: inheritedNoProxy } : {}),
    };
    validateHttpProxy(proxy, proxyFallback.biliPort);
    for (const [url, route] of Object.entries(routes)) {
        try {
            validateHttpProxy(route.proxy, proxyFallback.biliPort);
        } catch (error) {
            throw new Error(`[acp-config] invalid upstream proxy for ${url}: ${String(error)}`);
        }
    }
    return {
        port,
        host,
        upstream,
        auxProxyFallback,
        routes,
        proxy,
        proxyMode,
        proxySource,
        proxyFallback,
        modelContextLimit,
        kernelConfig: defaultConfig(modelContextLimit),
        compress: {
            ...fileConfig.compress,
            // #429: global injection toggles (default ON; env inputs retired in #1714)
            injectTool: fileConfig.compress?.injectTool !== false,
            injectNudge: fileConfig.compress?.injectNudge !== false,
        },
        promptCache: {
            routing: parsePromptCacheRouting(fileConfig.promptCache?.routing),
        },
        compat: { roles: parseCompatRoles(fileConfig.compat?.roles) ?? {} },
        streamErrorShape: parseStreamErrorShape(fileConfig.compat?.streamErrorShape),
        sessionHeader: fileConfig.sessionHeader ?? "x-acp-session",
        log: fileConfig.log !== false,
        debug: fileConfig.debug === true,
        dumpSse: fileConfig.dumpSse || undefined,
        passthrough: passthrough.enabled,
        passthroughSource: passthrough.source,
        autoUpdate: fileConfig.autoUpdate !== false,
        // Default OFF: unlike autoUpdate, self-restart touches process
        // liveness, so it requires an explicit opt-in (#811; env retired in #1714).
        autoRestartOnUpdate: fileConfig.autoRestartOnUpdate === true,
        updateTag: (fileConfig.updateTag ?? "latest").trim() || "latest",
        // Default ON: unlike autoRestartOnUpdate, this never touches process
        // liveness — it only installs files and warns (#1481; env retired in #1714).
        advisoryCheck: fileConfig.advisoryCheck !== false,
        advisoryUrl: fileConfig.advisoryUrl || undefined,
        logFile: fileConfig.logFile,
        mitm: {
            enabled: fileConfig.mitm?.enabled !== false,
            domains: dedupeDomains([
                ...(fileConfig.mitm?.domains ?? []),
                // Launcher→child pipeline handoff (#1714): dynamically discovered
                // domains ride this dedicated var; the user-facing
                // BILI_MITM_DOMAINS knob is retired (config file only).
                ...splitCsv(env.BILI_LAUNCHER_MITM_DOMAINS),
            ]),
        },
        maskHosts: fileConfig.maskHosts !== false,
        subagentSplit: fileConfig.subagentSplit !== false,
        forkAdoption: fileConfig.forkAdoption === true,
        resumeInheritance: fileConfig.resumeInheritance !== false,
        chainContentDetection: fileConfig.chainContentDetection === true,
        chainEgressStamp: fileConfig.chainEgressStamp === true,
        stableSystemAnchor: fileConfig.stableSystemAnchor === true,
        // #1714: remaining behavior knobs migrated from BILI_* env inputs to
        // config.json. All lenient: a stray/malformed field falls back to the
        // module's built-in default instead of aborting startup.
        upstreamTimeoutMs: cfgNum(fileConfig.upstreamTimeoutMs),
        streamKeepAliveMs: cfgNum(fileConfig.streamKeepAliveMs),
        replayRetryMax: cfgNum(fileConfig.replayRetryMax),
        replayRetryBaseMs: cfgNum(fileConfig.replayRetryBaseMs),
        maxShrinkPerCompress: cfgNum(fileConfig.maxShrinkPerCompress),
        exposureLogIntervalMs: cfgNum(fileConfig.exposureLogIntervalMs),
        preflightHoldMs: cfgNum(fileConfig.preflightHoldMs),
        preflightDeadEndCooldownMs: cfgNum(fileConfig.preflightDeadEndCooldownMs),
        requestWatchdogMs: cfgNum(fileConfig.requestWatchdogMs),
        keepAliveTimeoutMs: cfgNum(fileConfig.keepAliveTimeoutMs),
        clientErrorBackstopMs: cfgNum(fileConfig.clientErrorBackstopMs),
        ccrRetrievalTtlMs: cfgNum(fileConfig.ccrRetrievalTtlMs),
        fakeCompletionRetries: cfgNum(fileConfig.fakeCompletionRetries),
        fakeBufCap: cfgNum(fileConfig.fakeBufCap),
        maxSessions: cfgNum(fileConfig.maxSessions),
        sessionGc: fileConfig.sessionGc === true,
        sessionGcMaxAgeDays: cfgNum(fileConfig.sessionGcMaxAgeDays),
        sessionGcMaxTokens: cfgNum(fileConfig.sessionGcMaxTokens),
        sessionGcIntervalMs: cfgNum(fileConfig.sessionGcIntervalMs),
        persistEnabled: fileConfig.persistEnabled !== false,
        persistDebounceMs: cfgNum(fileConfig.persistDebounceMs),
        persistTailTokens: cfgNum(fileConfig.persistTailTokens),
        persistZstd: fileConfig.persistZstd === true,
        persistEpermAlertThreshold: cfgNum(fileConfig.persistEpermAlertThreshold),
        persistEpermAlertRepeatMs: cfgNum(fileConfig.persistEpermAlertRepeatMs),
        mitmHandshakeTimeoutMs: cfgNum(fileConfig.mitmHandshakeTimeoutMs),
        proxyKeepAliveMaxMs: cfgNum(fileConfig.proxyKeepAliveMaxMs),
        zonePort: cfgNum(fileConfig.zonePort),
        zcodeNativePort: cfgNum(fileConfig.zcode?.nativePort),
        decompressTmpCap: cfgNum(fileConfig.decompressTmpCap),
        imageTokenCap: cfgNum(fileConfig.imageTokenCap),
        dump4xx: fileConfig.dump4xx === true,
        dump4xxMaxBytes: cfgNum(fileConfig.dump4xxMaxBytes),
        sessionsDir: typeof fileConfig.sessionsDir === "string" && fileConfig.sessionsDir.trim() ? fileConfig.sessionsDir.trim() : undefined,
        tunnelAllowedHosts: Array.isArray(fileConfig.tunnelAllowedHosts) ? fileConfig.tunnelAllowedHosts.filter((h): h is string => typeof h === "string" && h.trim().length > 0).map((h) => h.trim()) : undefined,
    };
}

/** Lenient numeric coercion for #1714 config fields: only finite numbers pass
 *  through; anything else (strings, NaN, missing) resolves to undefined so the
 *  consuming module keeps its built-in default. */
function cfgNum(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The resolved mitm.domains tier exactly as loadOptions computes it (config
 *  file, deduped). Exported so launchers can mirror the precise whitelist
 *  their proxy child will use when deciding MITM vs blind tunnel (#1403).
 *  File-only since #1714 — BILI_MITM_DOMAINS is retired. */
export function resolveMitmDomains(): string[] {
    return dedupeDomains(loadConfigFile().mitm?.domains ?? []);
}

/** Shape of the optional JSON config file. All fields optional — the file is a
 *  pure override layer; anything unset falls through to defaults. */
type FileConfig = {
    port?: number;
    host?: string;
    upstream?: string;
    /** Path to a legacy providers.json (backward compat). */
    providersPath?: string;
    /** Inline providers, same shape as providers.json. */
    providers?: Record<string, unknown>;
    /** Global default upstream HTTP proxy (applied to all providers unless a
     *  per-URL `proxy` overrides it). `http://host:port`. */
    proxy?: string;
    modelContextLimit?: number;
    sessionHeader?: string;
    log?: boolean;
    debug?: boolean;
    dumpSse?: string;
    passthrough?: boolean;
    autoUpdate?: boolean;
    /** Opt-in self-restart when a newer version is installed on disk (#811). */
    autoRestartOnUpdate?: boolean;
    /** Dist-tag channel the auto-updater follows (default "latest"). */
    updateTag?: string;
    /** Set `false` to disable the critical-defect advisory watcher (#1481;
     *  env BILI_ADVISORY_CHECK retired in #1714). */
    advisoryCheck?: boolean;
    /** Override for the advisory document URL (env BILI_ADVISORY_URL retired
     *  in #1714). */
    advisoryUrl?: string;
    upstreamProxy?: string;
    upstreamProxyMode?: string;
    logFile?: string;
    /** Global compression block (level 1 of 3). Holds the injection toggles
     *  (`injectTool` / `injectNudge`, honored globally) plus the tuning fields
     *  (see CompressSettings), overridden per-field by provider- and model-level
     *  `compress`. */
    compress?: CompressSettings & { injectTool?: boolean; injectNudge?: boolean };
    promptCache?: { routing?: string };
    mitm?: { enabled?: boolean; domains?: string[] };
    /** Set `false` to log real (non-public) target hosts instead of the
     *  `<private-host>` placeholder (#897; env BILI_LOG_MASK_HOSTS retired in
     *  #1714). */
    maskHosts?: boolean;
    /** Set `false` to keep Claude Code subagents on the main session (#970;
     *  env BILI_SUBAGENT_SPLIT retired in #1714). */
    subagentSplit?: boolean;
    /** Opt-in fork block-adoption (#629): when an anonymous (prefix-affinity)
     *  client forks their history mid-conversation (edit / regenerate), the new
     *  session inherits the parent's compression blocks whose source content
     *  is fully present in the forked request, instead of restarting with
     *  zero compression state. Default false (env BILI_FORK_ADOPTION retired
     *  in #1714). */
    forkAdoption?: boolean;
    /** Set `false` to disable resume-fork inheritance (#1486, default ON;
     *  env BILI_RESUME_INHERITANCE retired in #1714). */
    resumeInheritance?: boolean;
    /** Set `true` to enable body-content detection of the bili→bili chain
     *  awareness (#1086/#1421); OFF by default — by default only x-bili-hop drives
     *  chain recognition, since body scanning can false-positive on CCR/file-
     *  introduced text and model-echoed tags (#1683). Env BILI_CHAIN_CONTENT
     *  retired in #1714. */
    chainContentDetection?: boolean;
    /** Set `true` to enable egress emission of the model-visible
     *  `<bili-chain …/>` checkpoint carrier (#1683, default OFF; env
     *  BILI_CHAIN_STAMP retired in #1714). Independent of
     *  chainContentDetection. */
    chainEgressStamp?: boolean;
    /** Set `true` to enable the sticky head-system anchor (#1085, default
     *  OFF; env BILI_STABLE_SYSTEM_ANCHOR retired in #1714). */
    stableSystemAnchor?: boolean;
    // #1714: behavior knobs migrated from BILI_*/ACP_* env inputs to config.json.
    upstreamTimeoutMs?: number;
    streamKeepAliveMs?: number;
    replayRetryMax?: number;
    replayRetryBaseMs?: number;
    maxShrinkPerCompress?: number;
    exposureLogIntervalMs?: number;
    preflightHoldMs?: number;
    preflightDeadEndCooldownMs?: number;
    requestWatchdogMs?: number;
    keepAliveTimeoutMs?: number;
    clientErrorBackstopMs?: number;
    ccrRetrievalTtlMs?: number;
    fakeCompletionRetries?: number;
    fakeBufCap?: number;
    maxSessions?: number;
    /** Set `true` to enable periodic session GC (default off). */
    sessionGc?: boolean;
    sessionGcMaxAgeDays?: number;
    sessionGcMaxTokens?: number;
    sessionGcIntervalMs?: number;
    /** Set `false` to disable on-disk session persistence (default on). */
    persistEnabled?: boolean;
    persistDebounceMs?: number;
    persistTailTokens?: number;
    /** Set `true` to zstd-compress persisted sessions (default off). */
    persistZstd?: boolean;
    persistEpermAlertThreshold?: number;
    persistEpermAlertRepeatMs?: number;
    mitmHandshakeTimeoutMs?: number;
    proxyKeepAliveMaxMs?: number;
    zonePort?: number;
    decompressTmpCap?: number;
    imageTokenCap?: number;
    /** Set `true` to dump 4xx error bodies for debugging (default off). */
    dump4xx?: boolean;
    dump4xxMaxBytes?: number;
    sessionsDir?: string;
    tunnelAllowedHosts?: string[];
    /** Global wire-compat block. `roles` maps message roles to the role name
     *  upstreams accept (e.g. `{"developer":"system"}`) — applied to the
     *  final forwarded body for openai/responses requests (#552).
     *  `streamErrorShape` (#1455): "protocol" (default) presents upstream
     *  stream failures as protocol-native error frames; "completion" restores
     *  the legacy shape that delivered the failure text inside a synthesized
     *  successful completion. Env BILI_STREAM_ERROR_SHAPE retired in #1714. */
    compat?: { roles?: Record<string, string>; streamErrorShape?: string };
    /** Global image billing mode (#767): "auto" | "pixels" | "bytes".
     *  Per-provider `imageBilling` overrides it (env BILI_IMAGE_BILLING
     *  retired in #1714). See ProviderRoute.imageBilling. */
    imageBilling?: string;
    /** Claude-native port override (#964/#1660): an explicit port for the
     *  claude lane — strict-port semantics (EADDRINUSE fails loud). Undefined
     *  (the default) means the lane's sticky zone port (ZONE_PORT_BASE base).
     *  Env BILI_CLAUDE_NATIVE_PORT retired in #1714. */
    claude?: { nativePort?: number };
    /** ZCode-native port override (#1660): strict-port semantics like
     *  claude.nativePort; undefined = the lane's sticky zone port. Env
     *  BILI_ZCODE_PORT retired in #1714. */
    zcode?: { nativePort?: number };
    /** Native-hook attach policy (#1335): set `true` to let native hooks
     *  attach to lifecycle-less listeners (a manually started `bili start`
     *  daemon — no session-lifecycle watchdog, outlives every session, often
     *  an older code version). Default false: hooks self-manage and spawn
     *  their own armed session proxy instead (#1322). Env
     *  BILI_NATIVE_ATTACH_EXTERNAL retired in #1714. */
    native?: { attachExternal?: boolean };
};

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function splitCsv(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function dedupeDomains(list: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const d of list) {
        if (!seen.has(d)) {
            seen.add(d);
            out.push(d);
        }
    }
    return out;
}

function loadConfigFile(): FileConfig {
    const parsed = safeReadJson(configFile());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as FileConfig;
    }
    return {};
}

/** #1660: the self-managed zone port base. Every launcher-spawned lane
 *  binds here by default instead of an OS-assigned ephemeral port: a stable
 *  origin survives instance death, and the proxy child's EADDRINUSE ladder
 *  (+1 per attempt) resolves collisions deterministically with a sticky
 *  record (instance.ts port-zone.json). 18787 sits below the Linux ephemeral
 *  range (32768–60999) so the ladder never lands on OS-assigned ports; 8787
 *  stays reserved as the USER zone (manual `bili start`). Config `zonePort`
 *  overrides the base for the whole zone (#1714: BILI_ZONE_PORT retired). */
export const ZONE_PORT_BASE = 18787;

export function resolveZonePortBase(): number {
    const fromFile = loadConfigFile().zonePort;
    if (typeof fromFile === "number" && Number.isInteger(fromFile) && fromFile > 0 && fromFile < 65536) return fromFile;
    return ZONE_PORT_BASE;
}

/** #1660: an explicit user override of the claude lane's port via config
 *  `claude.nativePort` (> undefined). File-only since #1714 — env
 *  BILI_CLAUDE_NATIVE_PORT is retired. A DEFINED value means a strict-port
 *  launch (an EADDRINUSE at bind fails loud, #964); undefined means the
 *  lane's sticky zone port (instance.ts lanePreferredPort) with the +1
 *  ladder absorbing collisions. The installer no longer persists this — zone
 *  drift is repaired by the SessionStart hook rewriting the managed block to
 *  the live origin every session. */
export function resolveClaudeNativePort(): number | undefined {
    const fromFile = loadConfigFile().claude?.nativePort;
    if (typeof fromFile === "number" && Number.isInteger(fromFile) && fromFile > 0 && fromFile < 65536) return fromFile;
    return undefined;
}

/** #1660: explicit override of the zcode lane's port via config
 *  `zcode.nativePort` — the store is re-derived at every bootstrap, nothing
 *  is baked at install time. File-only since #1714 — env BILI_ZCODE_PORT is
 *  retired. Defined means a strict-port launch; undefined means the lane's
 *  sticky zone port. Legacy wrappers pinned to the old 48789 default are
 *  migrated by the bootstrap's origin-drift repair (routeZcodeConfig rewrites
 *  the store to the live origin). */
export function resolveZcodeNativePort(): number | undefined {
    const fromFile = loadConfigFile().zcode?.nativePort;
    if (typeof fromFile === "number" && Number.isInteger(fromFile) && fromFile > 0 && fromFile < 65536) return fromFile;
    return undefined;
}

/** Client-side routing exemptions (#1622): providers whose route declares
 *  `direct: true` are never pointed through bili by store-rewriting native
 *  lanes. Returns the normalized URL keys (the same key space findRoute
 *  matches against). */
export function zcodeDirectPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
    const routes = loadRoutes(env);
    return Object.entries(routes).filter(([, r]) => r.direct === true).map(([k]) => k);
}

/** #1335: the native-hook attach-gate escape hatch. True when the user
 *  deliberately runs lifecycle-less resident daemons for native hooks to ride:
 *  config `native.attachExternal` must be exactly `true` (any other value —
 *  including garbage — leaves the gate closed). File-only since #1714 — env
 *  BILI_NATIVE_ATTACH_EXTERNAL is retired. Default false. */
export function resolveNativeAttachExternal(): boolean {
    return loadConfigFile().native?.attachExternal === true;
}


/** Template written on first run so the user has a file to edit instead
 *  of having to invent the path/schema. Left empty on purpose: the proxy
 *  can't guess your provider, so we don't put a fake one. Fill it in per
 *  the README Quickstart, then restart `bili`. */
const TEMPLATE_CONFIG = `{
  "providers": {
  }
}`;

/** On first run, seed a template config file next to where loadOptions reads.
 *  Idempotent: never overwrites an existing file. Returns true if it created
 *  one. Non-fatal: if the dir isn't writable, we fall through to defaults and
 *  the proxy still runs. */
export function ensureConfigTemplate(): boolean {
    const p = configFile();
    if (existsSync(p)) return false;
    try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, TEMPLATE_CONFIG + "\n", "utf8");
        loggerLog("info", `[acp-config] created empty config at ${p} — add your providers (see README Quickstart), then restart`);
        return true;
    } catch {
        return false;
    }
}

export function normalizeUrlKey(key: string): string {
    // Keys are upstream URLs matched by longest-prefix against the request's
    // embedded URL. A trailing slash breaks that match (the embedded URL never
    // has one), so strip trailing slashes. Manual edits and web-UI saves both
    // flow through here so the behavior is consistent.
    return key.replace(/\/+$/, "");
}

export function parseRouteEntry(v: unknown): ProviderRoute | undefined {
    // The value describes per-model context overrides. The upstream URL itself
    // is the KEY in the providers map (identical to the /bili/<url> string),
    // so it is NOT repeated inside the value.
    if (v && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as { models?: Record<string, ModelEntry>; proxy?: string; compressProtocol?: string; compress?: CompressSettings; compat?: { roles?: unknown }; passthrough?: boolean; direct?: boolean; imageBilling?: unknown };
        const route: ProviderRoute = { models: obj.models };
        if (typeof obj.proxy === "string") route.proxy = obj.proxy;
        if (obj.compressProtocol === "marker" || obj.compressProtocol === "tools") route.compressProtocol = obj.compressProtocol;
        if (obj.compress) route.compress = obj.compress;
        const compatRoles = parseCompatRoles(obj.compat?.roles);
        if (compatRoles) route.compat = { roles: compatRoles };
        if (typeof obj.passthrough === "boolean") route.passthrough = obj.passthrough;
        if (typeof obj.direct === "boolean") route.direct = obj.direct;
        const imageBilling = parseImageBilling(obj.imageBilling);
        if (imageBilling) route.imageBilling = imageBilling;
        return route;
    }
    // A bare value (e.g. null) means "this upstream exists, no overrides".
    if (v === null) return {};
    return undefined;
}

export function parseImageBilling(value: unknown): ImageBillingMode | undefined {
    return value === "auto" || value === "pixels" || value === "bytes" ? value : undefined;
}

export function parseStreamErrorShape(value: unknown): "protocol" | "completion" {
    return value === "completion" ? "completion" : "protocol";
}

export function parsePromptCacheRouting(value: string | undefined): PromptCacheRouting {
    return value === "enabled" || value === "disabled" ? value : "auto";
}

export function parseUpstreamProxyMode(value: string | undefined): UpstreamProxyMode {
    return value === "manual" || value === "auto" ? value : "direct";
}

export function parseCompressSettings(v: unknown): (CompressSettings & { injectTool?: boolean; injectNudge?: boolean }) | undefined {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const obj = v as Record<string, unknown>;
    const out: CompressSettings = {};
    const numberOrPercent = (value: unknown): value is number | string =>
        typeof value === "number" && Number.isFinite(value)
        || (typeof value === "string" && /^\d+(\.\d+)?%$/.test(value.trim()));
    let ok = true;
    const takeNumber = (key: keyof CompressSettings): void => {
        if (!(key in obj)) return;
        if (typeof obj[key] !== "number" || !Number.isFinite(obj[key] as number)) ok = false;
        else (out as Record<string, unknown>)[key] = obj[key];
    };
    for (const key of ["modelContextLimit", "maxContextLimit", "emergencyThresholdPercent"] as const) {
        if (!(key in obj)) continue;
        if (!numberOrPercent(obj[key])) { ok = false; continue; }
        (out as Record<string, unknown>)[key] = typeof obj[key] === "string" ? (obj[key] as string).trim() : obj[key];
    }
    for (const key of ["nudgeGrowthTokens", "preserveRecentMessages", "preserveRecentTokens", "minCompressRange", "minCompressRangeChars", "stripImagesKeepRecent"] as const) {
        takeNumber(key);
    }
    if ("outputHeadroomMaxPct" in obj) {
        const v = obj.outputHeadroomMaxPct;
        if (typeof v !== "number" && typeof v !== "string") ok = false;
        else {
            const pct = resolveOutputHeadroomCap(v);
            if (!Number.isFinite(pct) || pct < 0) ok = false;
            else out.outputHeadroomMaxPct = v;
        }
    }
    if ("tiers" in obj) {
        if (typeof obj.tiers !== "boolean") ok = false;
        else out.tiers = obj.tiers;
    }
    for (const key of ["protectedLatestTools", "protectedTools"] as const) {
        if (!(key in obj) || obj[key] === undefined) continue;
        const v = obj[key];
        if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || x.trim().length === 0)) ok = false;
        else (out as Record<string, unknown>)[key] = (v as string[]).map((x) => x.trim());
    }
    // neverPreserveRecentTools keeps the kernel semantics that an explicit
    // empty array is meaningful (excludes nothing — the #1198/#1277 escape
    // hatch), so unlike the two protectedTools knobs an empty array passes.
    if ("neverPreserveRecentTools" in obj && obj.neverPreserveRecentTools !== undefined) {
        const v = obj.neverPreserveRecentTools;
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim().length === 0)) ok = false;
        else out.neverPreserveRecentTools = (v as string[]).map((x) => x.trim());
    }
    // preserveRecentTools is a pure no-op when empty, so — like the
    // protectedTools knobs — an empty array is rejected (a bare [] here is
    // almost certainly a typo for neverPreserveRecentTools: []).
    if ("preserveRecentTools" in obj && obj.preserveRecentTools !== undefined) {
        const v = obj.preserveRecentTools;
        if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || x.trim().length === 0)) ok = false;
        else out.preserveRecentTools = (v as string[]).map((x) => x.trim());
    }
    if ("stripImages" in obj) {
        if (typeof obj.stripImages !== "boolean") ok = false;
        else out.stripImages = obj.stripImages;
    }
    if ("visibilityMarkers" in obj) {
        if (typeof obj.visibilityMarkers !== "boolean") ok = false;
        else out.visibilityMarkers = obj.visibilityMarkers;
    }
    if ("rules" in obj) {
        if (typeof obj.rules !== "boolean") ok = false;
        else out.rules = obj.rules;
    }
    // Injection toggles are file-level fields (FileConfig.compress) honored by
    // loadOptions via `=== false`; the web UI shows them from the raw file
    // block, so they must round-trip here. Dropping them would silently
    // re-enable injectTool/injectNudge on an unchanged save.
    for (const key of ["injectTool", "injectNudge"] as const) {
        if (key in obj) {
            if (typeof obj[key] !== "boolean") ok = false;
            else (out as Record<string, unknown>)[key] = obj[key];
        }
    }
    if ("acknowledgePromptsRisk" in obj) {
        if (typeof obj.acknowledgePromptsRisk !== "boolean") ok = false;
        else out.acknowledgePromptsRisk = obj.acknowledgePromptsRisk;
    }
    if ("absorb" in obj && obj.absorb !== undefined) {
        const a = obj.absorb;
        if (!a || typeof a !== "object" || Array.isArray(a)) {
            ok = false;
        } else {
            const ao = a as Record<string, unknown>;
            const cleaned: NonNullable<CompressSettings["absorb"]> = {};
            for (const key of ["enabled", "minToolTokens", "contextThresholdPct", "excludeTools", "toolName"] as const) {
                if (!(key in ao)) continue;
                const v = ao[key];
                if (key === "enabled") {
                    if (typeof v !== "boolean") { ok = false; continue; }
                    cleaned.enabled = v;
                } else if (key === "minToolTokens") {
                    if (typeof v !== "number" || !Number.isFinite(v)) { ok = false; continue; }
                    cleaned.minToolTokens = v;
                } else if (key === "contextThresholdPct") {
                    if (!numberOrPercent(v)) { ok = false; continue; }
                    cleaned.contextThresholdPct = typeof v === "string" ? v.trim() : v;
                } else if (key === "excludeTools") {
                    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) { ok = false; continue; }
                    cleaned.excludeTools = [...v] as string[];
                } else {
                    if (typeof v !== "string" || v.trim().length === 0) { ok = false; continue; }
                    cleaned.toolName = v.trim();
                }
            }
            if (ok) out.absorb = cleaned;
        }
    }
    if ("ccr" in obj && obj.ccr !== undefined) {
        const c = obj.ccr;
        if (!c || typeof c !== "object" || Array.isArray(c)) {
            ok = false;
        } else {
            const co = c as Record<string, unknown>;
            const cleaned: NonNullable<CompressSettings["ccr"]> = {};
            for (const key of ["enabled", "minToolTokens", "excludeTools", "toolName", "maxHeadChars"] as const) {
                if (!(key in co)) continue;
                const v = co[key];
                if (key === "enabled") {
                    if (typeof v !== "boolean") { ok = false; continue; }
                    cleaned.enabled = v;
                } else if (key === "minToolTokens" || key === "maxHeadChars") {
                    if (typeof v !== "number" || !Number.isFinite(v)) { ok = false; continue; }
                    cleaned[key] = v;
                } else if (key === "excludeTools") {
                    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) { ok = false; continue; }
                    cleaned.excludeTools = [...v] as string[];
                } else {
                    if (typeof v !== "string" || v.trim().length === 0) { ok = false; continue; }
                    cleaned.toolName = v.trim();
                }
            }
            if (ok) out.ccr = cleaned;
        }
    }
    if ("search" in obj && obj.search !== undefined) {
        const c = obj.search;
        if (!c || typeof c !== "object" || Array.isArray(c)) {
            ok = false;
        } else {
            const co = c as Record<string, unknown>;
            const cleaned: NonNullable<CompressSettings["search"]> = {};
            for (const key of ["planAware"] as const) {
                if (!(key in co)) continue;
                const v = co[key];
                if (typeof v !== "boolean") { ok = false; continue; }
                cleaned.planAware = v;
            }
            if (ok) out.search = cleaned;
        }
    }
    if ("imageCompression" in obj && obj.imageCompression !== undefined) {
        const c = obj.imageCompression;
        if (!c || typeof c !== "object" || Array.isArray(c)) {
            ok = false;
        } else {
            const co = c as Record<string, unknown>;
            const cleaned: NonNullable<CompressSettings["imageCompression"]> = {};
            for (const key of ["enabled", "minTokens", "maxDimension", "quality", "format"] as const) {
                if (!(key in co)) continue;
                const v = co[key];
                if (key === "enabled") {
                    if (typeof v !== "boolean") { ok = false; continue; }
                    cleaned.enabled = v;
                } else if (key === "minTokens" || key === "maxDimension" || key === "quality") {
                    if (typeof v !== "number" || !Number.isFinite(v)) { ok = false; continue; }
                    cleaned[key] = v;
                } else {
                    if (v !== "webp" && v !== "jpeg" && v !== "png") { ok = false; continue; }
                    cleaned.format = v;
                }
            }
            if (ok) out.imageCompression = cleaned;
        }
    }
    if ("prompts" in obj && obj.prompts !== undefined) {
        const prompts = obj.prompts;
        if (!prompts || typeof prompts !== "object" || Array.isArray(prompts)) {
            ok = false;
        } else {
            const cleaned: Partial<Prompts> = {};
            for (const [key, value] of Object.entries(prompts as Record<string, unknown>)) {
                if (typeof value !== "string" || value.trim().length === 0) { ok = false; continue; }
                if (key !== "compressPhilosophy" && key !== "howToCompressRules"
                    && key !== "tier2DistillRules" && key !== "tier3CondenseRules") {
                    ok = false;
                    continue;
                }
                (cleaned as Record<string, string>)[key] = value;
            }
            if (ok) out.prompts = cleaned;
        }
    }
    if ("promptPack" in obj && obj.promptPack !== undefined) {
        if (typeof obj.promptPack !== "string" || obj.promptPack.trim().length === 0) ok = false;
        else out.promptPack = obj.promptPack.trim();
    }
    if ("reasoningGuard" in obj && obj.reasoningGuard !== undefined) {
        const rg = obj.reasoningGuard;
        if (!rg || typeof rg !== "object" || Array.isArray(rg)) {
            ok = false;
        } else {
            const rgo = rg as Record<string, unknown>;
            const cleaned: ReasoningGuardConfig = {};
            for (const key of ["enabled", "maxContinue", "maxTierN", "markerText", "base", "offset", "debugLog"] as const) {
                if (!(key in rgo)) continue;
                const v = rgo[key];
                if (key === "enabled") {
                    if (typeof v !== "boolean") { ok = false; continue; }
                    cleaned.enabled = v;
                } else if (key === "debugLog") {
                    if (typeof v !== "boolean") { ok = false; continue; }
                    cleaned.debugLog = v;
                } else if (key === "markerText") {
                    if (typeof v !== "string" || v.trim().length === 0) { ok = false; continue; }
                    cleaned.markerText = v.trim();
                } else {
                    if (typeof v !== "number" || !Number.isFinite(v)) { ok = false; continue; }
                    (cleaned as Record<string, unknown>)[key] = v;
                }
            }
            if (ok) out.reasoningGuard = cleaned;
        }
    }
    if ("outputSteering" in obj && obj.outputSteering !== undefined) {
        const os = obj.outputSteering;
        if (!os || typeof os !== "object" || Array.isArray(os)) {
            ok = false;
        } else {
            // Shape-guard only: sub-field validation is the kernel resolver's job at
            // resolution time, so one out-of-range value can't nuke the whole block.
            out.outputSteering = os as Partial<OutputSteeringConfig>;
        }
    }
    if ("priceProfile" in obj && obj.priceProfile !== undefined) {
        const pp = obj.priceProfile;
        if (!pp || typeof pp !== "object" || Array.isArray(pp)) {
            ok = false;
        } else {
            const ppo = pp as Record<string, unknown>;
            const cleaned: NonNullable<CompressSettings["priceProfile"]> = {};
            for (const key of ["w", "r", "q"] as const) {
                if (!(key in ppo)) continue;
                const v = ppo[key];
                if (typeof v !== "number" || !Number.isFinite(v) || v < 0) { ok = false; continue; }
                cleaned[key] = v;
            }
            if (ok) out.priceProfile = cleaned;
        }
    }
    if (!ok) return undefined;
    return out;
}

function rejectLegacyRoute(key: string, value: unknown): void {
    if (typeof value !== "string") return;
    const masked = maskUrlForLog(value);
    throw new Error(
        `[acp-config] legacy provider route \"${key}\": \"${masked}\" is no longer valid; ` +
        `use the upstream URL as the key, for example { \"${masked.replace(/\/+$/, "")}\": {} }`,
    );
}
