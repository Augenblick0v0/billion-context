// #1875: machine-readable business outcome for executed proxy tools. The HTTP
// envelope's ok already means "transport + execution succeeded"; outcome adds
// whether the REQUESTED EFFECT happened. Compress is tri-valued (applied /
// partial / refused) because a partially-applied fold is neither; every other
// tool is binary success | failure. Consumers that only know the old envelope
// shape ignore the extra fields and keep working off result text.
export type CompressOutcomeKind = "applied" | "partial" | "refused";
export type ToolOutcomeKind = CompressOutcomeKind | "success" | "failure";

export interface ProxyToolResult {
    text: string;
    outcome?: ToolOutcomeKind;
    blocksCreated?: number;
}

export function toolOk(text: string): ProxyToolResult {
    return { text, outcome: "success" };
}

export function toolFail(text: string): ProxyToolResult {
    return { text, outcome: "failure" };
}

export function compressResult(text: string, outcome: CompressOutcomeKind, blocksCreated: number): ProxyToolResult {
    return { text, outcome, blocksCreated };
}
