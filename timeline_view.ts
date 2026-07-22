// timeline_view.ts — Panel lateral con lista cronológica de eventos
// v3: diseño compacto con contadores por pipe y badge X/Y visible/invisible
import { ItemView, WorkspaceLeaf } from "obsidian";
import { TraceEvent } from "./event_reader";
import { CTSettings } from "./settings";

export const TIMELINE_VIEW_TYPE = "cognitive-trace-timeline";

const TOOL_ICONS: Record<string, string> = {
    okf_traverse: "🔗", okf_read: "📖", okf_search: "🔍",
    okf_graph: "🕸️", okf_health: "💚", okf_index: "📑",
    okf_touch: "📊", okf_new: "✨",
};

interface FilterPipe {
    key: string; label: string;
    getColor: (s: CTSettings) => string;
    match: (e: TraceEvent) => boolean;
}

function makePipes(settings: CTSettings): FilterPipe[] {
    return [
        { key: "traverse", label: "Navegación", getColor: (s) => s.colorCurrent,
          match: (e) => e.type !== "command" && e.tool === "okf_traverse" },
        { key: "read", label: "Lecturas", getColor: (s) => s.colorRead,
          match: (e) => e.type !== "command" && e.tool === "okf_read" },
        { key: "search", label: "Búsquedas", getColor: (s) => s.colorVisited,
          match: (e) => e.type !== "command" && ["okf_search","okf_graph","okf_health","okf_index","okf_touch"].includes(e.tool || "") },
        { key: "create", label: "Creaciones", getColor: (s) => s.colorCreate,
          match: (e) => e.type !== "command" && e.tool === "okf_new" },
        { key: "commands", label: "Comandos", getColor: (s) => s.colorCommand,
          match: (e) => e.type === "command" },
    ];
}

const MAX_VISIBLE = 200;

/** Eventos que producen un efecto visual en el grafo (nodo iluminado, pulso, etc.).
 *  Solo estos se muestran en el timeline para que no haya expectativas falsas:
 *  todo lo que ves en el timeline tiene su reflejo en el grafo. */
function hasGraphEffect(e: TraceEvent): boolean {
    if (e.type === "command") return true;
    // okf_read / okf_traverse con slug → colorean el nodo consultado
    if ((e.tool === "okf_traverse" || e.tool === "okf_read") && e.params?.slug) return true;
    // okf_new exitoso → colorea el archivo creado
    if (e.tool === "okf_new" && e.params?.created_path && e.exit_code === 0) return true;
    // Cualquier tool con result_nodes → colorea el subgrafo resultado
    if (Array.isArray(e.result_nodes) && e.result_nodes.length > 0) return true;
    return false;
}

export class TimelineView extends ItemView {
    private events: TraceEvent[];
    private settings: CTSettings;
    activePipes = new Set<string>(["traverse", "read", "search", "create", "commands"]);
    private replayCycles = 1; // cuántos prompts reproducir (1 = solo el clickeado)
    private onFilterChange: (() => void) | null = null;
    private onActivatePrompt: ((events: TraceEvent[], onDone: () => void, onProgress: (current: number, total: number) => void) => void) | null = null;
    private onStopReplay: (() => void) | null = null;
    private onToggleReplayPause: (() => void) | null = null;
    private onSkipReveal: (() => void) | null = null;
    private onHighlightNode: ((slug: string) => void) | null = null;
    private playingPrompt = -1;
    private replayPaused = false;
    private playbackProgress = "";
    private refreshTimer: number | null = null;

    constructor(leaf: WorkspaceLeaf, events: TraceEvent[], settings: CTSettings, onFilterChange?: () => void, onActivatePrompt?: (events: TraceEvent[], onDone: () => void, onProgress: (current: number, total: number) => void) => void, onStopReplay?: () => void, onToggleReplayPause?: () => void, onSkipReveal?: () => void, onHighlightNode?: (slug: string) => void) {
        super(leaf);
        this.events = events;
        this.settings = settings;
        this.onFilterChange = onFilterChange || null;
        this.onActivatePrompt = onActivatePrompt || null;
        this.onStopReplay = onStopReplay || null;
        this.onToggleReplayPause = onToggleReplayPause || null;
        this.onSkipReveal = onSkipReveal || null;
        this.onHighlightNode = onHighlightNode || null;
    }

    private pipes(): FilterPipe[] { return makePipes(this.settings); }

    getViewType(): string { return TIMELINE_VIEW_TYPE; }
    getDisplayText(): string { return "Cognitive Trace"; }
    getIcon(): string { return "activity"; }

    async onOpen(): Promise<void> { this.render(); }

    refresh(_events: TraceEvent[]): void {
        this.events = _events;  // mantener referencia viva: el buffer de main.ts puede reasignarse con slice()
        // Agrupar tandas cercanas evita reconstruir hasta 200 filas por cada
        // evento cuando el lector recibe actividad continua.
        if (this.refreshTimer != null) return;
        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null;
            this.render();
        }, 100);
    }

    private render(): void {
        const container = this.containerEl.children[1] as HTMLElement;
        if (!container) { requestAnimationFrame(() => this.render()); return; }
        container.empty();
        container.addClass("cognitive-trace-timeline");

        // ── Header ──
        const header = container.createEl("div", { cls: "trace-header" });
        const hLeft = header.createEl("div", { cls: "trace-header-left" });
        hLeft.createEl("span", { cls: "trace-header-title", text: "Cognitive Trace" });

        // Indicador de conexión
        const status = this.connectionStatus();
        const statusDot = header.createEl("span", { cls: "trace-status-dot" });
        statusDot.style.backgroundColor = status.color;
        statusDot.title = status.label;
        statusDot.setAttribute("aria-label", status.label);
        const statusLabel = header.createEl("span", { cls: "trace-status-label", text: status.label });
        statusLabel.title = status.detail;
        statusLabel.setAttribute("aria-label", status.detail);

        const clearBtn = header.createEl("button", { cls: "trace-clear-btn", text: "Clear" });
        clearBtn.addEventListener("click", () => { this.events.length = 0; this.render(); });

        // ── Filters ──
        const counts = this.countByPipe();
        const toolbar = container.createEl("div", { cls: "trace-filters" });
        for (const pipe of this.pipes()) {
            const active = this.activePipes.has(pipe.key);
            const n = counts[pipe.key] || 0;
            const btn = toolbar.createEl("button", {
                cls: "trace-filter-chip" + (active ? "" : " trace-filter-off"),
            });
            const pc = pipe.getColor(this.settings);
            btn.style.setProperty("--pipe-color", pc);
            const dot = btn.createEl("span", { cls: "trace-chip-dot" });
            dot.style.backgroundColor = pc;
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

        // Control de ciclos: cuántos prompts reproducir al clickear ▶
        const cycleCtl = toolbar.createEl("div", { cls: "trace-cycle-ctl" });
        const minusBtn = cycleCtl.createEl("button", { cls: "trace-cycle-btn", text: "−" });
        const cycleLabel = cycleCtl.createEl("span", { cls: "trace-cycle-label", text: `${this.replayCycles}` });
        const plusBtn = cycleCtl.createEl("button", { cls: "trace-cycle-btn", text: "+" });
        minusBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (this.replayCycles > 1) { this.replayCycles--; cycleLabel.setText(`${this.replayCycles}`); }
        });
        plusBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (this.replayCycles < 20) { this.replayCycles++; cycleLabel.setText(`${this.replayCycles}`); }
        });

        // Selector de velocidad del replay
        const speedCtl = toolbar.createEl("div", { cls: "trace-cycle-ctl" });
        speedCtl.createEl("span", { cls: "trace-cycle-label", text: `${this.settings.replaySpeed}×` });
        const speedBtn = speedCtl.createEl("button", { cls: "trace-cycle-btn", text: "⏩" });
        speedBtn.title = "Cambiar velocidad del replay";
        speedBtn.setAttribute("aria-label", "Cambiar velocidad del replay");
        const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5];
        speedBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const current = SPEEDS.indexOf(this.settings.replaySpeed);
            const next = (current + 1) % SPEEDS.length;
            this.settings.replaySpeed = SPEEDS[next];
            speedCtl.querySelector(".trace-cycle-label")!.textContent = `${SPEEDS[next]}×`;
        });

        this.renderEventList(container, counts);
    }

    private connectionStatus(): { color: string; label: string; detail: string } {
        if (!this.events.length) {
            return { color: "var(--text-faint)", label: "Sin eventos", detail: "No se han recibido eventos del agente" };
        }
        const lastTs = new Date(this.events[this.events.length - 1].ts).getTime();
        const ago = Date.now() - lastTs;
        if (ago < 5_000) {
            return { color: "#4CAF50", label: "Live", detail: `Último evento hace ${Math.round(ago / 1000)}s` };
        }
        if (ago < 60_000) {
            return { color: "#FFC107", label: "Idle", detail: `Último evento hace ${Math.round(ago / 1000)}s` };
        }
        const mins = Math.round(ago / 60_000);
        return { color: "var(--text-faint)", label: "Inactivo", detail: `Último evento hace ${mins} min` };
    }

    private countByPipe(): Record<string, number> {
        const counts: Record<string, number> = {};
        const pipes = this.pipes();
        for (const p of pipes) counts[p.key] = 0;
        for (const e of this.events) {
            if (!hasGraphEffect(e)) continue;
            for (const p of pipes) { if (p.match(e)) { counts[p.key]++; break; } }
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

        // Solo eventos con efecto en el grafo: lo que ves aquí se refleja en nodos coloreados
        const filtered = [...this.events].reverse().filter((e) => {
            if (!hasGraphEffect(e)) return false;
            for (const p of this.pipes()) { if (this.activePipes.has(p.key) && p.match(e)) return true; }
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
            const isOpen = pi === 0;
            const toggle = header.createEl("span", { cls: "trace-prompt-toggle", text: isOpen ? "▼" : "▶" });
            const info = header.createEl("span", { cls: "trace-prompt-info" });
            info.createEl("span", { cls: "trace-prompt-time", text: `${startTime} → ${endTime}` });
            const meta = info.createEl("span", { cls: "trace-prompt-meta" });
            meta.createEl("span", { cls: "trace-prompt-tools", text: `${firstTool} → ${lastTool}` });
            meta.createEl("span", { cls: "trace-prompt-count", text: `${prompt.events.length} evt` });

            // Botón para activar este prompt en el grafo
            if (this.onActivatePrompt) {
                const isPlaying = this.playingPrompt === pi;
                const pauseBtn = header.createEl("button", {
                    cls: "trace-prompt-activate trace-prompt-play" + (isPlaying ? " trace-prompt-playing" : ""),
                    text: isPlaying ? (this.replayPaused ? "▶" : "⏸") : "▶",
                });
                const title = isPlaying ? (this.replayPaused ? "Reanudar reproducción" : "Pausar reproducción") : this.replayCycles === 1
                    ? "Reproducir este prompt en el grafo (animado)"
                    : `Reproducir ${this.replayCycles} prompts en el grafo (animado)`;
                pauseBtn.title = title;
                pauseBtn.setAttribute("aria-label", title);

                const stopBtn = header.createEl("button", {
                    cls: "trace-prompt-activate trace-prompt-stop" + (isPlaying ? "" : " trace-prompt-stop-hidden"),
                    text: "■",
                });
                stopBtn.title = "Detener reproducción";
                stopBtn.setAttribute("aria-label", "Detener reproducción");

                const progress = header.createEl("span", {
                    cls: "trace-prompt-progress" + (isPlaying ? "" : " trace-prompt-progress-hidden"),
                    text: isPlaying ? this.playbackProgress : "",
                });
                progress.title = "Progreso del replay";

                // Botón saltar al final: revela todos los nodos pendientes instantáneamente
                const skipBtn = header.createEl("button", {
                    cls: "trace-prompt-activate trace-prompt-skip" + (isPlaying ? "" : " trace-prompt-stop-hidden"),
                    text: "⏭",
                });
                skipBtn.title = "Saltar al final — revelar todo instantáneamente";
                skipBtn.setAttribute("aria-label", "Saltar al final");
                skipBtn.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    this.onSkipReveal?.();
                });

                pauseBtn.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    if (this.playingPrompt === pi) {
                        this.togglePausePlayback();
                        return;
                    }
                    this.stopPlayback();
                    this.playingPrompt = pi;
                    // Recolectar eventos de este prompt + N-1 anteriores
                    const allEvents: TraceEvent[] = [];
                    for (let j = 0; j < this.replayCycles && (pi + j) < prompts.length; j++) {
                        allEvents.push(...prompts[pi + j].events);
                    }
                    this.replayPaused = false;
                    this.playbackProgress = `0/${allEvents.length}`;
                    pauseBtn.classList.add("trace-prompt-playing");
                    pauseBtn.setText("⏸");
                    pauseBtn.title = "Pausar reproducción";
                    pauseBtn.setAttribute("aria-label", "Pausar reproducción");
                    stopBtn.classList.remove("trace-prompt-stop-hidden");
                    skipBtn.classList.remove("trace-prompt-stop-hidden");
                    progress.classList.remove("trace-prompt-progress-hidden");
                    progress.setText(this.playbackProgress);
                    this.onActivatePrompt!(allEvents, () => this.completePlayback(), (current, total) => {
                        this.playbackProgress = `${current}/${total}`;
                        this.containerEl.querySelector(".trace-prompt-progress")?.setText(this.playbackProgress);
                    });
                });

                stopBtn.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    if (this.playingPrompt === pi) this.stopPlayback();
                });
            }

            // Body del acordeón
            const body = list.createEl("div", { cls: "trace-prompt-body" + (isOpen ? "" : " trace-prompt-collapsed") });

            for (const event of prompt.events) {
                const row = body.createEl("div", { cls: "trace-event" });

                const left = row.createEl("div", { cls: "trace-event-left" });
                const time = event.ts.slice(11, 19);
                left.createEl("span", { cls: "trace-time", text: time });

                const pipe = this.pipes().find((p) => p.match(event));
                if (pipe) {
                    const dot = left.createEl("span", { cls: "trace-event-dot" });
                    dot.style.backgroundColor = pipe.getColor(this.settings);
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

                // Tooltip con detalles completos
                const tooltipParts: string[] = [];
                tooltipParts.push(event.ts.slice(0, 19).replace("T", " "));
                if (event.tool) tooltipParts.push(event.tool);
                if (event.params?.slug) tooltipParts.push(`slug: ${event.params.slug}`);
                if (event.params?.query) tooltipParts.push(`query: ${event.params.query}`);
                if (event.params?.command) tooltipParts.push(`cmd: ${event.params.command}`);
                if (event.duration_ms) tooltipParts.push(`${event.duration_ms}ms`);
                if (event.exit_code !== undefined) tooltipParts.push(`exit: ${event.exit_code}`);
                if (event.result_nodes?.length) {
                    tooltipParts.push(`--- ${event.result_nodes.length} nodos ---`);
                    tooltipParts.push(...event.result_nodes.slice(0, 10));
                    if (event.result_nodes.length > 10) tooltipParts.push(`... +${event.result_nodes.length - 10} más`);
                }
                if (event.nodes?.length) {
                    tooltipParts.push(`nodos: ${event.nodes.join(", ")}`);
                }
                row.title = tooltipParts.join("\n");

                // Click en evento → highlight en grafo
                if (this.onHighlightNode) {
                    row.addClass("trace-event-clickable");
                    const clickSlug = event.params?.slug || event.params?.created_path || event.result_nodes?.[0];
                    row.addEventListener("click", (ev) => {
                        ev.stopPropagation();
                        if (clickSlug) {
                            row.addClass("trace-event-flash");
                            setTimeout(() => row.classList.remove("trace-event-flash"), 600);
                            this.onHighlightNode?.(clickSlug);
                        }
                    });
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

    async onClose(): Promise<void> {
        if (this.refreshTimer != null) {
            window.clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.stopPlayback();
    }

    private stopPlayback(): void {
        if (this.playingPrompt < 0) return;
        this.onStopReplay?.();
        this.completePlayback();
    }

    private togglePausePlayback(): void {
        if (this.playingPrompt < 0) return;
        this.onToggleReplayPause?.();
        this.replayPaused = !this.replayPaused;
        this.containerEl.querySelectorAll(".trace-prompt-play").forEach((button) => {
            const el = button as HTMLElement;
            el.setText(this.replayPaused ? "▶" : "⏸");
            el.title = this.replayPaused ? "Reanudar reproducción" : "Pausar reproducción";
            el.setAttribute("aria-label", el.title);
        });
    }

    private completePlayback(): void {
        if (this.playingPrompt < 0) return;
        this.playingPrompt = -1;
        this.replayPaused = false;
        this.playbackProgress = "";
        this.containerEl.querySelectorAll(".trace-prompt-play").forEach((button) => {
            const el = button as HTMLElement;
            el.classList.remove("trace-prompt-playing");
            el.setText("▶");
            el.title = "Reproducir este prompt en el grafo (animado)";
            el.setAttribute("aria-label", el.title);
        });
        this.containerEl.querySelectorAll(".trace-prompt-stop").forEach((button) => {
            (button as HTMLElement).classList.add("trace-prompt-stop-hidden");
        });
        this.containerEl.querySelectorAll(".trace-prompt-skip").forEach((button) => {
            (button as HTMLElement).classList.add("trace-prompt-stop-hidden");
        });
        this.containerEl.querySelectorAll(".trace-prompt-progress").forEach((progress) => {
            progress.classList.add("trace-prompt-progress-hidden");
            progress.setText("");
        });
    }
}
