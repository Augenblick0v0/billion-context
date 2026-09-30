// #1714: behavior-class env vars removed from bili's config surface.
// Stale shell exports (the #1706 failure mode: an ancient export silently
// overriding live behavior) must surface, not die quietly. Boot-time scan:
// one warn per process listing every retired name still present in env.
import { log as loggerLog } from "./logger.js";

const RETIRED_ENV: Record<string, string> = {
    ACP_AUTO_RESTART_ON_UPDATE: "autoRestartOnUpdate",
    ACP_AUTO_UPDATE: "autoUpdate",
    ACP_COMPRESS_NUDGE: "compress.injectNudge",
    ACP_COMPRESS_TOOL: "compress.injectTool",
    ACP_DEBUG: "debug",
    ACP_DUMP_SSE: "dumpSse",
    ACP_LOG: "log",
    ACP_LOG_FILE: "logFile",
    ACP_MODEL_CONTEXT_LIMIT: "modelContextLimit",
    ACP_PASSTHROUGH: "passthrough",
    ACP_PROMPT_CACHE_ROUTING: "promptCache.routing",
    ACP_SESSION_HEADER: "sessionHeader",
    ACP_UPDATE_TAG: "updateTag",
    BILI_ADVISORY_CHECK: "advisoryCheck",
    BILI_ADVISORY_URL: "advisoryUrl",
    BILI_CCR_RETRIEVAL_TTL_MS: "ccrRetrievalTtlMs",
    BILI_CHAIN_CONTENT: "chainContentDetection",
    BILI_CHAIN_STAMP: "chainEgressStamp",
    BILI_CHAIN_MAX_FUTURE_SKEW_MS: "no config field \u2014 code knob",
    BILI_CHAIN_RECENT_WINDOW_MS: "no config field \u2014 code knob",
    BILI_CLAUDE_NATIVE_PORT: "claude.nativePort",
    BILI_CLIENT_ERROR_BACKSTOP_MS: "clientErrorBackstopMs",
    BILI_ATTACH_EVIDENCE_GRACE_MS: "no config field \u2014 code knob",
    BILI_ATTACH_HEALTH_DEADLINE_MS: "no config field \u2014 code knob",
    BILI_DECOMPRESS_TMP_CAP: "decompressTmpCap",
    BILI_DUMP_4XX: "dump4xx",
    BILI_DUMP_4XX_MAX_BYTES: "dump4xxMaxBytes",
    BILI_EXPOSURE_LOG_INTERVAL_MS: "exposureLogIntervalMs",
    BILI_FAKE_BUF_CAP: "fakeBufCap",
    BILI_FAKE_COMPLETION_RETRIES: "fakeCompletionRetries",
    BILI_FORK_ADOPTION: "forkAdoption",
    BILI_IMAGE_BILLING: "imageBilling (global or per-provider)",
    BILI_IMAGE_TOKEN_CAP: "imageTokenCap",
    BILI_KEEP_ALIVE_TIMEOUT_MS: "keepAliveTimeoutMs",
    BILI_LOG_MASK_HOSTS: "maskHosts",
    BILI_MAX_SESSIONS: "maxSessions",
    BILI_MAX_SHRINK_PER_COMPRESS: "maxShrinkPerCompress",
    BILI_MITM: "mitm.enabled",
    BILI_MITM_DOMAINS: "mitm.domains",
    BILI_MITM_HANDSHAKE_TIMEOUT_MS: "mitmHandshakeTimeoutMs",
    BILI_NATIVE_ATTACH_EXTERNAL: "native.attachExternal",
    BILI_PERSIST: "persistEnabled",
    BILI_PERSIST_DEBOUNCE_MS: "persistDebounceMs",
    BILI_PERSIST_EPERM_ALERT_REPEAT_MS: "persistEpermAlertRepeatMs",
    BILI_PERSIST_EPERM_ALERT_THRESHOLD: "persistEpermAlertThreshold",
    BILI_PERSIST_TAIL_TOKENS: "persistTailTokens",
    BILI_PERSIST_ZSTD: "persistZstd",
    BILI_PREFLIGHT_DEAD_END_COOLDOWN_MS: "preflightDeadEndCooldownMs",
    BILI_PREFLIGHT_HOLD_MS: "preflightHoldMs",
    BILI_PROXY_KEEPALIVE_MAX_MS: "proxyKeepAliveMaxMs",
    BILI_REPLAY_RETRY_BASE_MS: "replayRetryBaseMs",
    BILI_REPLAY_RETRY_MAX: "replayRetryMax",
    BILI_REQUEST_WATCHDOG_MS: "requestWatchdogMs",
    BILI_RESUME_INHERITANCE: "resumeInheritance",
    BILI_SESSION_GC: "sessionGc",
    BILI_SESSION_GC_INTERVAL_MS: "sessionGc.intervalMs",
    BILI_SESSION_GC_MAX_AGE_DAYS: "sessionGc.maxAgeDays",
    BILI_SESSION_GC_MAX_TOKENS: "sessionGc.maxTokens",
    BILI_SESSIONS_DIR: "sessionsDir",
    BILI_STABLE_SYSTEM_ANCHOR: "stableSystemAnchor",
    BILI_STREAM_ERROR_SHAPE: "compat.streamErrorShape",
    BILI_STREAM_KEEPALIVE_MS: "streamKeepAliveMs",
    BILI_SUBAGENT_SPLIT: "subagentSplit",
    BILI_TUNNEL_ALLOWED_HOSTS: "tunnelAllowedHosts",
    BILI_UPSTREAM_PROXY: "upstreamProxy",
    BILI_UPSTREAM_PROXY_MODE: "upstreamProxyMode",
    BILI_UPSTREAM_TIMEOUT_MS: "upstreamTimeoutMs",
    BILI_ZCODE_PORT: "zcode.nativePort",
    BILI_ZONE_PORT: "zonePort",
};

let scanned = false;

export function _resetRetiredEnvScanForTest(): void {
    scanned = false;
}

export function scanRetiredEnv(env: NodeJS.ProcessEnv = process.env): void {
    if (scanned) return;
    scanned = true;
    const hits: string[] = [];
    for (const [name, hint] of Object.entries(RETIRED_ENV)) {
        if (env[name] !== undefined) hits.push(`${name} \u2192 config.json ${hint}`);
    }
    if (hits.length === 0) return;
    loggerLog("warn", [
        `[bili] ${hits.length} retired environment variable(s) detected \u2014 they are NO LONGER read (#1714):`,
        ...hits.map((h) => `  - ${h}`),
        "[bili] Remove them from your shell profile; set the listed fields in the config file instead.",
    ].join("\n"));
}
