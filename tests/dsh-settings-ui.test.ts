import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { apply, _resetRegisterForTest } from "../src/agent/dsh-native.ts";
import { rmrf } from "./tmp-rm.ts";

// The node:test runner sets NODE_TEST_CONTEXT itself (see tests/e2e/README.md);
// set it defensively so a direct single-file run also stands down the spawn
// bootstrap and the global fetch intercept.
process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT ?? "1";

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const prev: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
        prev[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return await fn();
    } finally {
        for (const [key, value] of Object.entries(prev)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function startManifestProxy(): Promise<{ origin: string; close: () => void }> {
    const server = http.createServer((req, res) => {
        if ((req.url ?? "").startsWith("/__bili/plugin/manifest")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "0.1.166", tools: { anthropic: [] } }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
        });
    });
}

type InjectRow = { kind: string; name?: string; value?: unknown };
type InjectListener = (table: InjectRow[]) => void;

function uiCtx(listeners: InjectListener[]) {
    return {
        tools: { register: (_t: unknown) => {} },
        commands: { register: (_c: unknown) => {} },
        agents: { currentInitiator: () => ({ session: { id: "s-1590" } }) },
        inject: (_deps: readonly string[], _cb: (sub: unknown) => void) => {},
        on: (event: string, listener: InjectListener) => {
            if (event === "webserver/index-inject") listeners.push(listener);
        },
    };
}

test("#1590: webserver/index-inject publishes __BILI__ while an origin is known (attach mode)", async () => {
    const proxy = await startManifestProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const listeners: InjectListener[] = [];
            apply(uiCtx(listeners) as Parameters<typeof apply>[0]);
            // attach mode binds register.base synchronously before the async
            // liveness probe, so a startup-time collection already sees it.
            assert.equal(listeners.length, 1);
            const table: InjectRow[] = [];
            listeners[0](table);
            assert.deepEqual(table, [{ kind: "global", name: "__BILI__", value: { origin: proxy.origin } }]);
        });
    } finally {
        proxy.close();
        rmrf(home);
    }
});

test("#1590: index-inject stays silent when no origin is known yet (spawn mode)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            _resetRegisterForTest(undefined);
            const listeners: InjectListener[] = [];
            apply(uiCtx(listeners) as Parameters<typeof apply>[0]);
            assert.equal(listeners.length, 1);
            const table: InjectRow[] = [];
            listeners[0](table);
            assert.deepEqual(table, []);
        });
    } finally {
        rmrf(home);
    }
});

type RouteRow = { kind: string; path: string; handler: (req: unknown, res: FakeRes) => void | Promise<void> };

class FakeRes {
    status?: number;
    headers?: Record<string, string>;
    body = "";
    writeHead(status: number, headers?: Record<string, string>): void {
        this.status = status;
        this.headers = headers;
    }
    end(body?: string): void {
        this.body = body ?? "";
    }
}

function routeCtx(routes: RouteRow[], listeners: InjectListener[]) {
    return {
        tools: { register: (_t: unknown) => {} },
        commands: { register: (_c: unknown) => {} },
        agents: { currentInitiator: () => ({ session: { id: "s-1809" } }) },
        inject: (_deps: readonly string[], cb: (sub: unknown) => void) => {
            cb({ webServer: { register: (r: RouteRow) => routes.push(r) } });
        },
        on: (event: string, listener: InjectListener) => {
            if (event === "webserver/index-inject") listeners.push(listener);
        },
    };
}

test("#1809: live /bili/origin route reflects the bound origin", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            _resetRegisterForTest("http://127.0.0.1:8787");
            const routes: RouteRow[] = [];
            apply(routeCtx(routes, []) as Parameters<typeof apply>[0]);
            assert.equal(routes.length, 1);
            assert.equal(routes[0].kind, "exact");
            assert.equal(routes[0].path, "/bili/origin");
            const res = new FakeRes();
            await routes[0].handler({}, res);
            assert.equal(res.status, 200);
            assert.equal(res.headers?.["content-type"], "application/json");
            assert.deepEqual(JSON.parse(res.body), { origin: "http://127.0.0.1:8787" });
        });
    } finally {
        rmrf(home);
    }
});

test("#1809: /bili/origin answers null before binding", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            _resetRegisterForTest(undefined);
            const routes: RouteRow[] = [];
            apply(routeCtx(routes, []) as Parameters<typeof apply>[0]);
            assert.equal(routes.length, 1);
            const res = new FakeRes();
            await routes[0].handler({}, res);
            assert.deepEqual(JSON.parse(res.body), { origin: null });
        });
    } finally {
        rmrf(home);
    }
});

test("#1809: route registration rides the injected context's effect lifecycle", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            _resetRegisterForTest("http://127.0.0.1:8787");
            const routes: RouteRow[] = [];
            let disposed = 0;
            const effects: Array<{ fn: () => void | (() => void); label?: string }> = [];
            const ctx = {
                tools: { register: (_t: unknown) => {} },
                commands: { register: (_c: unknown) => {} },
                agents: { currentInitiator: () => ({ session: { id: "s-1809" } }) },
                inject: (_deps: readonly string[], cb: (sub: unknown) => void) => {
                    cb({
                        webServer: {
                            register: (r: RouteRow) => {
                                routes.push(r);
                                return (): void => { disposed += 1; };
                            },
                        },
                        effect: (fn: () => void | (() => void), label?: string) => {
                            effects.push({ fn, label });
                        },
                    });
                },
                on: (_event: string, _listener: InjectListener) => {},
            };
            apply(ctx as Parameters<typeof apply>[0]);
            assert.equal(effects.length, 1, "registration must be wrapped in the context effect");
            assert.equal(effects[0].label, "bili: /bili/origin route");
            const cleanup = effects[0].fn();
            assert.equal(routes.length, 1);
            assert.equal(typeof cleanup, "function", "the disposer doubles as the effect cleanup");
            (cleanup as () => void)();
            assert.equal(disposed, 1);
        });
    } finally {
        rmrf(home);
    }
});

type ElementNode = { type: string; props: Record<string, unknown> | null; children: unknown[] };

function collectText(node: unknown, out: string[]): void {
    if (typeof node === "string") {
        out.push(node);
        return;
    }
    if (Array.isArray(node)) {
        for (const child of node) collectText(child, out);
        return;
    }
    if (node !== null && typeof node === "object") {
        for (const child of (node as ElementNode).children ?? []) collectText(child, out);
    }
}

function findButton(node: unknown): ElementNode | undefined {
    if (node !== null && typeof node === "object") {
        const el = node as ElementNode;
        if (el.type === "button") return el;
        for (const child of el.children ?? []) {
            const hit = findButton(child);
            if (hit !== undefined) return hit;
        }
    }
    return undefined;
}

function findTag(node: unknown, type: string): ElementNode | undefined {
    if (node !== null && typeof node === "object") {
        const el = node as ElementNode;
        if (el.type === type) return el;
        for (const child of el.children ?? []) {
            const hit = findTag(child, type);
            if (hit !== undefined) return hit;
        }
    }
    return undefined;
}

test("#1590/#2125: client bundle registers the settings.section entry bili AND the plugins.bundle.config panel (wrapper id, require purity, both render branches)", async () => {
    const { build } = await import("esbuild");
    // Reuse tsup.config.ts as the single source of truth for the wrapper
    // banner/footer and externals so the test cannot drift from the shipped
    // bundle shape.
    const configs = ((await import("../tsup.config.ts")).default) as unknown as Array<{
        entry: Record<string, string>;
        platform: string;
        target: string;
        external?: string[];
        banner?: { js?: string };
        footer?: { js?: string };
    }>;
    const cfg = configs.find((c) => c.entry["agent/dsh-native-client"] !== undefined);
    assert.ok(cfg !== undefined, "tsup config must keep the dsh client entry");
    const result = await build({
        entryPoints: [cfg.entry["agent/dsh-native-client"]],
        bundle: true,
        format: "cjs",
        platform: cfg.platform as Parameters<typeof build>[0]["platform"],
        target: cfg.target,
        external: cfg.external,
        banner: cfg.banner,
        footer: cfg.footer,
        write: false,
    });
    assert.equal(result.outputFiles!.length, 1);
    const code = result.outputFiles![0].text;

    const registrations: Array<{ id: string; factory: (require: (spec: string) => unknown) => unknown }> = [];
    const sandbox: Record<string, unknown> = {};
    sandbox.window = { __ModuleLoader__: { load: (reg: (typeof registrations)[number]) => registrations.push(reg) } };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: "dsh-native-client.bundle.js" });
    assert.equal(registrations.length, 1);
    // Must equal the loader entry name the scanner keys its graph row by.
    assert.equal(registrations[0].id, "billion-context");

    const calls: ElementNode[] = [];
    // Minimal hook emulation (#1809): per-mount state persisting across
    // component() re-renders; effects run synchronously, cleanups collected.
    let hookStates: unknown[] = [];
    let hookIndex = 0;
    const cleanups: Array<() => void> = [];
    const resetHooks = (): void => {
        hookStates = [];
        hookIndex = 0;
        cleanups.length = 0;
    };
    const reactStub = {
        createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]): ElementNode => {
            const el = { type, props, children };
            calls.push(el);
            return el;
        },
        useState: (init: unknown): [unknown, (v: unknown) => void] => {
            const i = hookIndex++;
            if (!(i in hookStates)) hookStates[i] = typeof init === "function" ? (init as () => unknown)() : init;
            return [hookStates[i], (v: unknown) => { hookStates[i] = v; }];
        },
        useEffect: (fn: () => unknown | (() => void)): void => {
            hookIndex++;
            const r = fn();
            if (typeof r === "function") cleanups.push(r as () => void);
        },
    };
    const requireStub = (spec: string): unknown => {
        if (spec === "react") return reactStub;
        throw new Error(`unexpected external require: ${spec}`);
    };
    const face = registrations[0].factory(requireStub) as { inject: string[]; apply: (ctx: unknown) => void };
    // Re-materialize in the host realm: vm-context arrays carry the sandbox's
    // Array.prototype, which deepStrictEqual rejects.
    assert.deepEqual(Array.from(face.inject), ["slots", "locale"]);
    assert.equal(typeof face.apply, "function");

    type Entry = { options: Record<string, unknown>; component: () => unknown };
    const runApply = (): { slots: string[]; bySlot: Map<string, Entry>; zh: Record<string, string>; en: Record<string, string> } => {
        const effects: Array<() => void> = [];
        const dicts: Record<string, { zh: Record<string, string>; en: Record<string, string> }> = {};
        const slots: string[] = [];
        const bySlot = new Map<string, Entry>();
        let current: string | undefined;
        face.apply({
            effect: (fn: () => void, _label?: string) => effects.push(fn),
            locale: {
                register: (ns: string, dict: { zh: Record<string, string>; en: Record<string, string> }) => {
                    dicts[ns] = dict;
                },
                bind: (ns: string) => (key: string) => dicts[ns]?.zh?.[key] ?? key,
            },
            slots: {
                inject: (name: string, p: () => void) => {
                    slots.push(name);
                    current = name;
                    p();
                },
                register: (opts: Record<string, unknown>, comp: () => unknown) => {
                    // Hook indices restart on every render (React matches hooks
                    // by position within a single render), so wrap the entry.
                    bySlot.set(current!, { options: opts, component: (): unknown => { hookIndex = 0; return comp(); } });
                },
            },
        });
        for (const eff of effects) eff();
        assert.deepEqual(slots, ["settings.section", "plugins.bundle.config"]);
        assert.equal(bySlot.size, 2);
        assert.ok(dicts["bili"] !== undefined);
        return { slots, bySlot, zh: dicts["bili"].zh, en: dicts["bili"].en };
    };

    sandbox.__BILI__ = { origin: "http://127.0.0.1:8787" };
    const withOrigin = runApply();
    const settings = withOrigin.bySlot.get("settings.section")!;
    assert.equal(settings.options.name, "settings.section");
    assert.equal(settings.options.id, "bili");
    assert.equal(settings.options.order, 100);
    assert.equal(settings.options.locale, "bili");
    assert.equal(typeof settings.options.label, "function");
    assert.equal((settings.options.label as () => string)(), "bili设置");
    const bundle = withOrigin.bySlot.get("plugins.bundle.config")!;
    assert.equal(bundle.options.name, "plugins.bundle.config");
    assert.equal(bundle.options.key, "billion-context");
    assert.equal(bundle.options.locale, "bili");
    // Keyed slot: the host matches the key against its own package name — no
    // list-slot fields may ride along.
    assert.deepEqual(Object.keys(bundle.options).sort(), ["key", "locale", "name"]);
    assert.deepEqual(Object.keys(withOrigin.zh).sort(), Object.keys(withOrigin.en).sort());
    calls.length = 0;
    resetHooks();
    const tree = settings.component() as ElementNode;
    assert.equal(tree.type, "div");
    assert.notEqual(findTag(tree, "h3"), undefined, "the settings section keeps its own title");
    const button = findButton(tree);
    assert.ok(button !== undefined, "origin present renders the open button");
    assert.equal(typeof button.props?.onClick, "function");
    const texts: string[] = [];
    collectText(tree, texts);
    assert.ok(texts.some((t) => t.includes("http://127.0.0.1:8787")), `button label carries the origin: ${JSON.stringify(texts)}`);
    const opened: string[] = [];
    sandbox.open = (url: string) => opened.push(url);
    (button.props!.onClick as () => void)();
    assert.deepEqual(opened, ["http://127.0.0.1:8787/__bili/"]);

    // #2125: the bundle panel reuses the probe/button/hint but drops the title
    // — the plugin detail page draws it.
    calls.length = 0;
    resetHooks();
    const btree = bundle.component() as ElementNode;
    assert.equal(btree.type, "div");
    assert.equal(findTag(btree, "h3"), undefined, "the bundle panel does not repeat the page title");
    const bButton = findButton(btree);
    assert.ok(bButton !== undefined, "origin present renders the open button in the bundle panel");
    assert.equal(typeof bButton.props?.onClick, "function");
    const btexts: string[] = [];
    collectText(btree, btexts);
    assert.ok(btexts.some((x) => x.includes("http://127.0.0.1:8787")), `bundle button label carries the origin: ${JSON.stringify(btexts)}`);
    opened.length = 0;
    (bButton.props!.onClick as () => void)();
    assert.deepEqual(opened, ["http://127.0.0.1:8787/__bili/"]);

    delete sandbox.__BILI__;
    const degraded = runApply();
    calls.length = 0;
    resetHooks();
    const degTree = degraded.bySlot.get("settings.section")!.component() as ElementNode;
    assert.equal(findButton(degTree), undefined);
    const degTexts: string[] = [];
    collectText(degTree, degTexts);
    assert.ok(degTexts.some((t) => t.includes("/acp")), `degraded hint points at /acp: ${JSON.stringify(degTexts)}`);
    resetHooks();
    const degBundleTree = degraded.bySlot.get("plugins.bundle.config")!.component() as ElementNode;
    assert.equal(findButton(degBundleTree), undefined, "the bundle panel degrades like the settings section");
    const degBundleTexts: string[] = [];
    collectText(degBundleTree, degBundleTexts);
    assert.ok(degBundleTexts.some((t) => t.includes("/acp")), "the bundle degraded hint points at /acp");
});

test("#1809/#2125: client polls /bili/origin while unresolved — upgrades on success, stays degraded and cancels when absent (both slots)", async () => {
    const { build } = await import("esbuild");
    const configs = ((await import("../tsup.config.ts")).default) as unknown as Array<{
        entry: Record<string, string>;
        platform: string;
        target: string;
        external?: string[];
        banner?: { js?: string };
        footer?: { js?: string };
    }>;
    const cfg = configs.find((c) => c.entry["agent/dsh-native-client"] !== undefined);
    assert.ok(cfg !== undefined, "tsup config must keep the dsh client entry");
    const result = await build({
        entryPoints: [cfg.entry["agent/dsh-native-client"]],
        bundle: true,
        format: "cjs",
        platform: cfg.platform as Parameters<typeof build>[0]["platform"],
        target: cfg.target,
        external: cfg.external,
        banner: cfg.banner,
        footer: cfg.footer,
        write: false,
    });
    const code = result.outputFiles![0].text;

    type Face = { inject: string[]; apply: (ctx: unknown) => void };
    const mount = (extra: Record<string, unknown>, slotName = "settings.section"): { component: () => unknown; resetHooks: () => void; runCleanups: () => void } => {
        const registrations: Array<{ id: string; factory: (require: (spec: string) => unknown) => unknown }> = [];
        const sandbox: Record<string, unknown> = {};
        sandbox.window = { __ModuleLoader__: { load: (reg: (typeof registrations)[number]) => registrations.push(reg) } };
        Object.assign(sandbox, extra);
        vm.createContext(sandbox);
        vm.runInContext(code, sandbox, { filename: "dsh-native-client.bundle.js" });
        assert.equal(registrations.length, 1);
        const calls: ElementNode[] = [];
        let hookStates: unknown[] = [];
        let hookIndex = 0;
        const cleanups: Array<() => void> = [];
        const reactStub = {
            createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]): ElementNode => {
                const el = { type, props, children };
                calls.push(el);
                return el;
            },
            useState: (init: unknown): [unknown, (v: unknown) => void] => {
                const i = hookIndex++;
                if (!(i in hookStates)) hookStates[i] = typeof init === "function" ? (init as () => unknown)() : init;
                return [hookStates[i], (v: unknown) => { hookStates[i] = v; }];
            },
            useEffect: (fn: () => unknown | (() => void)): void => {
                hookIndex++;
                const r = fn();
                if (typeof r === "function") cleanups.push(r as () => void);
            },
        };
        const requireStub = (spec: string): unknown => {
            if (spec === "react") return reactStub;
            throw new Error(`unexpected external require: ${spec}`);
        };
        const face = registrations[0].factory(requireStub) as Face;
        const dicts: Record<string, { zh: Record<string, string>; en: Record<string, string> }> = {};
        const components = new Map<string, () => unknown>();
        let current: string | undefined;
        face.apply({
            effect: (fn: () => void) => fn(),
            locale: {
                register: (ns: string, dict: { zh: Record<string, string>; en: Record<string, string> }) => {
                    dicts[ns] = dict;
                },
                bind: (ns: string) => (key: string) => dicts[ns]?.zh?.[key] ?? key,
            },
            slots: {
                inject: (name: string, p: () => void) => {
                    current = name;
                    p();
                },
                register: (_opts: Record<string, unknown>, comp: () => unknown) => {
                    components.set(current!, comp);
                },
            },
        });
        assert.ok(components.has(slotName), `slot ${slotName} must be registered`);
        const bound = components.get(slotName)!;
        return {
            // Hook indices restart on every render (React semantics).
            component: (): unknown => { hookIndex = 0; return bound(); },
            resetHooks: () => {
                hookStates = [];
                hookIndex = 0;
                cleanups.length = 0;
            },
            runCleanups: () => {
                for (const c of cleanups.splice(0)) c();
            },
        };
    };

    const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

    {
        const opened: string[] = [];
        const fetched: string[] = [];
        const m = mount({
            open: (url: string) => opened.push(url),
            fetch: async (url: string) => {
                fetched.push(url);
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:9999" }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findButton(first), undefined, "first paint before the probe resolves is still degraded");
        await tick();
        const second = m.component() as ElementNode;
        const button = findButton(second);
        assert.ok(button !== undefined, "resolved origin upgrades the entry without a reload");
        (button.props!.onClick as () => void)();
        assert.deepEqual(opened, ["http://127.0.0.1:9999/__bili/"]);
        assert.deepEqual(fetched, ["/bili/origin"], "one probe suffices once the origin arrives");
        m.runCleanups();
    }

    {
        let cleared = 0;
        const m = mount({
            fetch: async () => ({ ok: false, json: async () => ({}) }),
            setTimeout,
            clearTimeout: (t: unknown) => {
                cleared += 1;
                clearTimeout(t as ReturnType<typeof setTimeout>);
            },
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findButton(first), undefined);
        await tick();
        const second = m.component() as ElementNode;
        assert.equal(findButton(second), undefined, "a host without the route keeps the entry degraded");
        m.runCleanups();
        assert.ok(cleared >= 1, "pending retry timers are cancelled on unmount");
    }

    {
        // #2125: the bundle panel runs the same probe wiring through its own
        // registration.
        const opened: string[] = [];
        const m = mount(
            {
                open: (url: string) => opened.push(url),
                fetch: async () => ({ ok: true, json: async () => ({ origin: "http://127.0.0.1:9999" }) }),
                setTimeout,
                clearTimeout,
            },
            "plugins.bundle.config",
        );
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findButton(first), undefined);
        await tick();
        const second = m.component() as ElementNode;
        const button = findButton(second);
        assert.ok(button !== undefined, "the bundle panel upgrades on a resolved origin");
        (button.props!.onClick as () => void)();
        assert.deepEqual(opened, ["http://127.0.0.1:9999/__bili/"]);
        m.runCleanups();
    }
});

test("#2125: the manifest declares no dsh.client.inject (pre-0.2 dsh compat)", () => {
    // dsh < 0.2.x cannot resolve "@deepseek-ai/dsh-client-ui-plugin-manager" and its
    // client-module scanner stalls the whole web UI on an unknown inject target.
    // dsh >= 0.2.0-rc.x ships the slot host inside dsh-web-app, so no injection is
    // required — re-adding it would freeze older clients into an endless spinner.
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        dsh?: { client?: { inject?: unknown } };
    };
    assert.equal(pkg.dsh?.client?.inject ?? null, null, "dsh.client.inject would break pre-0.2 dsh clients");
});
