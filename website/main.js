/* billion-context landing — i18n + interactions */
(function () {
  "use strict";

  var I18N = {
    en: {
      "doc.title": "billion-context — month-long coding sessions on a 100K window",
      "nav.how": "How it works",
      "nav.agents": "Agents",
      "nav.install": "Install",
      "nav.paper": "Paper",
      "nav.docs": "Docs",
      "hero.kicker_live": "runs on your machine, sees nothing else",
      "hero.t1": "Month-long sessions",
      "hero.t2": "on a 100K window.",
      "hero.lede": "<strong>billion-context</strong> is a local context-compression proxy for AI coding agents — <em>billion-context is all you need.</em> Small context windows are enough: it keeps a 100K-window model working for days at a time, cuts token spend by up to 5&times;, and accounts for every token it moves.",
      "hero.cta1": "Get started",
      "hero.cta2": "Read the code",
      "bullet1": "Prompt-cache-aware compaction — rewrites cost almost nothing",
      "bullet2": "A per-request ledger: new content vs. repay cost, visible in-terminal",
      "bullet3": "Works as a transparent proxy — no agent source changes required",
      "stat1": "fewer tokens per task",
      "stat2": "model calls in the longitudinal study",
      "stat3": "cumulative input tokens compressed",
      "stat4": "window violations on 204,800-token models",
      "stats.src": "Figures from the open-sourced study (4.5 months, 3 hosts, marathon sessions of 8,584–12,049 calls) — see the paper below.",
      "wall.label": "Works with the agents you already run",
      "how.title": "How it works",
      "how.sub": "Not a bigger window — a better layout. Four mechanisms keep months of work inside an ordinary context limit:",
      "m1.t": "Folded, not rewritten",
      "m1.b": "When history outgrows its budget, only the newly consumed slice is folded into a compact summary block — once per block, ever. The window oscillates in a bounded band instead of growing without limit; production sessions ran months at ten-thousand-plus calls. Any block decompresses back to full text when you need the detail.",
      "m2.t": "The provider's cache stays warm",
      "m2.b": "A fold deactivates old ranges without touching the front of the conversation, so the prompt-cache prefix survives turn after turn — 94.2% of active input was served from cache in the study. Rewrite-style compaction invalidates the whole prefix and re-bills it. This does not.",
      "m3.t": "The model decides what to forget",
      "m3.b": "A versioned compression doctrine lives in the system prompt; a growth-gated nudge says when folding pays off. The agent judges what the task still needs, may refuse, and compresses between steps — never mid-step.",
      "m4.t": "Every token is accounted",
      "m4.b": "Each request is sampled into a per-session ledger — new content, cache reads, compression repay, TTL expiry — plotted in percentage points on a trajectory chart. Audit real savings with <code>/acp</code> in the terminal or the built-in web UI at <code>/__bili/</code>.",
      "install.title": "Up and running in under a minute",
      "install.intro": "<strong>One npm package, Node 22+.</strong> Then pick your connection style:",
      "im1.t": "Native plugin — recommended",
      "im1.b": "Installs straight into your client for the deepest integration: <code>bili plugin install pi</code>. Covers pi · omp · claude · codex · opencode · dsh · kimi · hermes · zcode.",
      "im2.t": "Launcher — works for any agent",
      "im2.b": "Wraps your client's command and injects bili automatically, zero config edits: <code>bili pi</code>, <code>bili codex</code>, <code>bili claude</code> — about twenty agents.",
      "im3.t": "Generic proxy",
      "im3.b": "Any client that accepts a custom endpoint works out of the box: point its base URL at <code>http://localhost:8787/bili/&lt;your upstream&gt;</code>.",
      "codebox.file": "terminal",
      "common.copy": "Copy",
      "common.copied": "Copied ✓",
      "install.after": "Connected? Type <code>/acp</code> in your agent for the live panel and <code>/acp-cache</code> for the token economics. Per-agent details, MITM mode and troubleshooting: <a href=\"docs/#connect\">the connect guide</a>.",
    "d.cn.chip_copy": "Click any command chip to copy it.",
    "d.cn.mcp_note": "For opencode, <code>bili plugin install opencode --with-mcp</code> also registers its MCP tools.",
    "d.cn.launcher_args": "Your own arguments pass straight through: <code>bili pi -r</code>.",
    "d.cn.url_hint": "Replace the trailing https://api.openai.com/v1 with each client's original upstream address — see the table below for exactly where to put it.",
    "d.th_cmd": "Command (click to copy)",
    "d.cf.t_compress": "compress — every knob",
    "d.cf.t_routes": "providers — route table fields",
    "d.cf.t_top": "Other top-level fields",
    "d.cf.th_param": "Parameter",
    "d.cf.th_type": "Type",
    "d.cf.th_desc": "What it does",
    "d.cf.routes_intro": "Keys are upstream URL prefixes; the longest match wins. A value of <code>{}</code> means pass-through direct.",
    "cw.mcl": "Window size (tokens) used for compression decisions; can be overridden per route or per model.",
    "cw.mxcl": "Hard ceiling on a single request's input tokens.",
    "cw.etc": "Share of the window (%) at which emergency compression fires.",
    "cw.ohmp": "Maximum share (%) of the window reserved for the model's output.",
    "cw.ngt": "Turn-over-turn growth in tokens that triggers a compression nudge.",
    "cw.prm": "Number of the most recent messages that are always kept uncompressed.",
    "cw.prt": "The most recent N tokens of history are preferentially kept uncompressed.",
    "cw.mrc": "Minimum length in characters for a range to qualify as compressible.",
    "cw.sikr": "When stripping images, the newest N are still kept.",
    "cw.tiers": "Enable tiered T1→T3 distillation.",
    "ct.pt": "Full-history exclusion: results of listed tools are never compressed (use with care).",
    "ct.plt": "Extra protection for recent occurrences of protected tools.",
    "ct.nprt": "Recent-zone exclusion list; an empty array means every tool gets recent protection.",
    "ct.prt2": "Recent-zone protection list; subtracted from the effective exclusion list.",
    "ct.si": "Strip historical image tokens (off by default).",
    "ct.vm": "Emit markers so the model knows what was stripped (on by default).",
    "ct.rules": "Inject the built-in how-to-compress rules into compression prompts.",
    "ct.it": "Expose the custom compress tool to clients (on by default).",
    "ct.in": "Send growth nudges as the window fills (on by default).",
    "co.absorb": "<code>absorb</code> — fold large tool outputs into the flow, originals stored in the content store (<span class='mech'>enabled, minToolTokens, contextThresholdPct, excludeTools, toolName</span>).",
    "co.ccr": "<code>ccr</code> — content-store retrieval: the model can fetch a stored original back by reference (<span class='mech'>enabled, minToolTokens, excludeTools, toolName, maxHeadChars</span>).",
    "co.search": "<code>search.planAware</code> — treat search calls as planning work so they do not trigger nudges.",
    "co.img": "<code>imageCompression</code> — downscale oversized images before sending (<span class='mech'>enabled, minTokens, maxDimension, quality, format: webp / jpeg / png</span>).",
    "co.prompts": "<code>prompts</code> — override the built-in doctrine texts per tier (<span class='mech'>compressPhilosophy, howToCompressRules, tier2DistillRules, tier3CondenseRules</span>).",
    "co.rg": "<code>reasoningGuard</code> — keep reasoning-model wire protocols valid across folds (<span class='mech'>enabled, maxContinue, maxTierN, markerText, base, offset, debugLog</span>).",
    "co.os": "<code>outputSteering</code> — free-form output budget steering parameters (advanced).",
    "co.pp": "<code>priceProfile</code> — relative unit-price weights w / r / q used by the economics report.",
    "co.apr": "<code>acknowledgePromptsRisk</code> — boolean you must set true before custom prompts take effect.",
    "cr.models": "Restrict this route to specific model names.",
    "cr.proxy": "Per-route upstream proxy override.",
    "cr.cp": "Which compression protocol this route speaks: marker or tools.",
    "cr.compress": "Any compress field above can be overridden here, for this route only.",
    "cr.roles": "Role mapping compatibility between OpenAI and Claude dialects.",
    "cr.pt": "Boolean: bypass processing for this route's traffic.",
    "cr.ib": "Basis for counting image tokens: auto, pixels or bytes.",
    "tt.port": "<code>port</code> — listen port (default 8787).",
    "tt.host": "<code>host</code> — bind address (localhost resolves to 127.0.0.1).",
    "tt.upstream": "<code>upstream</code> — fallback upstream when nothing else matches.",
    "tt.pp2": "<code>promptPack</code> — the doctrine pack injected into the system prompt, e.g. lean.",
    "tt.pt3": "<code>passthrough</code> — global switch: unmatched traffic passes straight through untouched.",
    "tt.debug": "<code>debug</code> — verbose per-request logging.",
    "tt.log": "<code>log</code> — master logging switch.",
    "tt.mcl2": "<code>modelContextLimit</code> — top-level default context window (default 200000).",
    "tt.proxy": "<code>proxy</code> + <code>upstreamProxyMode</code> — outbound upstream proxy; mode auto (system proxy), manual (use the proxy value) or direct.",
    "tt.mitm": "<code>mitm.enabled</code> / <code>mitm.domains</code> — HTTPS interception master switch and whitelist domains.",
    "tt.mask": "<code>maskHosts</code> — mask sensitive host names in logs (on by default).",
    "tt.subagent": "<code>subagentSplit</code> — isolate subagent side-requests into their own sessions.",
    "tt.fork": "<code>forkAdoption</code> — session adoption policy for forked processes (advanced).",
    "tt.logfile": "<code>logFile</code> — explicit path for bili.log.",
    "tt.sessionheader": "<code>sessionHeader</code> — HTTP header carrying the session id (default x-acp-session).",
    "d.wu.access": "Access: once the daemon is up, open <code>http://127.0.0.1:8787/__bili/</code> in a browser (change the port if you set ACP_PORT; it binds loopback only). Or just type <code>/acp</code> in your agent — the panel footer carries a direct link to the current session.",
    "fa.panel.q": "I can't reach the dashboard?",
    "fa.panel.a": "Check the daemon is running (<code>bili doctor</code>) and the port isn't changed (default 8787). The dashboard binds <code>127.0.0.1</code> only — from another machine or phone you need an SSH port-forward or an explicit ACP_HOST setting.",
      "doc.page_title": "billion-context · Docs",
      "d.h1": "Documentation",
      "d.sub": "Everything you need to run billion-context locally and connect your agents. Exhaustive references live in the repository: CONFIGURATION.md, TECHNICAL-NOTES.md, PLUGIN.md, SESSION-IDENTITY.md.",
      "d.toc_qs": "Quickstart",
      "d.toc_connect": "Connect clients",
      "d.toc_commands": "Commands",
      "d.toc_config": "Configuration",
      "d.toc_how": "How compression works",
      "d.toc_webui": "Web UI",
      "d.toc_privacy": "Privacy",
      "d.toc_faq": "FAQ",
      "d.toc_links": "Resources",
      "d.qs.p": "One npm package, Node 22+. Install, then start the daemon by itself — or skip straight to launching an agent:",
      "d.qs.p2": "The daemon binds loopback only — nothing is exposed externally. Every instance serves a built-in dashboard:",
      "d.cn.p": "Three ways to put the proxy between your agent and the model. Pick whichever fits your client:",
      "d.cn.m1": "Installs a thin plugin straight into the client (the original file is backed up once); deepest integration, with native in-conversation tools. Covers pi · omp · claude · codex · opencode · dsh · kimi · hermes · zcode:",
      "d.cn.m2": "Zero config edits: wraps any CLI agent and injects the proxy + compression state automatically. Each launch brings up a fresh throwaway proxy instance:",
      "d.cn.m3": "Any client that accepts a custom endpoint works out of the box: point its base URL at the prefix below, keeping the original upstream address as the tail:",
      "d.cn.table_note": "Per-client integration detail:",
      "d.th_client": "Client",
      "d.th_method": "Methods",
      "d.th_mech": "Key mechanism",
      "d.cn.mitm": "Clients that hard-code HTTPS upstreams are handled by an automatic certificate: domains the client reaches are whitelisted on first sight. Need another host? Add it explicitly:",
      "cmd.daemon": "Start the standalone proxy daemon (default port 8787).",
      "cmd.launch": "Bring up a throwaway proxy + launch the chosen client against it — no config edits.",
      "cmd.plugin": "Manage the per-client plugins and their update lanes.",
      "cmd.test": "Non-polluting smoke test through the proxy.",
      "cmd.export": "List sessions, or export one as a Markdown handoff document (--full restores original messages).",
      "cmd.doctor": "Audit every install lane: versions, owners, running proxies (read-only).",
      "cmd.update": "Check for and install a newer version now.",
      "cmd.acp": "Live context panel inside your agent — includes this session's web-dashboard link.",
      "cmd.acpcache": "Token economics report for the session: new content vs cache hits vs compression repay.",
      "d.cf.p": "Everything lives in one JSON file, created automatically on first run:",
      "d.cf.env": "Environment overrides (win over the file):",
      "d.how.p": "The same four mechanisms as the front page, condensed:",
      "d.how.paper": "The full treatment, with numbers: <a href=\"https://github.com/ranxianglei/billion-context/blob/master/paper/model-driven-incremental-hierarchical-compression-training-free-multi-generational-context-management-for-long-lived-coding-agents.md\" target=\"_blank\" rel=\"noopener\">read the preprint</a>.",
      "d.wu.p": "Every running instance serves a built-in dashboard at <code>/__bili/</code>:",
      "d.wu.ov": "Overview — total sessions and requests, gross and net savings, global hit rate with miss breakdown, protocol distribution.",
      "d.wu.se": "Sessions — usage cards, context trajectory chart, cache economics with fold detail, compression blocks, and the Markdown handoff document (copy or download).",
      "d.wu.cf": "Configuration — view and edit the JSON config; changes apply immediately.",
      "d.wu.cn": "Connect — per-instance wiring guide with copyable commands.",
      "d.wu.lo": "Logs — live tail of the daemon log, filterable by session id or keyword, downloadable as plain text.",
      "d.pr.p1": "billion-context runs only on your machine and binds loopback by default. It forwards model traffic — OAuth tokens pass through untouched, unauthenticated probes aside — and uploads nothing.",
      "d.pr.p2": "Session records stay local (<code>~/.local/share/billion-context/sessions</code>); the log sits beside the state dir. Export any session with <code>bili export</code>, delete files whenever you like.",
      "fa.node.q": "Which Node version?",
      "fa.node.a": "Node 22 or newer — required by the npm package.",
      "fa.win.q": "Does it work on Windows?",
      "fa.win.a": "Recommended: WSL2. Inside WSL everything uses 127.0.0.1 as usual; a Windows-side client should reach the proxy via the WSL host IP, or simply run the client inside WSL too.",
      "fa.cost.q": "Do I pay for the proxy itself?",
      "fa.cost.a": "No — it's free and open source (MIT plus an attribution clause). Token savings come from smaller contexts and your provider's prompt caching; the economics panel shows the real per-session numbers.",
      "fa.up.q": "How do I upgrade?",
      "fa.up.a": "Run <code>bili update</code> (or reinstall via npm). Use <code>bili doctor</code> before and after to audit every install lane.",
      "paper.kicker": "Peer-reviewable by anyone",
      "paper.t": "Model-driven incremental hierarchical compression: training-free multi-generational context management for long-lived coding agents",
      "paper.b": "The method behind the product, open-sourced under MIT inside the repository and updated as a living document. A 4.5-month production study across three hosts: 174,327 model calls, 18.76B cumulative input tokens, zero window violations.",
      "paper.cta": "Read the preprint",
      "foot.note": "MIT-licensed plus one attribution term: products built on it say so publicly. Built with open source; runs entirely on your machine."
    },
    zh: {
      "doc.title": "billion-context — 在 100K 窗口上跑月级编码会话",
      "nav.how": "工作原理",
      "nav.agents": "支持客户端",
      "nav.install": "安装",
      "nav.paper": "论文",
      "nav.docs": "文档",
      "hero.kicker_live": "运行在你自己的机器上，不碰其他数据",
      "hero.t1": "月级长会话，",
      "hero.t2": "百 K 窗口就够。",
      "hero.lede": "<strong>billion-context</strong> 是面向 AI 编码代理的本地上下文压缩代理 —— <em>billion-context is all you need.</em> 小窗口足够用：让 100K 窗口的模型连续工作数天，token 消耗最高省 5 倍，并且对移走的每个 token 都有账可查。",
      "hero.cta1": "立即开始",
      "hero.cta2": "阅读源码",
      "bullet1": "提示词缓存感知的压缩 —— 重写的代价几乎为零",
      "bullet2": "逐请求账本：新增内容 vs 复付成本，终端内直接可见",
      "bullet3": "透明代理接入 —— 无需修改任何客户端源码",
      "stat1": "单任务 token 消耗降低倍数",
      "stat2": "纵向研究覆盖的模型调用次数",
      "stat3": "累计被压缩的输入 token（B）",
      "stat4": "次窗口越界（204,800-token 模型上）",
      "stats.src": "数据来自开源的实证研究（4.5 个月、3 台主机、最长单会话 8,584–12,049 次调用）——见下方论文。",
      "wall.label": "支持你已在使用的编码代理",
      "how.title": "工作原理",
      "how.sub": "不是更大的窗口，而是更好的结构。四个机制把数月的工程量收进普通上下文上限：",
      "m1.t": "折叠，而不是重写",
      "m1.b": "历史超出预算时，只有新消耗的增量被折叠进紧凑的摘要块——每块一生只折一次。窗口在有限区间内起伏，而不是无限增长：生产会话跑过数月、上万次调用。需要细节时，任何一块都能展开回完整原文。",
      "m2.t": "服务商的缓存保持温热",
      "m2.b": "折叠只停用旧区段、不动对话开头，提示词缓存前缀因此轮轮存活——研究中活跃流量 94.2% 的输入来自缓存读取。重写式压缩会作废整个前缀、重新计费；这里不会。",
      "m3.t": "由模型决定忘记什么",
      "m3.b": "一份可版本化的压缩原则常驻系统提示词，增长门槛提醒告诉它何时折叠划算。模型自行判断当前任务还需要什么，有权拒绝，只在步骤之间压缩——绝不打断步骤。",
      "m4.t": "每个 token 都有账",
      "m4.b": "每次请求采样进逐会话账本——新增内容、缓存命中、压缩复付、TTL 过期——以百分点绘成轨迹图。终端里敲 <code>/acp</code>，或打开内置 Web UI <code>/__bili/</code>，审计真实节省。",
      "install.title": "不到一分钟即可上手",
      "install.intro": "<strong>一个 npm 包，Node 22+。</strong>然后选择接入方式：",
      "im1.t": "原生插件 —— 推荐",
      "im1.b": "直接装进客户端、集成最深：<code>bili plugin install pi</code>。覆盖 pi · omp · claude · codex · opencode · dsh · kimi · hermes · zcode。",
      "im2.t": "启动器 —— 任意代理都可用",
      "im2.b": "包住你的客户端命令、自动注入 bili，零配置改动：<code>bili pi</code>、<code>bili codex</code>、<code>bili claude</code> —— 约二十个代理。",
      "im3.t": "通用代理",
      "im3.b": "任何支持自定义接入地址的客户端开箱即用：把它的 base URL 指向 <code>http://localhost:8787/bili/&lt;原上游地址&gt;</code>。",
      "codebox.file": "终端",
      "common.copy": "复制",
      "common.copied": "已复制 ✓",
      "install.after": "接好了？在 Agent 里输入 <code>/acp</code> 看实时面板、<code>/acp-cache</code> 看 token 经济学。各客户端细节、MITM 模式与排障：<a href=\"docs/#connect\">接入指南</a>。",
    "d.cn.chip_copy": "点击上方任意命令即可复制。",
    "d.cn.mcp_note": "opencode 用 <code>bili plugin install opencode --with-mcp</code> 可同时注册其 MCP 工具。",
    "d.cn.launcher_args": "自己的参数直接跟在后面：<code>bili pi -r</code>。",
    "d.cn.url_hint": "把尾部 https://api.openai.com/v1 换成各客户端原来的上游地址——具体放哪见下表。",
    "d.th_cmd": "命令（点击复制）",
    "d.cf.t_compress": "compress —— 逐项说明",
    "d.cf.t_routes": "providers —— 路由表字段",
    "d.cf.t_top": "其他顶层字段",
    "d.cf.th_param": "参数",
    "d.cf.th_type": "类型",
    "d.cf.th_desc": "作用",
    "d.cf.routes_intro": "键是上游 URL 前缀，最长前缀优先；值为 <code>{}</code> 表示直转。",
    "cw.mcl": "压缩判断所用的窗口大小（token），可按路由或模型覆盖。",
    "cw.mxcl": "单请求输入 token 的硬上限。",
    "cw.etc": "达到窗口占比（%）即触发紧急压缩。",
    "cw.ohmp": "为模型输出预留的窗口最大占比（%）。",
    "cw.ngt": "相邻轮次增长（token）达到该值时发出压缩提醒。",
    "cw.prm": "始终保留不压缩的最近消息条数。",
    "cw.prt": "优先保留不压缩的最近 N 个 token。",
    "cw.mrc": "片段可被压缩的最小字符数。",
    "cw.sikr": "剥离图片时，最近的 N 张仍保留。",
    "cw.tiers": "启用 T1→T3 分级蒸馏。",
    "ct.pt": "全历史排除：列出工具的结果永不压缩（慎用）。",
    "ct.plt": "对受保护工具在近期历史中的出现给予额外保护。",
    "ct.nprt": "近期区排除列表；空数组表示所有工具都进近期保护。",
    "ct.prt2": "近期区保护列表；从有效排除列表中减去。",
    "ct.si": "剥离历史图片 token（默认关）。",
    "ct.vm": "注入标记，让模型知道哪些内容被剥离（默认开）。",
    "ct.rules": "把内置压缩规则注入压缩提示词。",
    "ct.it": "向客户端暴露自定义压缩工具（默认开）。",
    "ct.in": "窗口接近满时发送增长提醒（默认开）。",
    "co.absorb": "<code>absorb</code> —— 把大段工具输出折叠进流程，原文存入内容库（<span class='mech'>enabled, minToolTokens, contextThresholdPct, excludeTools, toolName</span>）。",
    "co.ccr": "<code>ccr</code> —— 内容库回取：模型可按引用取回存好的原文（<span class='mech'>enabled, minToolTokens, excludeTools, toolName, maxHeadChars</span>）。",
    "co.search": "<code>search.planAware</code> —— 搜索类调用视为规划动作，不触发提醒。",
    "co.img": "<code>imageCompression</code> —— 发送前压缩超大图片（<span class='mech'>enabled, minTokens, maxDimension, quality, format: webp / jpeg / png</span>）。",
    "co.prompts": "<code>prompts</code> —— 按层级覆盖内置教条文本（<span class='mech'>compressPhilosophy, howToCompressRules, tier2DistillRules, tier3CondenseRules</span>）。",
    "co.rg": "<code>reasoningGuard</code> —— 保证推理模型的线上协议在折叠后依然合法（<span class='mech'>enabled, maxContinue, maxTierN, markerText, base, offset, debugLog</span>）。",
    "co.os": "<code>outputSteering</code> —— 输出预算引导参数（高级，自由对象）。",
    "co.pp": "<code>priceProfile</code> —— 经济学报告用的相对单价权重 w / r / q。",
    "co.apr": "<code>acknowledgePromptsRisk</code> —— 必须置 true 才会启用自定义 prompts。",
    "cr.models": "限定本路由只对指定模型名生效。",
    "cr.proxy": "本路由独立的上游代理覆盖。",
    "cr.cp": "本路由使用的压缩协议：marker 或 tools。",
    "cr.compress": "上面任意 compress 字段都可在此按路由覆盖。",
    "cr.roles": "OpenAI 与 Claude 两种角色体系间的映射兼容。",
    "cr.pt": "布尔：该路由流量跳过处理、直接透传。",
    "cr.ib": "图片 token 计数口径：auto、pixels 或 bytes。",
    "tt.port": "<code>port</code> —— 监听端口（默认 8787）。",
    "tt.host": "<code>host</code> —— 绑定地址（localhost 解析为 127.0.0.1）。",
    "tt.upstream": "<code>upstream</code> —— 兜底上游（无其他匹配时使用）。",
    "tt.pp2": "<code>promptPack</code> —— 注入系统提示词的教条包，如 lean。",
    "tt.pt3": "<code>passthrough</code> —— 全局开关：未匹配流量原样透传。",
    "tt.debug": "<code>debug</code> —— 逐请求详细日志。",
    "tt.log": "<code>log</code> —— 总日志开关。",
    "tt.mcl2": "<code>modelContextLimit</code> —— 顶层默认上下文窗口（默认 200000）。",
    "tt.proxy": "<code>proxy</code> + <code>upstreamProxyMode</code> —— 出站上游代理；模式 auto（跟随系统）/ manual（用 proxy 值）/ direct（直连）。",
    "tt.mitm": "<code>mitm.enabled</code> / <code>mitm.domains</code> —— HTTPS 拦截总开关与白名单域名。",
    "tt.mask": "<code>maskHosts</code> —— 日志中屏蔽敏感主机名（默认开）。",
    "tt.subagent": "<code>subagentSplit</code> —— 子代理侧请求隔离到独立会话。",
    "tt.fork": "<code>forkAdoption</code> —— fork 进程的会话接管策略（高级）。",
    "tt.logfile": "<code>logFile</code> —— bili.log 的显式路径。",
    "tt.sessionheader": "<code>sessionHeader</code> —— 携带会话 id 的请求头（默认 x-acp-session）。",
    "d.wu.access": "访问方式：守护进程运行后，浏览器打开 <code>http://127.0.0.1:8787/__bili/</code>（改过 ACP_PORT 请换端口；默认只监听本机回环）。也可以在 agent 里输入 <code>/acp</code>——面板底部有当前会话的直达链接。",
    "fa.panel.q": "打不开面板怎么办？",
    "fa.panel.a": "先确认守护进程在跑（<code>bili doctor</code>）、端口没被改（默认 8787）。面板只绑定 <code>127.0.0.1</code>——在别的机器或手机上看需要 SSH 端口转发，或显式设置 ACP_HOST。",
      "doc.page_title": "billion-context · 文档",
      "d.h1": "使用文档",
      "d.sub": "本地运行 billion-context 并接入客户端所需的全部内容。更详尽的参考在仓库里：CONFIGURATION.md、TECHNICAL-NOTES.md、PLUGIN.md、SESSION-IDENTITY.md。",
      "d.toc_qs": "快速开始",
      "d.toc_connect": "接入客户端",
      "d.toc_commands": "常用命令",
      "d.toc_config": "配置",
      "d.toc_how": "压缩原理",
      "d.toc_webui": "Web 面板",
      "d.toc_privacy": "隐私安全",
      "d.toc_faq": "常见问题",
      "d.toc_links": "资源链接",
      "d.qs.p": "一个 npm 包，需要 Node 22+。装好后可以单独启动守护进程——或者直接用启动器拉起 Agent：",
      "d.qs.p2": "守护进程默认只绑定回环地址，不对外暴露。每个实例都自带内置仪表盘：",
      "d.cn.p": "把代理放进你的 Agent 与模型之间，有三种方式——任选适合你客户端的：",
      "d.cn.m1": "把轻量插件直接装进客户端（原文件自动备份一次），集成最深、会话内提供原生工具。覆盖 pi · omp · claude · codex · opencode · dsh · kimi · hermes · zcode：",
      "d.cn.m2": "零配置改动：包住任意 CLI agent，自动注入代理与压缩状态；每次启动都是一次性的独立代理实例：",
      "d.cn.m3": "支持自定义端点的客户端开箱即用：把它的 base URL 指向前缀地址，原上游地址作为尾部保留：",
      "d.cn.table_note": "各客户端接入细节：",
      "d.th_client": "客户端",
      "d.th_method": "方式",
      "d.th_mech": "关键机制",
      "d.cn.mitm": "对写死 HTTPS 上游的客户端自动签发证书：客户端访问到的域名首次发现即自动加入白名单。需要其它主机？显式指定：",
      "cmd.daemon": "单独启动代理守护进程（默认端口 8787）。",
      "cmd.launch": "临时拉起一个代理并用它启动指定客户端——不改任何配置。",
      "cmd.plugin": "管理各客户端插件及其更新通道。",
      "cmd.test": "不污染真实配置的代理冒烟测试。",
      "cmd.export": "列出会话，或导出某个会话为 Markdown 交接文档（--full 还原原始消息）。",
      "cmd.doctor": "审计所有安装通道：版本、归属、运行中的代理进程（只读）。",
      "cmd.update": "立即检查并安装新版本。",
      "cmd.acp": "Agent 内的实时上下文面板——附带该会话的 Web 面板链接。",
      "cmd.acpcache": "本会话的 token 经济学报告：新增内容 vs 缓存命中 vs 压缩复付。",
      "d.cf.p": "全部配置在这一个 JSON 文件里，首次运行自动生成：",
      "d.cf.env": "环境变量覆盖（优先于配置文件）：",
      "d.how.p": "首页四个机制的简版：",
      "d.how.paper": "完整论述与全部数据见论文：<a href=\"https://github.com/ranxianglei/billion-context/blob/master/paper/model-driven-incremental-hierarchical-compression-training-free-multi-generational-context-management-for-long-lived-coding-agents.md\" target=\"_blank\" rel=\"noopener\">阅读预印本</a>。",
      "d.wu.p": "每个运行中的实例都在 <code>/__bili/</code> 提供内置仪表盘：",
      "d.wu.ov": "总览 —— 会话与请求总数、累计节省与净节省、全局命中率及未命中分解、协议分布。",
      "d.wu.se": "会话 —— 用量统计、上下文轨迹图、缓存经济学（含折叠明细）、压缩块与会话交接文档（可复制/下载）。",
      "d.wu.cf": "配置 —— 查看并编辑 JSON 配置，保存即时生效。",
      "d.wu.cn": "接入 —— 针对当前实例端口的接线指引，命令可直接复制。",
      "d.wu.lo": "日志 —— 守护进程日志实时尾部，可按会话 id 或关键字过滤，支持下载纯文本。",
      "d.pr.p1": "billion-context 只运行在你自己的机器上，默认绑定回环地址。它只是转发模型流量——OAuth token 原样透传，不上传任何数据。",
      "d.pr.p2": "会话记录保存在本地（<code>~/.local/share/billion-context/sessions</code>），日志在 state 目录旁。用 <code>bili export</code> 随时导出，文件想删就删。",
      "fa.node.q": "需要什么 Node 版本？",
      "fa.node.a": "Node 22 或更新版本（npm 包的要求）。",
      "fa.win.q": "Windows 上能用吗？",
      "fa.win.a": "推荐在 WSL2 中运行。WSL 内一切照常用 127.0.0.1；Windows 侧客户端可改用 WSL 主机 IP 访问代理，或干脆把客户端也跑在 WSL 里。",
      "fa.cost.q": "代理本身要付费吗？",
      "fa.cost.a": "不要——免费开源（MIT 加一条署名条款）。token 节省来自更小的上下文和你所在服务商的提示词缓存；经济学面板展示每个会话的真实数字。",
      "fa.up.q": "怎么升级？",
      "fa.up.a": "运行 <code>bili update</code>（或重新 npm 安装）；升级前后用 <code>bili doctor</code> 审计各安装通道。",
      "paper.kicker": "方法完全公开可审",
      "paper.t": "Model-driven incremental hierarchical compression：免训练的多代际上下文管理，面向长生命周期编码代理",
      "paper.b": "产品背后的方法已随仓库以 MIT 协议开源，并以活文档形式持续更新。4.5 个月的生产实测横跨三台主机：174,327 次模型调用、187.6 亿累计输入 token、零窗口越界。",
      "paper.cta": "阅读论文（英文）",
      "foot.note": "MIT 许可加一条署名条款：基于它的产品需公开说明出处。完全开源构建；只在你自己的机器上运行。"
    }
  };

  var KEY = "bc-lang";

  function initLang() {
    var h = location.hash.slice(1);
    var s = new URLSearchParams(location.search);
    var l = s.get("lang") || (h === "zh" || h === "en" ? h : null);
    if (l) { try { localStorage.setItem(KEY, l); } catch (e) {}
      history.replaceState(null, "", location.pathname); }
    try { return localStorage.getItem(KEY) === "zh" ? "zh" : "en"; } catch (e) { return "en"; }
  }

  function apply(lang) {
    var dict = I18N[lang] || I18N.en;
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var k = el.getAttribute("data-i18n");
      if (dict[k] != null) el.textContent = dict[k];
    });
    document.querySelectorAll("[data-i18n-html]").forEach(function (el) {
      var k = el.getAttribute("data-i18n-html");
      if (dict[k] != null) el.innerHTML = dict[k];
    });
    document.title = dict["doc.title"];
    var desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute("content", lang === "zh" ? "billion-context：AI 编码代理的上下文压缩代理 —— 小窗口足够用，token 最高省 5 倍，月级单会话，每个 token 都有账可查。" : "billion-context is a context-compression proxy for AI coding agents: small context windows are enough, 5x fewer tokens, month-long single sessions, and a token-level ledger for every request.");
    var btn = document.getElementById("lang-toggle");
    if (btn) btn.textContent = lang === "zh" ? "English" : "中文";
  }

  apply(initLang());
  window.addEventListener("hashchange", function () {
    var h = location.hash.slice(1);
    if (h === "zh" || h === "en") apply(h);
  });

  var toggle = document.getElementById("lang-toggle");
  if (toggle) toggle.addEventListener("click", function () {
    var next = document.documentElement.lang.indexOf("zh") === 0 ? "en" : "zh";
    try { localStorage.setItem(KEY, next); } catch (e) {}
    apply(next);
  });

  /* copy buttons */
  function doCopy(text, btn, done) {
    var fallback = function () {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
  }
  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest(".copy-btn");
    if (!btn) return;
    var text = btn.getAttribute("data-copy") || "";
    var label = btn.textContent;
    doCopy(text, btn, function () {
      btn.textContent = I18N[document.documentElement.lang.indexOf("zh") === 0 ? "zh" : "en"]["common.copied"];
      setTimeout(function () { btn.textContent = label; }, 1600);
    });
  });

  /* scroll reveal */
  var nodes = document.querySelectorAll("[data-reveal]");
  if ("IntersectionObserver" in window) {
    nodes.forEach(function (n) {
      var d = n.getAttribute("data-delay");
      if (d) n.style.setProperty("--rd", d + "ms");
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    nodes.forEach(function (n) { io.observe(n); });
  } else {
    nodes.forEach(function (n) { n.classList.add("in"); });
  }
  // fail-safe: never leave content hidden (IO quirks / headless / print)
  setTimeout(function () { nodes.forEach(function (n) { n.classList.add("in"); }); }, 1600);
})();
