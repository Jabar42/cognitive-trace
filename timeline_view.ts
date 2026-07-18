// timeline_view.ts — Panel lateral con lista cronológica de eventos
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

export class TimelineView extends ItemView {
    private events: TraceEvent[];

    constructor(leaf: WorkspaceLeaf, events: TraceEvent[]) {
        super(leaf);
        this.events = events;
        console.log("[CognitiveTrace] TimelineView constructed, events:", this.events.length);
    }

    getViewType(): string { return TIMELINE_VIEW_TYPE; }
    getDisplayText(): string { return "Cognitive Trace"; }
    getIcon(): string { return "activity"; }

    async onOpen(): Promise<void> {
        console.log("[CognitiveTrace] TimelineView onOpen, events:", this.events.length);
        this.render();
    }

    /** Llamado desde el plugin cuando llegan nuevos eventos */
    refresh(_events: TraceEvent[]): void {
        console.log("[CognitiveTrace] TimelineView refresh, total events:", this.events.length);
        this.render();
    }

    private render(): void {
        const container = this.containerEl.children[1] as HTMLElement;
        if (!container) {
            console.warn("[CognitiveTrace] TimelineView: containerEl.children[1] not found, retrying...");
            // La vista puede no estar lista aún — reintentar en el próximo frame
            requestAnimationFrame(() => this.render());
            return;
        }
        container.empty();
        container.addClass("cognitive-trace-timeline");

        // Header
        const header = container.createEl("div", { cls: "trace-header" });
        header.createEl("span", { cls: "trace-header-title", text: "Cognitive Trace" });
        header.createEl("span", { cls: "trace-header-count", text: `${this.events.length} eventos` });

        // Clear button
        const clearBtn = header.createEl("button", { cls: "trace-clear-btn", text: "Clear" });
        clearBtn.addEventListener("click", () => {
            this.events.length = 0;
            this.render();
        });

        // Event list (most recent first, max 50 visibles)
        const list = container.createEl("div", { cls: "trace-list" });

        if (this.events.length === 0) {
            const empty = list.createEl("div", { cls: "trace-empty" });
            empty.createEl("span", { text: "Esperando eventos... Haz consultas al vault con Hermes para verlos aquí." });
            return;
        }

        const recent = [...this.events].reverse().slice(0, 50);
        console.log("[CognitiveTrace] Rendering", recent.length, "events");

        for (const event of recent) {
            const row = list.createEl("div", { cls: "trace-event" });

            // Time
            const time = event.ts.slice(11, 19);
            row.createEl("span", { cls: "trace-time", text: time });

            // Icon
            if (event.type === "command") {
                row.createEl("span", { cls: "trace-icon", text: "⚡" });
                row.createEl("span", { cls: "trace-action", text: event.action || "?" });
            } else {
                const icon = TOOL_ICONS[event.tool || ""] || "•";
                row.createEl("span", { cls: "trace-icon", text: icon });
                row.createEl("span", { cls: "trace-tool", text: event.tool || "?" });

                // Detail
                if (event.tool === "okf_traverse" && event.params?.slug) {
                    row.createEl("span", { cls: "trace-detail", text: `→ ${event.params.slug}` });
                } else if (event.tool === "okf_read" && event.params?.slug) {
                    row.createEl("span", { cls: "trace-detail", text: `→ ${event.params.slug}` });
                } else if (event.tool === "okf_search" && event.params?.query) {
                    row.createEl("span", { cls: "trace-detail", text: `"${event.params.query}"` });
                }
            }

            // Duration
            if (event.duration_ms) {
                row.createEl("span", { cls: "trace-ms", text: `${event.duration_ms}ms` });
            }
        }
    }

    async onClose(): Promise<void> {
        // No limpiar — el buffer es compartido
    }
}
