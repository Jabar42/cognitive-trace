// graph_animator.ts — node.color en formato nativo {a, rgb}
// El renderer dibuja cada círculo blanco (radio 100) y lo colorea vía tint desde getFillColor().
// Un int crudo en node.color produce alpha NaN (u.a === undefined) y el nodo se vuelve invisible.
import { App, EventRef } from "obsidian";
import { TraceEvent } from "./event_reader";
import { CTSettings } from "./settings";

// Compartido con TimelineView para que los filtros controlen también el grafo
export type PipeKey = "traverse" | "read" | "search" | "create" | "commands";

export class GraphAnimator {
    private app: App;
    private settings: CTSettings;
    private enabled = true;
    private visitedNodes = new Set<string>();
    private readNodes = new Set<string>();  // body completo leído vía read
    private createdNodes = new Set<string>(); // archivos creados vía new
    private currentNode: string | null = null;
    // Pipe de origen por nodo → atenúa si el filtro del timeline está off
    private nodePipes = new Map<string, PipeKey>();
    // Referencia al Set del timeline; se asigna desde main.ts
    activePipes: Set<string> | null = null;
    private commandHighlights = new Map<string, string>();
    private highlightedPath: string[] = [];
    // Pulsos: onda expansiva cuando un nodo se pinta por primera vez o pasa a current.
    // Se marcan por cambio de estado lógico (no por transición de color) para que los
    // rebuilds de setData — que recrean nodos con color null — no re-disparen pulsos.
    private pendingPulses = new Set<string>();
    private flashNode: { slug: string; until: number } | null = null;  // click→highlight temporal
    // Se conserva hasta que el renderer tenga el nodo (la indexación de un
    // archivo nuevo puede llegar después del evento new).
    private pendingAppearances = new Set<string>();
    private pulses: Array<{ node: any; gfx: any; renderer: any; start: number; rgb: number; dur: number; beacon: boolean }> = [];
    private pulseRaf: number | null = null;
    // Revelado en cascada de result_nodes (orden BFS del traverse → onda por profundidad)
    private revealQueue: string[] = [];
    private revealTimer: number | null = null;
    private layoutEventRef: EventRef | null = null;
    private replayStep: (() => void) | null = null;
    private replayPaused = false;

    constructor(app: App, settings: CTSettings) {
        this.app = app;
        this.settings = settings;
        this.layoutEventRef = this.app.workspace.on("layout-change", () => {
            if (this.enabled) this.patchAndRefresh();
        });
    }

    destroy(): void {
        if (this.layoutEventRef) {
            this.app.workspace.offref(this.layoutEventRef);
            this.layoutEventRef = null;
        }
    }

    toggle(): void { this.enabled = !this.enabled; if (!this.enabled) this.reset(); }

    /** Re-aplica colores/aristas con los settings actuales (llamado al guardar config). */
    refresh(): void { this.patchAndRefresh(); }

    private hex(color: string): number {
        const v = parseInt(color.replace("#", ""), 16);
        return isNaN(v) ? 0xffffff : v;
    }

    /** Coincide un slug con su path sin confundir prefijos ni tags parecidos. */
    private nodeMatches(path: string, key: string): boolean {
        if (!path || !key) return false;
        if (path === key) return true;
        if (key.startsWith("#")) return false;
        // Match exacto por sufijo: "tp3-cibernetico" → "frameworks/tp3-cibernetico.md"
        if (path.endsWith("/" + key) || path.endsWith("/" + key + ".md") || path === key + ".md") return true;
        // Fuzzy fallback: slug abreviado "plan-maestro-de-adquisicion" matchea
        // "plans/plan-maestro-de-adquisicion-tp3studio.md" por prefijo de filename
        const keyFile = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
        const pathFile = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
        if (pathFile.startsWith(keyFile)) return true;
        return false;
    }

    /** Cargar solo el último prompt del historial (ventana sin gaps >60s). */
    loadHistory(events: TraceEvent[]): void {
        if (!events.length) return;
        // Seleccionar solo los eventos del último prompt (sin animaciones ni pulsos)
        const GAP = 60 * 1000;
        const last = this.lastPromptEvents(events, GAP);
        for (const e of last) {
            if (e.type === "command") { this.executeCommand(e); continue; }
            if (e.tool === "new" && e.params?.created_path && e.exit_code === 0) {
                const path = e.params.created_path;
                this.createdNodes.add(path);
                this.visitedNodes.add(path);
                this.nodePipes.set(path, "create");
                this.pendingAppearances.add(path);
                continue;
            }
            if ((e.tool === "traverse" || e.tool === "read") && e.params?.slug) {
                const slug = e.params.slug;
                const pipe: PipeKey = e.tool === "read" ? "read" : "traverse";
                this.visitedNodes.add(slug);
                this.nodePipes.set(slug, pipe);
                if (e.tool === "read") this.readNodes.add(slug);
                this.currentNode = slug;
            }
            if (Array.isArray(e.result_nodes)) {
                const resPipe: PipeKey = (e.tool === "traverse") ? "traverse" : "search";
                for (const p of e.result_nodes) {
                    this.visitedNodes.add(p);
                    const existing = this.nodePipes.get(p);
                    if (existing !== "read") this.nodePipes.set(p, resPipe);
                }
            }
        }
        this.lastEventTs = Math.max(...last.map(e => new Date(e.ts).getTime()));
        this.patchAndRefresh();
    }

    private audioCtx: AudioContext | null = null;
    private replayActive = false;
    private replayGeneration = 0;
    private replayDone: (() => void) | null = null;
    // Un pequeño margen permite programar el audio y dejar que el siguiente
    // frame visual comience en el mismo instante perceptual.
    private static readonly APPEARANCE_LEAD_MS = 40;

    /** Desbloquea el audio después de una interacción del usuario. */
    async unlockAudio(): Promise<void> {
        if (!this.settings.replayBeeps) return;
        try {
            if (!this.audioCtx) this.audioCtx = new AudioContext();
            if (this.audioCtx.state === "suspended") await this.audioCtx.resume();
        } catch (_) { /* audio no disponible */ }
    }

    /** Ping programado para el instante de aparición del nodo. */
    private beep(pipe: PipeKey, at?: number): void {
        try {
            const ctx = this.audioCtx;
	        if (!ctx || ctx.state !== "running") return;

            const now = at ?? ctx.currentTime;
            const dur = 0.25;
            const freq: Record<PipeKey, number> = {
                traverse: 1047, read: 784, search: 587, create: 1319, commands: 440,
            };
            const baseFreq = freq[pipe] || 660;

            const osc1 = ctx.createOscillator();
            const osc2 = ctx.createOscillator();
            const gain1 = ctx.createGain();
            const gain2 = ctx.createGain();

            osc1.type = "triangle";
            osc1.frequency.setValueAtTime(baseFreq * 1.4, now);
            osc1.frequency.exponentialRampToValueAtTime(baseFreq, now + dur * 0.6);

            osc2.type = "sine";
            osc2.frequency.setValueAtTime(baseFreq * 2, now);
            osc2.frequency.exponentialRampToValueAtTime(baseFreq * 2.2, now + dur * 0.1);

            gain1.gain.setValueAtTime(0.07, now);
	            gain1.gain.exponentialRampToValueAtTime(0.001, now + dur);

            gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.1);

            osc1.connect(gain1).connect(ctx.destination);
            osc2.connect(gain2).connect(ctx.destination);

            osc1.start(now); osc1.stop(now + dur + 0.05);
            osc2.start(now); osc2.stop(now + dur * 0.5 + 0.05);

            // Limpiar nodos después de que terminen (evita acumulación)
            osc1.onended = () => { try { osc1.disconnect(); gain1.disconnect(); } catch (_) {} };
            osc2.onended = () => { try { osc2.disconnect(); gain2.disconnect(); } catch (_) {} };
        } catch (_) { /* audio no disponible */ }
    }

    /** Replay animado de un prompt: limpia el estado y reproduce evento por evento. */
    private replayTimer: number | null = null;

    /** Revelar instantáneamente todos los nodos pendientes en la cola de cascada. */
    skipReveal(): void {
        if (this.revealTimer != null) {
            window.clearTimeout(this.revealTimer);
            this.revealTimer = null;
        }
        while (this.revealQueue.length) {
            const path = this.revealQueue.shift()!;
            if (this.queuedCommands.has(path)) {
                this.commandHighlights.set(path, this.queuedCommands.get(path)!);
                this.nodePipes.set(path, "commands");
                this.queuedCommands.delete(path);
            } else {
                this.visitedNodes.add(path);
            }
            this.pendingPulses.add(path);
        }
        this.patchAndRefresh();
        // Si el replay ya terminó de procesar eventos, notificar finish
        if (!this.replayActive && this.replayDone) this.finishReplay();
    }

    /** Detener el replay sin borrar lo que ya se ha revelado en el grafo. */
    stopReplay(): void {
        this.replayGeneration++;
        if (this.replayTimer != null) {
            window.clearTimeout(this.replayTimer);
            this.replayTimer = null;
        }
        if (this.revealTimer != null) {
            window.clearTimeout(this.revealTimer);
            this.revealTimer = null;
        }
        this.revealQueue = [];
        this.queuedCommands.clear();
        this.replayActive = false;
        this.replayPaused = false;
        this.replayStep = null;
        this.finishReplay();
    }

    toggleReplayPause(): void {
        // replayDone también cubre la ventana en la que AudioContext todavía
        // está esperando el gesto del usuario y replayActive aún es false.
        if (!this.replayActive && !this.replayDone) return;
        if (this.replayPaused) {
            this.replayPaused = false;
            if (this.replayActive) {
                this.replayTimer = window.setTimeout(() => this.replayStep?.(), 0);
            }
            if (this.revealQueue.length) this.scheduleReveal();
        } else {
            this.replayPaused = true;
            if (this.replayTimer != null) {
                window.clearTimeout(this.replayTimer);
                this.replayTimer = null;
            }
            if (this.revealTimer != null) {
                window.clearTimeout(this.revealTimer);
                this.revealTimer = null;
            }
        }
    }

    private finishReplay(): void {
        const done = this.replayDone;
        this.replayDone = null;
        done?.();
    }

    async replayPrompt(events: TraceEvent[], onDone?: () => void, onProgress?: (current: number, total: number) => void): Promise<void> {
        // Cancelar replay anterior
        this.stopReplay();
        const generation = this.replayGeneration;
        this.replayDone = onDone || null;
        // Limpiar estado
        this.visitedNodes.clear();
        this.readNodes.clear();
        this.createdNodes.clear();
        this.commandHighlights.clear();
        this.highlightedPath = [];
        this.nodePipes.clear();
        this.pendingPulses.clear();
        this.pendingAppearances.clear();
        this.revealQueue = [];
        this.queuedCommands.clear();
        this.focusTag = null;
        this.currentNode = null;
        this.patchAndRefresh();
        // Inicializar AudioContext con user gesture (click ▶) — garantiza running
        if (this.settings.replayBeeps) {
            await this.unlockAudio();
        }
        if (generation !== this.replayGeneration) return;
        this.replayActive = true;

        if (!events.length) { this.replayActive = false; this.finishReplay(); return; }
        const BASE_DELAY = 450;
        let i = 0;
        const scheduleNext = () => {
            if (generation !== this.replayGeneration) return;
            if (this.replayPaused) return;
            if (i >= events.length) {
                this.replayTimer = null;
                this.replayActive = false;
                this.replayStep = null;
                // Si la cascada de revelado aún tiene nodos, finishReplay()
                // se llama desde scheduleReveal cuando la cola se vacíe.
                if (!this.revealQueue.length) this.finishReplay();
                return;
            }
            const batch: TraceEvent[] = [events[i]];
            const baseTs = new Date(events[i].ts).getTime();
            i++;
            while (i < events.length) {
                const nextTs = new Date(events[i].ts).getTime();
                if (Math.abs(nextTs - baseTs) < 2000) { batch.push(events[i]); i++; }
                else break;
            }
            this.processEvents(batch);
            onProgress?.(i, events.length);
            const delay = Math.max(30, BASE_DELAY / (this.settings.replaySpeed || 1));
            this.replayTimer = window.setTimeout(scheduleNext, delay);
        };
        this.replayStep = scheduleNext;
        // Primer batch inmediato — sin delay inicial
        scheduleNext();
    }

    /** Último bloque continuo de eventos (sin gaps > threshold ms entre ellos). */
    private lastPromptEvents(events: TraceEvent[], gapMs: number): TraceEvent[] {
        if (events.length <= 1) return events;
        // Recorrer de atrás hacia adelante hasta encontrar un gap
        const chunk: TraceEvent[] = [];
        for (let i = events.length - 1; i >= 0; i--) {
            chunk.unshift(events[i]);
            if (i > 0) {
                const curr = new Date(events[i].ts).getTime();
                const prev = new Date(events[i - 1].ts).getTime();
                if (Math.abs(curr - prev) > gapMs) break;
            }
        }
        return chunk;
    }

    private lastEventTs = 0;

    processEvents(events: TraceEvent[]): void {
        if (!events.length) return;

        // Si esta tanda contiene uno o más cortes de 60s, conservar solo el
        // último conjunto temporal. El timeline conserva todos los eventos.
        let latestStart = 0;
        let hasGap = false;
        let previousTs = this.lastEventTs;
        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            const ts = new Date(e.ts).getTime();
            if (previousTs > 0 && (ts - previousTs) > 60_000) {
                latestStart = i;
                hasGap = true;
            }
            previousTs = ts;
        }
        if (hasGap) this.clearTraceState();
        const currentEvents = events.slice(latestStart);
        for (const e of currentEvents) {
            this.lastEventTs = Math.max(this.lastEventTs, new Date(e.ts).getTime());
            if (e.type === "command") { this.executeCommand(e); continue; }
            if (e.tool === "new" && e.params?.created_path && e.exit_code === 0) {
                const path = e.params.created_path;
                this.createdNodes.add(path);
                this.visitedNodes.add(path);
                this.nodePipes.set(path, "create");
                this.pendingAppearances.add(path);
                this.pendingPulses.add(path);
                continue;
            }
            if ((e.tool === "traverse" || e.tool === "read") && e.params?.slug) {
                const slug = e.params.slug;
                const pipe: PipeKey = e.tool === "read" ? "read" : "traverse";
                // Durante replay: siempre pulso, incluso en re-lecturas del mismo nodo
                if (!this.visitedNodes.has(slug) || this.currentNode !== slug || this.replayActive) {
                    this.pendingPulses.add(slug);
                }
                this.visitedNodes.add(slug);
                this.nodePipes.set(slug, pipe);
                if (e.tool === "read") this.readNodes.add(slug);
                this.currentNode = slug;
            }
            // Subgrafo del resultado: hereda el pipe de la tool que lo generó
            // (search result_nodes → pipe "search", graph → "search", etc.)
            if (Array.isArray(e.result_nodes)) {
                const resPipe: PipeKey = (e.tool === "traverse") ? "traverse" : "search";
                for (const p of e.result_nodes) {
                    const isNew = !this.visitedNodes.has(p);
                    if (this.settings.revealStagger > 0) {
                        if (isNew && !this.revealQueue.includes(p)) {
                            this.revealQueue.push(p);
                        }
                    } else {
                        this.visitedNodes.add(p);
                        // Sin cascada: pulso directo aquí (con cascada lo hace scheduleReveal)
                        if (isNew) this.pendingPulses.add(p);
                    }
                    const existing = this.nodePipes.get(p);
                    if (existing !== "read") this.nodePipes.set(p, resPipe);
                }
            }
        }
        this.patchAndRefresh();
        this.pendingPulses.clear();
        if (this.revealQueue.length) this.scheduleReveal();
    }

    // Revela el próximo nodo de la cola y re-agenda hasta vaciarla. setTimeout
    // encadenado (no interval) para que cambios de revealStagger apliquen en vivo.
    private scheduleReveal(): void {
        if (this.replayPaused || this.revealTimer != null) return;
        const step = () => {
            this.revealTimer = null;
            if (this.replayPaused) return;
            const path = this.revealQueue.shift();
            if (path == null) {
                // Cola vacía tras un replay → notificar finish pendiente
                if (!this.replayActive && this.replayDone) this.finishReplay();
                return;
            }
            // ¿Es un comando encolado?
            if (this.queuedCommands.has(path)) {
                this.commandHighlights.set(path, this.queuedCommands.get(path)!);
                this.nodePipes.set(path, "commands");
                this.queuedCommands.delete(path);
            } else {
                this.visitedNodes.add(path);
            }
            // Cada nodo de la cascada genera su propio pulso y beep.
            this.pendingPulses.add(path);
            this.patchAndRefresh();
            if (this.revealQueue.length) {
                this.revealTimer = window.setTimeout(step, Math.max(16, this.settings.revealStagger));
            }
        };
        this.revealTimer = window.setTimeout(step, Math.max(16, this.settings.revealStagger));
    }

    private executeCommand(cmd: TraceEvent): void {
        switch (cmd.action) {
            case "highlight_nodes": case "highlight_most_visited": case "highlight_least_visited":
            case "highlight_session":
                for (const n of cmd.nodes || []) {
                    const color = cmd.color || this.settings.colorCommand;
                    if (this.replayActive) {
                        // En replay: encolar para revelado escalonado (un nodo por vez)
                        if (!this.revealQueue.includes(n)) {
                            this.queuedCommands.set(n, color);
                            this.revealQueue.push(n);
                        }
                    } else {
                        if (!this.commandHighlights.has(n)) this.pendingPulses.add(n);
                        this.commandHighlights.set(n, color);
                        this.nodePipes.set(n, "commands");
                    }
                }
                break;
            case "highlight_path": this.highlightedPath = cmd.nodes || []; break;
            case "focus_cluster":
                if (cmd.tag) { this.focusTag = cmd.tag; this.pendingPulses.add(cmd.tag); }
                break;
            case "clear_highlights": this.commandHighlights.clear(); this.highlightedPath = []; break;
            case "reset_graph": this.reset(); break;
        }
    }

    // focus_cluster se resuelve en applyColors porque necesita acceso al renderer
    // (links del grafo). Se marca aquí para la siguiente pasada.
    // Cola de comandos para revelado escalonado durante replay
    private queuedCommands = new Map<string, string>(); // path → hex color
    private focusTag: string | null = null;

    private applyFocusCluster(r: any): void {
        if (!this.focusTag || !r?.links) return;
        const tagId = "#" + this.focusTag;
        const tagNode = r.nodes.find((n: any) => n.id === tagId);
        if (!tagNode) return;
        const connected: Set<string> = new Set();
        for (const link of r.links) {
            if (link.source === tagNode && link.target?.type !== "tag") connected.add(link.target.id);
            else if (link.target === tagNode && link.source?.type !== "tag") connected.add(link.source.id);
        }
        const color = this.hex(this.settings.colorCommand);
        for (const path of connected) {
            if (!this.commandHighlights.has(path)) this.pendingPulses.add(path);
            this.commandHighlights.set(path, "#" + color.toString(16).padStart(6, "0"));
            this.nodePipes.set(path, "commands");
        }
        this.focusTag = null; // one-shot
    }

    /** Limpiar traza sin tocar activePipes ni nodePipes (filtros + tipo).
     *  nodePipes se preserva: los paths viejos son inofensivos (no matchean
     *  sin visitedNodes/readNodes) y los nuevos se pisan en processEvents. */
    private clearTraceState(): void {
        this.visitedNodes.clear();
        this.readNodes.clear();
        this.createdNodes.clear();
        this.currentNode = null;
        this.commandHighlights.clear();
        this.focusTag = null;
        this.highlightedPath = [];
        this.pendingPulses.clear();
        this.pendingAppearances.clear();
        this.revealQueue = [];
        this.queuedCommands.clear();
        if (this.revealTimer != null) { window.clearTimeout(this.revealTimer); this.revealTimer = null; }
        this.clearPulses();
    }

    /** Buscar un nodo en el grafo por slug, con fallback flexible:
     *  1. Match exacto vía nodeMatches
     *  2. Match por {dir-padre}/{filename} ignorando prefijo de ruta (ej: migración sistema/skills → skills) */
    private findNode(slug: string): string | null {
        // Extraer "dir-padre/filename" del slug (últimos dos segmentos)
        const parts = slug.split("/");
        const tail = parts.slice(-2).join("/");  // ej: "browser-automation/SKILL.md"
        for (const leaf of this.app.workspace.getLeavesOfType("graph")) {
            const r = (leaf.view as any)?.renderer;
            if (!r?.nodes) continue;
            for (const node of r.nodes) {
                const path: string = node.id || "";
                if (this.nodeMatches(path, slug)) return path;
                if (path.endsWith("/" + tail) || path === tail) return path;
            }
        }
        return null;
    }

    /** Forzar un destello + pulso en un nodo específico (click en timeline → highlight en grafo). */
    highlightNode(slug: string): void {
        const match = this.findNode(slug);
        if (!match) return;  // nodo no encontrado en el grafo
        // Beep de highlight
        if (this.settings.replayBeeps && this.audioCtx?.state === "running") {
            this.beep("traverse");
        }
        this.flashNode = { slug: match, until: Date.now() + 1200 };
        this.patchAndRefresh();
        setTimeout(() => this.flashNode = null, 1200);
        setTimeout(() => this.patchAndRefresh(), 1250);
    }

    reset(): void {
        this.clearTraceState();
        this.nodePipes.clear();
        if (this.replayTimer != null) { window.clearTimeout(this.replayTimer); this.replayTimer = null; }
        this.replayActive = false;
        this.patchAndRefresh();
    }

    private patchAndRefresh(): void {
        for (const leaf of this.app.workspace.getLeavesOfType("graph")) {
            const r = (leaf.view as any)?.renderer;
            if (!r) continue;
            // El hook delega vía _ctAnimator para que un hot-reload del plugin
            // reemplace el animator sin dejar un closure zombie sobre setData.
            r._ctAnimator = this;
            if (!r._ct) {
                r._ct = true;
                const orig = r.setData.bind(r);
                r.setData = function(data: any) {
                    const ret = orig(data);
                    r._ctAnimator?.applyColors(r);
                    return ret;
                };
            }
        }
        for (const leaf of this.app.workspace.getLeavesOfType("graph")) {
            const r = (leaf.view as any)?.renderer;
            this.applyColors(r);
            // Despertar el render loop si está idle para que tint/alpha converjan
            try { r?.changed?.(); } catch (_) {}
        }
    }

    private applyColors(r: any): void {
        if (!r?.nodes) return;

        // focus_cluster: resolver una vez, la primera pasada con renderer disponible
        this.applyFocusCluster(r);


        const flashing = this.flashNode && Date.now() < this.flashNode.until ? this.flashNode.slug : null;
        if (this.flashNode && !flashing) this.flashNode = null;  // expiró

        for (const node of r.nodes) {
            const path: string = node.id || "";
            if (!path) continue;
            // Destello one-shot (click→highlight): dorado + pulso, no aplicar lógica normal
            if (flashing && this.nodeMatches(path, flashing)) {
                const flashRgb = this.hex(this.settings.colorCurrent);
                if (!node.color || node.color.rgb !== flashRgb) {
                    node.color = { a: 1, rgb: flashRgb };
                    // Pulso de onda expansiva
                    if (this.settings.pulseEnabled) {
                        this.spawnPulse(r, node, flashRgb, false);
                    }
                }
                continue;
            }

            let targetColor: number | null = null;

            for (const [cn, cc] of this.commandHighlights) {
                if (this.nodeMatches(path, cn)) {
                    targetColor = parseInt(cc.replace("#",""), 16);
                    // Guardar pipe con path completo (no el slug parcial)
                    this.nodePipes.set(path, "commands");
                    break;
                }
            }
            // ── Prioridad de color (mayor a menor) ──
            // En cada match guardamos nodePipes con path COMPLETO (node.id),
            // no con el slug parcial. Map.get() es exacto; si no, el filtro
            // de atenuación nunca encuentra el pipe y el nodo nunca se atenúa.
            if (targetColor == null && this.currentNode && this.nodeMatches(path, this.currentNode)) {
                targetColor = this.hex(this.settings.colorCurrent);
                let isRead = false;
                for (const rn of this.readNodes) { if (this.nodeMatches(path, rn)) { isRead = true; break; } }
                this.nodePipes.set(path, isRead ? "read" : "traverse");
            }
            if (targetColor == null) {
                for (const cn of this.createdNodes) {
                    if (this.nodeMatches(path, cn)) {
                        targetColor = this.hex(this.settings.colorCreate);
                        this.nodePipes.set(path, "create");
                        if (this.pendingAppearances.has(cn)) this.pendingPulses.add(cn);
                        break;
                    }
                }
            }
            if (targetColor == null) {
                // Leídos (body en contexto) tienen prioridad sobre vistos (solo ficha)
                let isRead = false;
                for (const rn of this.readNodes) { if (this.nodeMatches(path, rn)) { isRead = true; break; } }
                if (isRead) {
                    targetColor = this.hex(this.settings.colorRead);
                    this.nodePipes.set(path, "read");
                }
            }
            if (targetColor == null) {
                let visited = false;
                for (const vn of this.visitedNodes) { if (this.nodeMatches(path, vn)) { visited = true; break; } }
                if (visited) {
                    targetColor = this.hex(this.settings.colorVisited);
                    // Solo si no tenía pipe (result_nodes ya lo setearon con path completo)
                    if (!this.nodePipes.has(path)) this.nodePipes.set(path, "traverse");
                }
            }
            if (targetColor == null && this.highlightedPath.includes(path)) targetColor = this.hex(this.settings.colorPath);

            if (targetColor != null) {
                // Si el filtro del timeline correspondiente está apagado,
                // devolver el nodo a su color base de Obsidian (no atenuar).
                const pipe = this.nodePipes.get(path);
                const pipeActive = !pipe || !this.activePipes || this.activePipes.has(pipe);
                if (!pipeActive) {
                    if (node.color != null) node.color = null;
                    continue;
                }
                const newColor = { a: 1, rgb: targetColor };
                if (!node.color || node.color.rgb !== targetColor) {
                    node.color = newColor;
                    for (const key of this.pendingPulses) {
                        if (this.nodeMatches(path, key)) {
                            const startAt = performance.now() + GraphAnimator.APPEARANCE_LEAD_MS;
                            const pipe = (this.nodePipes.get(path) || "traverse") as PipeKey;
                            if (this.settings.replayBeeps) {
                                const delay = Math.max(0, startAt - performance.now()) / 1000;
                                this.beep(pipe, (this.audioCtx?.currentTime || 0) + delay);
                            }
                            if (this.settings.pulseEnabled) {
                                this.spawnPulse(r, node, targetColor, false, startAt);
                            }
                            for (const appearance of this.pendingAppearances) {
                                if (this.nodeMatches(path, appearance)) this.pendingAppearances.delete(appearance);
                            }
                            break;
                        }
                    }
                }
            } else if (node.color != null) {
                node.color = null;
            }
        }

        this.applyLinkColors(r);
        this.syncBeacon(r);
    }

    // Beacon: pulso indefinido sobre el nodo current. Se reconcilia en cada pasada
    // (re-apunta al node object fresco tras rebuilds de setData, sigue al current
    // cuando el agente avanza, y muere si el setting o el trace se apagan).
    private syncBeacon(r: any): void {
        const existing = this.pulses.find(p => p.beacon && p.renderer === r);
        const want = this.settings.pulseIndefinite && this.enabled && this.currentNode;
        if (!want) {
            if (existing) this.killPulse(this.pulses.indexOf(existing));
            return;
        }
        const node = r?.nodes?.find((n: any) => this.nodeMatches(n.id || "", this.currentNode as string));
        if (!node) {
            if (existing) this.killPulse(this.pulses.indexOf(existing));
            return;
        }
        if (existing) {
            existing.node = node;
            existing.rgb = this.hex(this.settings.colorCurrent);
            existing.dur = this.settings.pulseDuration || 900;
        } else {
            this.spawnPulse(r, node, this.hex(this.settings.colorCurrent), true);
        }
    }

    // Los links NO tienen slot nativo de color: su render() fuerza line.tint = colors.line
    // con un lerp (vQ) cada frame, así que tintear directo no persiste. Parcheamos el
    // prototipo de la clase link para escribir DESPUÉS del render nativo — nuestro tint
    // gana cada frame sin pelear con el lerp ni tocar geometría. El wrapper es stateless
    // (solo lee link.$ctColor), por lo que sobrevive rebuilds y hot-reloads sin zombies.
    private static readonly LINK_PATCH_V = 4;
    private static readonly EDGE_ALPHA = 0.55;

    private patchLinkRender(r: any): void {
        const sample = r.links?.[0];
        if (!sample) return;
        const proto = Object.getPrototypeOf(sample);
        // El prototipo es de la clase de Obsidian y sobrevive hot-reloads del plugin:
        // versionamos el patch y re-instalamos envolviendo SIEMPRE el original real.
        if (proto._ctPatchV === GraphAnimator.LINK_PATCH_V) return;
        const orig = proto._ctOrigRender || proto.render;
        proto._ctOrigRender = orig;
        proto._ctPatchV = GraphAnimator.LINK_PATCH_V;
        proto.render = function () {
            orig.call(this);
            const c = this.$ctColor;
            if (c != null && this.line) {
                this.line.tint = c;
                this.line.alpha = GraphAnimator.EDGE_ALPHA;
                if (this.arrow) this.arrow.tint = c;
                if (this.arrow) this.arrow.alpha = GraphAnimator.EDGE_ALPHA;
                // Animación progresiva: la línea crece desde source hacia target
                if (this.$ctAnimStart) {
                    const elapsed = performance.now() - this.$ctAnimStart;
                    const dur = this.$ctAnimDur || 500;
                    const t = Math.max(0, Math.min(1, elapsed / dur));
                    const ease = 1 - (1 - t) * (1 - t); // ease-out
                    const baseWidth = this.$ctAnimBaseWidth ?? this.line.width;
                    // Antes del instante de inicio el render nativo conserva la
                    // línea completa; nunca multiplicar el ancho acumulado.
                    if (elapsed >= 0) this.line.width = baseWidth * ease;
                    if (this.arrow) this.arrow.alpha = t * GraphAnimator.EDGE_ALPHA;
                    if (t >= 1) {
                        this.line.width = baseWidth;
                        this.$ctAnimStart = null;
                        this.$ctAnimBaseWidth = null;
                    }
                    // Mantener el render loop despierto durante la animación
                    try { this.renderer.changed?.(); } catch (_) {}
                }
            }
            const z = c != null ? 0.5 : 0;
            if (this.px && this.px.zIndex !== z) {
                this.px.zIndex = z;
                this.renderer.hanger.sortChildren();
            }
        };
    }

    private applyLinkColors(r: any): void {
        if (!r?.links) return;
        if (!this.settings.edgeColoring) {
            for (const link of r.links) {
                if (link.$ctColor != null) link.$ctColor = null;
                link.$ctAnimStart = null;
                link.$ctAnimBaseWidth = null;
            }
            return;
        }
        this.patchLinkRender(r);
        const gold = this.hex(this.settings.colorCurrent);
        const neutral = this.hex(this.settings.colorVisited);
        for (const link of r.links) {
            const sc = link.source?.color;
            const tc = link.target?.color;
            if (sc && tc) {
                // Verificar que ambos endpoints tengan su pipe activo (filtros del timeline)
                const sp = this.nodePipes.get(link.source?.id || "");
                const tp = this.nodePipes.get(link.target?.id || "");
                const bothActive = (!sp || !this.activePipes || this.activePipes.has(sp)) &&
                                   (!tp || !this.activePipes || this.activePipes.has(tp));
                if (!bothActive) {
                    if (link.$ctColor != null) link.$ctColor = null;
                    link.$ctAnimStart = null;
                    link.$ctAnimBaseWidth = null;
                    continue;
                }
                // Color de current si toca ese nodo; hereda el color si ambos endpoints
                // coinciden (visitados, path, highlights); neutro (visitados) si son mixtos.
                const target = (sc.rgb === gold || tc.rgb === gold) ? gold :
                               (sc.rgb === tc.rgb) ? sc.rgb : neutral;
                if (link.$ctColor !== target) {
                    link.$ctColor = target;
                    link.$ctAnimBaseWidth = typeof link.line?.width === "number" ? link.line.width : null;
                    link.$ctAnimStart = performance.now();
                    link.$ctAnimDur = 500;
                }
            } else if (link.$ctColor != null) {
                link.$ctColor = null;
                link.$ctAnimStart = null;
                link.$ctAnimBaseWidth = null;
            }
        }
    }

    // ── Pulsos ───────────────────────────────────────────────────────────────
    // Onda expansiva alrededor de un nodo recién pintado. El anillo es un
    // PIXI.Graphics propio en el hanger (instanciado vía el constructor del
    // círculo de un nodo — no hay global PIXI garantizado), redibujado por
    // frame para seguir al nodo mientras la simulación lo mueve.

    private spawnPulse(
        r: any,
        node: any,
        rgb: number,
        beacon = false,
        startAt = performance.now(),
    ): void {
        try {
            if (!r?.hanger) return;
            const GraphicsCtor = node.circle?.constructor || r.links?.[0]?.arrow?.constructor;
            if (!GraphicsCtor) return;
            const gfx: any = new GraphicsCtor();
            gfx.eventMode = "none";
            gfx.zIndex = 1.5; // sobre nodos (1), bajo labels (2) si algo re-sortea
            r.hanger.addChild(gfx);
            this.pulses.push({ node, gfx, renderer: r, start: startAt, rgb, dur: this.settings.pulseDuration || 900, beacon });
            if (this.pulseRaf == null) this.tickPulses();
        } catch (_) { /* sin Graphics accesible, sin pulso */ }
    }

    private tickPulses(): void {
        const step = () => {
            const now = performance.now();
            for (let i = this.pulses.length - 1; i >= 0; i--) {
                const p = this.pulses[i];
                let t = (now - p.start) / p.dur;
                try {
                    if (p.gfx.destroyed || !p.renderer?.hanger) {
                        this.killPulse(i);
                        continue;
                    }
                    if (t < 0) {
                        p.gfx.clear();
                        continue;
                    }
                    if (t >= 1) {
                        if (!p.beacon) { this.killPulse(i); continue; }
                        if (t >= 1.35) { p.start = now; t = 0; }
                        else { p.gfx.clear(); continue; }
                    }
                    const worldR = p.node.getSize() * p.renderer.nodeScale;
                    const scale = p.renderer.scale || 1;
                    // Anillo principal: explota desde 0.6x hasta 3.2x el radio del nodo
                    const ringEase = 1 - (1 - t) * (1 - t);
                    const ringR = worldR * (0.6 + 2.6 * ringEase);
                    const ringAlpha = 0.85 * (1 - t);
                    const lw = Math.max(2.5, 4.0 / scale);
                    p.gfx.clear();
                    // Flash central: círculo sólido que aparece los primeros 180ms
                    if (t < 0.3) {
                        const flashAlpha = 0.3 * (1 - t / 0.3);
                        const flashR = worldR * (0.5 + 0.5 * (t / 0.3));
                        p.gfx.beginFill(p.rgb, flashAlpha);
                        p.gfx.drawCircle(0, 0, flashR);
                        p.gfx.endFill();
                    }
                    // Anillo de explosión
                    p.gfx.lineStyle(lw, p.rgb, ringAlpha);
                    p.gfx.drawCircle(0, 0, ringR);
                    // Segundo anillo más fino y rápido (estela)
                    const trailR = worldR * (0.4 + 3.0 * ringEase * ringEase);
                    p.gfx.lineStyle(Math.max(1, 2.0 / scale), p.rgb, ringAlpha * 0.4);
                    p.gfx.drawCircle(0, 0, trailR);
                    p.gfx.x = p.node.x;
                    p.gfx.y = p.node.y;
                    // Scale bounce del nodo: +8% durante los primeros 250ms
                    if (!p.beacon && p.node.circle && t < 0.4) {
                        const bounce = 1 + 0.08 * (1 - t / 0.4) * Math.cos(t * Math.PI * 3);
                        const s = p.node.getSize() / 100 * p.renderer.nodeScale;
                        p.node.circle.scale.x = s * bounce;
                        p.node.circle.scale.y = s * bounce;
                    }
                } catch (_) {
                    this.killPulse(i);
                }
            }
            if (this.pulses.length) {
                // Mantener el render loop despierto mientras haya pulsos activos
                const seen = new Set<any>();
                for (const p of this.pulses) {
                    if (seen.has(p.renderer)) continue;
                    seen.add(p.renderer);
                    try { p.renderer.changed?.(); } catch (_) {}
                }
                this.pulseRaf = requestAnimationFrame(step);
            } else {
                this.pulseRaf = null;
            }
        };
        this.pulseRaf = requestAnimationFrame(step);
    }

    private killPulse(i: number): void {
        const p = this.pulses[i];
        // Restaurar escala del nodo si el bounce la modificó
        if (!p.beacon && p.node.circle) {
            try {
                const s = p.node.getSize() / 100 * p.renderer.nodeScale;
                p.node.circle.scale.x = s;
                p.node.circle.scale.y = s;
            } catch (_) {}
        }
        try { p.gfx.parent?.removeChild(p.gfx); p.gfx.destroy(); } catch (_) {}
        this.pulses.splice(i, 1);
    }

    private clearPulses(): void {
        while (this.pulses.length) this.killPulse(this.pulses.length - 1);
        if (this.pulseRaf != null) { cancelAnimationFrame(this.pulseRaf); this.pulseRaf = null; }
    }
}
