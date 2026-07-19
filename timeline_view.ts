// timeline_view.ts — Panel lateral con lista cronológica de eventos
// v3: diseño compacto con contadores por pipe y badge X/Y visible/invisible
import { ItemView, WorkspaceLeaf } from "obsidian";
import { TraceEvent } from "./event_reader";

export const TIMELINE_VIEW_TYPE = "cognitive-trace-timeline";

const TOOL_ICONS: Record<string, string> = {
    okf_traverse: "🔗", okf_read: "📖", okf_search: "🔍",
    okf_graph: "🕸️", okf_health: "💚", okf_index: "📑",
    okf_touch: "📊", okf_new: "✨",
};

interface FilterPipe {
    key: string; label: string; color: string;
    match: (e: TraceEvent) => boolean;
}

const PIPES: FilterPipe[] = [
    { key: "traverse", label: "Navegación", color: "#FFD700",
      match: (e) => e.type !== "command" && e.tool === "okf_traverse" },
    { key: "read", label: "Lecturas", color: "#B388FF",
      match: (e) => e.type !== "command" && e.tool === "okf_read" },
    { key: "search", label: "Búsquedas", color: "#4FC3F7",
      match: (e) => e.type !== "command" && ["okf_search","okf_graph","okf_health","okf_index","okf_touch","okf_new"].includes(e.tool || "") },
    { key: "commands", label: "Comandos", color: "#FF6B35",
      match: (e) => e.type === "command" },
];

const MAX_VISIBLE = 200;

export class TimelineView extends ItemView {
    private events: TraceEvent[];
    activePipes = new Set<string>(PIPES.map((p) => p.key));
    private onFilterChange: (() => void) | null = null;
    private onActivatePrompt: ((events: TraceEvent[]) => void) | null = null;

    constructor(leaf: WorkspaceLeaf, events: TraceEvent[], onFilterChange?: () => void, onActivatePrompt?: (events: TraceEvent[]) => void) {
        super(leaf);
        this.events = events;
        this.onFilterChange = onFilterChange || null;
        this.onActivatePrompt = onActivatePrompt || null;
    }

    getViewType(): string { return TIMELINE_VIEW_TYPE; }
    getDisplayText(): string { return "Cognitive Trace"; }
    getIcon(): string { return "activity"; }

    async onOpen(): Promise<void> { this.render(); }

    refresh(_events: TraceEvent[]): void { this.render(); }

    private render(): void {
        const container = this.containerEl.children[1] as HTMLElement;
        if (!container) { requestAnimationFrame(() => this.render()); return; }
        container.empty();
        container.addClass("cognitive-trace-timeline");

        // ── Header ──
        const header = container.createEl("div", { cls: "trace-header" });
        const hLeft = header.createEl("div", { cls: "trace-header-left" });
        hLeft.createEl("span", { cls: "trace-header-title", text: "Cognitive Trace" });

        const clearBtn = header.createEl("button", { cls: "trace-clear-btn", text: "Clear" });
        clearBtn.addEventListener("click", () => { this.events.length = 0; this.render(); });

        // ── Filters ──
        const counts = this.countByPipe();
        const toolbar = container.createEl("div", { cls: "trace-filters" });
        for (const pipe of PIPES) {
            const active = this.activePipes.has(pipe.key);
            const n = counts[pipe.key] || 0;
            const btn = toolbar.createEl("button", {
                cls: "trace-filter-chip" + (active ? "" : " trace-filter-off"),
            });
            btn.style.setProperty("--pipe-color", pipe.color);
            const dot = btn.createEl("span", { cls: "trace-chip-dot" });
            dot.style.backgroundColor = pipe.color;
            btn.createEl("span", { cls: "trace-chip-label", text: pipe.label });
            btn.createEl("span", { cls: "trace-chip-count", text: String(n) });
            btn.addEventListener("click", () => {
                if (this.activePipes.has(pipe.key)) this.activePipes.delete(pipe.key);
                else this.activePipes.add(pipe.key);
                btn.classList.toggle("trace-filter-off", !this.activePipes.has(pipe.key));
                this.renderEventList(container, this.countByPipe());
                if (this.onFilterChange) this.onFilterChange();
            });
        }

        this.renderEventList(container, counts);
    }

    private countByPipe(): Record<string, number> {
        const counts: Record<string, number> = {};
        for (const p of PIPES) counts[p.key] = 0;
        for (const e of this.events) {
            for (const p of PIPES) { if (p.match(e)) { counts[p.key]++; break; } }
        }
        return counts;
    }

    private renderEventList(container: HTMLElement, counts: Record<string, number>): void {
        const old = container.querySelector(".trace-list-wrap");
        if (old) old.remove();

        const wrap = container.createEl("div", { cls: "trace-list-wrap" });
        const list = wrap.createEl("div", { cls: "trace-list" });

        if (this.events.length === 0) {
            list.createEl("div", { cls: "trace-empty", text: "Esperando eventos del agente..." });
            return;
        }

        const filtered = [...this.events].reverse().filter((e) => {
            for (const p of PIPES) { if (this.activePipes.has(p.key) && p.match(e)) return true; }
            return false;
        });

        const totalActive = Object.entries(counts)
            .filter(([k]) => this.activePipes.has(k))
            .reduce((s, [,c]) => s + c, 0);
        const badge = wrap.createEl("div", { cls: "trace-filter-badge" });
        badge.setText(`${Math.min(filtered.length, MAX_VISIBLE)}/${totalActive} eventos` +
            (filtered.length > MAX_VISIBLE ? ` (últimos ${MAX_VISIBLE})` : ""));

        if (filtered.length === 0) {
            list.createEl("div", { cls: "trace-empty", text: "Sin eventos para los filtros activos." });
            return;
        }

        const visible = filtered.slice(0, MAX_VISIBLE);

        // Agrupar eventos en prompts (gap > 60s = nuevo prompt)
        const GAP = 60 * 1000;
        const prompts: Array<{ events: TraceEvent[]; start: string; end: string }> = [];
        let current: TraceEvent[] = [];

        for (let i = 0; i < visible.length; i++) {
            const ev = visible[i];
            if (current.length > 0) {
                const prevTs = new Date(visible[i - 1].ts).getTime();
                const thisTs = new Date(ev.ts).getTime();
                if ((prevTs - thisTs) > GAP) {
                    prompts.push({
                        events: current,
                        start: current[current.length - 1].ts,
                        end: current[0].ts,
                    });
                    current = [];
                }
            }
            current.push(ev);
        }
        if (current.length > 0) {
            prompts.push({
                events: current,
                start: current[current.length - 1].ts,
                end: current[0].ts,
            });
        }

        // Renderizar cada prompt como acordeón
        for (let pi = 0; pi < prompts.length; pi++) {
            const prompt = prompts[pi];
            const firstTool = prompt.events[prompt.events.length - 1].tool || "?";
            const lastTool = prompt.events[0].tool || "?";
            const startTime = prompt.start.slice(11, 19);
            const endTime = prompt.end.slice(11, 19);

            // Header del acordeón
            const header = list.createEl("div", { cls: "trace-prompt-header" });
            const isOpen = pi === 0; // primer prompt (más reciente) abierto por defecto
            const toggle = header.createEl("span", { cls: "trace-prompt-toggle", text: isOpen ? "▼" : "▶" });
            const info = header.createEl("span", { cls: "trace-prompt-info" });
            info.createEl("span", { cls: "trace-prompt-time", text: `${startTime} → ${endTime}` });
            info.createEl("span", { cls: "trace-prompt-tools", text: `${firstTool} → ${lastTool}` });
            const count = header.createEl("span", { cls: "trace-prompt-count", text: `${prompt.events.length} eventos` });
            // Botón para activar este prompt en el grafo
            if (this.onActivatePrompt) {
                const activateBtn = header.createEl("button", { cls: "trace-prompt-activate", text: "⟳" });
                activateBtn.title = "Mostrar solo este prompt en el grafo";
                activateBtn.addEventListener("click", (ev) => {
                    ev.stopPropagation(); // no colapsar/expandir al clickear el botón
                    this.onActivatePrompt!(prompt.events);
                });
            }

            // Body del acordeón
            const body = list.createEl("div", { cls: "trace-prompt-body" + (isOpen ? "" : " trace-prompt-collapsed") });

            for (const event of prompt.events) {
                const row = body.createEl("div", { cls: "trace-event" });

                const left = row.createEl("div", { cls: "trace-event-left" });
                const time = event.ts.slice(11, 19);
                left.createEl("span", { cls: "trace-time", text: time });

                const pipe = PIPES.find((p) => p.match(event));
                if (pipe) {
                    const dot = left.createEl("span", { cls: "trace-event-dot" });
                    dot.style.backgroundColor = pipe.color;
                }

                const eventBody = row.createEl("div", { cls: "trace-event-body" });
                if (event.type === "command") {
                    eventBody.createEl("span", { cls: "trace-event-text", text: `⚡ ${event.action || "?"}` });
                    const extra: string[] = [];
                    if (event.nodes?.length) extra.push(`${event.nodes.length} nodos`);
                    if (event.tag) extra.push(`#${event.tag}`);
                    if (extra.length) eventBody.createEl("span", { cls: "trace-event-extra", text: extra.join(" · ") });
                } else {
                    const icon = TOOL_ICONS[event.tool || ""] || "•";
                    const slug = event.params?.slug || event.params?.query || "";
                    let text = `${icon} ${event.tool || "?"}`;
                    if (slug) text += ` → ${slug}`;
                    eventBody.createEl("span", { cls: "trace-event-text", text });
                    const extra: string[] = [];
                    if (event.result_nodes?.length) extra.push(`+${event.result_nodes.length} nodos`);
                    if (event.duration_ms) extra.push(`${event.duration_ms}ms`);
                    if (extra.length) eventBody.createEl("span", { cls: "trace-event-extra", text: extra.join(" · ") });
                }
            }

            // Toggle click
            header.addEventListener("click", () => {
                const collapsed = body.classList.contains("trace-prompt-collapsed");
                if (collapsed) {
                    body.classList.remove("trace-prompt-collapsed");
                    toggle.setText("▼");
                } else {
                    body.classList.add("trace-prompt-collapsed");
                    toggle.setText("▶");
                }
            });
        }
    }

    async onClose(): Promise<void> {}
}
