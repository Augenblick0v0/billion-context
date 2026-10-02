# Architecture Reference

> **Not auto-loaded.** This is on-demand reference material pulled out of
> `AGENTS.md` to keep the auto-loaded spec lean. The operative design rules live
> in [`AGENTS.md` §2](../AGENTS.md#2-architecture); this file holds the
> file-by-file module map, which drifts as modules land — **regenerate it when
> you add/remove a source file; do not trust a stale copy.**

## Module Map

```
billion-context/
├── src/
│   ├── index.ts                  # Entry: runs cli.ts main()
│   ├── cli.ts                    # CLI dispatcher: start/update/export/test/plugin + client launchers
│   ├── server.ts                 # HTTP proxy server, request pipeline
│   ├── config.ts                 # Config loading (file + env + CLI flags)
│   ├── logger.ts                 # Tee logger: file (~/.local/state/) + stderr
│   ├── paths.ts                  # XDG paths (config/cache/state dirs)
│   ├── session.ts                # Session model + in-memory store
│   ├── session-id.ts             # Session ID generation
│   ├── persist.ts                # On-disk session persistence (kernel StateStore)
│   ├── update.ts                 # Auto-update: checks npm, auto-installs latest
│   ├── launcher.ts               # `bili <client>` launchers (pi/codex/claude/omp/opencode/hermes/dsh/codebuddy/qoder/trae/jcode/kimi/zcode)
│   ├── client-config.ts          # READ-only discovery of each client's upstream config
│   ├── mitm.ts / ca.ts           # Cert-MITM proxying + lazily generated root CA
│   ├── mcp.ts                    # Plugin-in-launcher MCP shell (spawn-time injection)
│   ├── plugin.ts / plugin-install.ts # Cooperative plugin protocol + `bili plugin install`
│   ├── registry.ts               # models.dev context-window registry (snapshot-first)
│   ├── registry-snapshot.json    # Bundled full models.dev snapshot (offline floor)
│   ├── upstream-proxy.ts         # undici ProxyAgent routing (https_proxy for registry fetch)
│   ├── stream.ts                 # SSE stream utilities + tag patching
│   ├── stream-openai.ts          # OpenAI-format stream processing
│   ├── stream-responses.ts       # Responses-API stream processing
│   ├── stream-error.ts           # Stream error handling
│   ├── sse-util.ts               # SSE parsing helpers
│   ├── loop/                     # Unified compress loop (wire-agnostic core)
│   │   ├── core.ts               #   protocol-neutral event model + tool adjudication
│   │   ├── adapter-anthropic.ts  #   Anthropic wire adapter (buffer-to-finish tool calls)
│   │   ├── adapter-openai.ts     #   OpenAI chat adapter (buffer-to-finish, raw passthrough)
│   │   ├── adapter-responses.ts  #   Responses API adapter
│   │   ├── adapter-google.ts     #   Google wire adapter (coreToGoogle)
│   │   ├── cache-control.ts      #   Explicit Anthropic cache_control breakpoints (#1637)
│   │   └── tag-echo-filter.ts    #   Streaming-safe stripper for model-echoed render tags (#206); tool args byte-exact
│   ├── compress-loop-responses.ts # Compress loop (Responses API format)
│   ├── compress-settings.ts      # Three-level compress config merge
│   ├── compress-tool.ts          # compress tool parsing (kernel parseCompressArgs)
│   ├── decompress-shared.ts      # Shared decompress logic
│   ├── orphan-gc.ts              # Orphaned block cleanup
│   ├── agent/                    # Thin agent-side plugins (per-host pi/omp/opencode/dsh, each with a `-native` variant; opencode-acp-command.ts = shared /acp hooks V1+V2, opencode-native.ts = self-spawn native, V1 `.server()` + V2 `setup`)
│   ├── kimi/                     # Kimi native lane (bootstrap hook, native MCP, toml edit)
│   ├── zcode/                    # ZCode native lane (bootstrap hook, json edit, MCP entry)
│   ├── web/                      # Web UI (config + context windows)
│   ├── fetch-util.ts             # HTTP fetch with timeout
│   └── util.ts                   # Misc utilities
├── tests/                        # 414 test files
├── tsup.config.ts
└── package.json
```

## Orientation cheat-sheet

- **Request pipeline** — `src/server.ts` (+ `src/loop/**` adapters). This is the
  hot file most PRs contend on; see `AGENTS.md` §7.2 "hot-file contention".
- **Self-updater** — `src/update.ts`. Load-bearing for every future upgrade; any
  change requires a no-op validation release first (`AGENTS.md` §5).
- **Agent-side plugins** — `src/agent/**` (thin, per-host).
- **Persistence** — `src/persist.ts` + kernel `StateStore`; session identity in
  `src/session-id.ts`.
- **Wire fidelity** — tag handling + echo filtering in `src/loop/tag-echo-filter.ts`
  (the byte-exact tool-args invariant lives there; `AGENTS.md` §7.3).
- **E2E regression** — `tests/e2e/` (see [testing.md](testing.md)).
