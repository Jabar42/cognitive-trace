// timeline_view.ts — Panel lateral con lista cronológica de eventos
// v2: filtros por tipo de evento (4 pipes) con código de color del grafo
import { ItemView, WorkspaceLeaf } from "obsidian";
import { TraceEvent } from "./event_reader";

export const TIMELINE_VIEW_TYPE = "cognitive-trace-timeline";

const TOOL_ICONS: Record<string, string> = {
    okf_traverse: "🔗",
    okf_read: "📖",
    okf_search: "🔍",
    okf_graph: "🕸️",
    okf_health: "💚",
    okf_index: "📑",
    okf_touch: "📊",
    okf_new: "✨",
};

interface FilterPipe {
    key: string;
    label: string;
    color: string;
    match: (e: TraceEvent) => boolean;
}

const PIPES: FilterPipe[] = [
    { key: "traverse", label: "Navegación", color: "#FFD700",
      match: (e) => e.type !== "command" && e.tool === "okf_traverse" },
    { key: "read", label: "Lecturas", color: "#B388FF",
      match: (e) => e.type !== "command" && e.tool === "okf_read" },
    { key: "search", label: "Búsquedas", color: "#4FC3F7",
      match: (e) => e.type !== "command" && (e.tool === "okf_search" || e.tool === "okf_graph" || e.tool === "okf_health" || e.tool === "okf_index" || e.tool === "okf_touch" || e.tool === "okf_new") },
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

    async onOpen(): Promise<void> {
        this.render();
    }

    /** Llamado desde el plugin cuando llegan nuevos eventos */
    refresh(_events: TraceEvent[]): void {
        this.render();
    }

    private render(): void {
        const container = this.containerEl.children[1] as HTMLElement;
        if (!container) {
            requestAnimationFrame(() => this.render());
            return;
        }
        container.empty();
        container.addClass("cognitive-trace-timeline");

        // Header
        const header = container.createEl("div", { cls: "trace-header" });
        header.createEl("span", { cls: "trace-header-title", text: "Cognitive Trace" });
        header.createEl("span", { cls: "trace-header-count", text: `${this.events.length} eventos` });

        const clearBtn = header.createEl("button", { cls: "trace-clear-btn", text: "Clear" });
        clearBtn.addEventListener("click", () => {
            this.events.length = 0;
            this.render();
        });

        // Filter toolbar
        const toolbar = container.createEl("div", { cls: "trace-filters" });
        for (const pipe of PIPES) {
            const btn = toolbar.createEl("button", {
                cls: "trace-filter-btn" + (this.activePipes.has(pipe.key) ? "" : " trace-filter-off"),
                text: pipe.label,
            });
            btn.style.setProperty("--pipe-color", pipe.color);
            btn.addEventListener("click", () => {
                if (this.activePipes.has(pipe.key)) {
                    this.activePipes.delete(pipe.key);
                } else {
                    this.activePipes.add(pipe.key);
                }
                btn.classList.toggle("trace-filter-off", !this.activePipes.has(pipe.key));
                this.renderEventList(container);
            });
        }

        this.renderEventList(container);
    }

    private renderEventList(container: HTMLElement): void {
        const old = container.querySelector(".trace-list");
        if (old) old.remove();

        const list = container.createEl("div", { cls: "trace-list" });

        if (this.events.length === 0) {
            const empty = list.createEl("div", { cls: "trace-empty" });
            empty.createEl("span", { text: "Esperando eventos... Haz consultas al vault con Hermes para verlos aquí." });
            return;
        }

        const filtered = [...this.events].reverse().filter((e) => {
            for (const pipe of PIPES) {
                if (this.activePipes.has(pipe.key) && pipe.match(e)) return true;
            }
            return false;
        });

        if (filtered.length === 0) {
            const empty = list.createEl("div", { cls: "trace-empty" });
            empty.createEl("span", { text: "Sin eventos para los filtros activos." });
            return;
        }

        const visible = filtered.slice(0, MAX_VISIBLE);

        for (const event of visible) {
            const row = list.createEl("div", { cls: "trace-event" });

            const time = event.ts.slice(11, 19);
            row.createEl("span", { cls: "trace-time", text: time });

            const pipe = PIPES.find((p) => p.match(event));
            if (pipe) {
                const badge = row.createEl("span", { cls: "trace-pipe-badge", text: pipe.label });
                badge.style.setProperty("--pipe-color", pipe.color);
            }

            const detail = row.createEl("span", { cls: "trace-detail" });
            if (event.type === "command") {
                detail.setText(`⚡ ${event.action || "?"}` +
                    (event.nodes ? ` (${event.nodes.length} nodos)` : "") +
                    (event.tag ? ` #${event.tag}` : ""));
            } else {
                const icon = TOOL_ICONS[event.tool || ""] || "•";
                let text = `${icon} ${event.tool || "?"}`;
                if (event.params?.slug) text += ` → ${event.params.slug}`;
                else if (event.params?.query) text += ` "${event.params.query}"`;
                if (event.result_nodes?.length) text += ` +${event.result_nodes.length} nodos`;
                detail.setText(text);
            }

            if (event.duration_ms) {
                row.createEl("span", { cls: "trace-ms", text: `${event.duration_ms}ms` });
            }
        }
    }

    async onClose(): Promise<void> {
        // No limpiar — el buffer es compartido
    }
}
