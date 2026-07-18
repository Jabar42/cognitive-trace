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
    private activePipes = new Set<string>(PIPES.map((p) => p.key));

    constructor(leaf: WorkspaceLeaf, events: TraceEvent[]) {
        super(leaf);
        this.events = events;
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
                // Leer el estado actual del Set, no la variable capturada en el closure
                if (this.activePipes.has(pipe.key)) this.activePipes.delete(pipe.key);
                else this.activePipes.add(pipe.key);
                btn.classList.toggle("trace-filter-off", !this.activePipes.has(pipe.key));
                this.renderEventList(container, this.countByPipe());
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

        // Badge X/Y
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

        for (const event of filtered.slice(0, MAX_VISIBLE)) {
            const row = list.createEl("div", { cls: "trace-event" });

            const left = row.createEl("div", { cls: "trace-event-left" });
            const time = event.ts.slice(11, 19);
            left.createEl("span", { cls: "trace-time", text: time });

            const pipe = PIPES.find((p) => p.match(event));
            if (pipe) {
                const dot = left.createEl("span", { cls: "trace-event-dot" });
                dot.style.backgroundColor = pipe.color;
            }

            const body = row.createEl("div", { cls: "trace-event-body" });
            if (event.type === "command") {
                body.createEl("span", { cls: "trace-event-text", text: `⚡ ${event.action || "?"}` });
                const extra: string[] = [];
                if (event.nodes?.length) extra.push(`${event.nodes.length} nodos`);
                if (event.tag) extra.push(`#${event.tag}`);
                if (extra.length) body.createEl("span", { cls: "trace-event-extra", text: extra.join(" · ") });
            } else {
                const icon = TOOL_ICONS[event.tool || ""] || "•";
                const slug = event.params?.slug || event.params?.query || "";
                let text = `${icon} ${event.tool || "?"}`;
                if (slug) text += ` → ${slug}`;
                body.createEl("span", { cls: "trace-event-text", text });
                const extra: string[] = [];
                if (event.result_nodes?.length) extra.push(`+${event.result_nodes.length} nodos`);
                if (event.duration_ms) extra.push(`${event.duration_ms}ms`);
                if (extra.length) body.createEl("span", { cls: "trace-event-extra", text: extra.join(" · ") });
            }
        }
    }

    async onClose(): Promise<void> {}
}
