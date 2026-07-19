// graph_animator.ts — node.color en formato nativo {a, rgb}
// El renderer dibuja cada círculo blanco (radio 100) y lo colorea vía tint desde getFillColor().
// Un int crudo en node.color produce alpha NaN (u.a === undefined) y el nodo se vuelve invisible.
import { App } from "obsidian";
import { TraceEvent } from "./event_reader";
import { CTSettings } from "./settings";

// Compartido con TimelineView para que los filtros controlen también el grafo
export type PipeKey = "traverse" | "read" | "search" | "commands";

export class GraphAnimator {
    private app: App;
    private settings: CTSettings;
    private enabled = true;
    private visitedNodes = new Set<string>();
    private readNodes = new Set<string>();  // body completo leído vía okf_read
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
    private pulses: Array<{ node: any; gfx: any; renderer: any; start: number; rgb: number; dur: number; beacon: boolean }> = [];
    private pulseRaf: number | null = null;
    // Revelado en cascada de result_nodes (orden BFS del traverse → onda por profundidad)
    private revealQueue: string[] = [];
    private revealTimer: number | null = null;

    constructor(app: App, settings: CTSettings) {
        this.app = app;
        this.settings = settings;
        this.app.workspace.on("layout-change", () => {
            if (this.enabled) this.patchAndRefresh();
        });
    }

    toggle(): void { this.enabled = !this.enabled; if (!this.enabled) this.reset(); }

    /** Re-aplica colores/aristas con los settings actuales (llamado al guardar config). */
    refresh(): void { this.patchAndRefresh(); }

    private hex(color: string): number {
        const v = parseInt(color.replace("#", ""), 16);
        return isNaN(v) ? 0xffffff : v;
    }

    /** Cargar solo el último prompt del historial (ventana sin gaps >60s). */
    loadHistory(events: TraceEvent[]): void {
        if (!events.length) return;
        // Seleccionar solo los eventos del último prompt (sin animaciones ni pulsos)
        const GAP = 60 * 1000;
        const last = this.lastPromptEvents(events, GAP);
        for (const e of last) {
            if (e.type === "command") { this.executeCommand(e); continue; }
            if ((e.tool === "okf_traverse" || e.tool === "okf_read") && e.params?.slug) {
                const slug = e.params.slug;
                const pipe: PipeKey = e.tool === "okf_read" ? "read" : "traverse";
                this.visitedNodes.add(slug);
                this.nodePipes.set(slug, pipe);
                if (e.tool === "okf_read") this.readNodes.add(slug);
                this.currentNode = slug;
            }
            if (Array.isArray(e.result_nodes)) {
                const resPipe: PipeKey = (e.tool === "okf_traverse") ? "traverse" : "search";
                for (const p of e.result_nodes) {
                    this.visitedNodes.add(p);
                    const existing = this.nodePipes.get(p);
                    if (existing !== "read") this.nodePipes.set(p, resPipe);
                }
            }
        }
        this.patchAndRefresh();
    }

    /** Cargar un prompt específico — limpia el estado actual y pinta solo estos eventos. */
    loadPrompt(events: TraceEvent[]): void {
        this.visitedNodes.clear();
        this.readNodes.clear();
        this.commandHighlights.clear();
        this.highlightedPath = [];
        this.nodePipes.clear();
        this.pendingPulses.clear();
        this.revealQueue = [];
        this.focusTag = null;
        if (this.revealTimer != null) { window.clearTimeout(this.revealTimer); this.revealTimer = null; }
        // Reconstruir estado solo con estos eventos (sin animaciones)
        for (const e of events) {
            if (e.type === "command") { this.executeCommand(e); continue; }
            if ((e.tool === "okf_traverse" || e.tool === "okf_read") && e.params?.slug) {
                const slug = e.params.slug;
                const pipe: PipeKey = e.tool === "okf_read" ? "read" : "traverse";
                this.visitedNodes.add(slug);
                this.nodePipes.set(slug, pipe);
                if (e.tool === "okf_read") this.readNodes.add(slug);
                this.currentNode = slug;
            }
            if (Array.isArray(e.result_nodes)) {
                const resPipe: PipeKey = (e.tool === "okf_traverse") ? "traverse" : "search";
                for (const p of e.result_nodes) {
                    this.visitedNodes.add(p);
                    const existing = this.nodePipes.get(p);
                    if (existing !== "read") this.nodePipes.set(p, resPipe);
                }
            }
        }
        this.patchAndRefresh();
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

    processEvents(events: TraceEvent[]): void {
        for (const e of events) {
            if (e.type === "command") { this.executeCommand(e); continue; }
            if ((e.tool === "okf_traverse" || e.tool === "okf_read") && e.params?.slug) {
                const slug = e.params.slug;
                const pipe: PipeKey = e.tool === "okf_read" ? "read" : "traverse";
                if (!this.visitedNodes.has(slug) || this.currentNode !== slug) {
                    this.pendingPulses.add(slug);
                }
                this.visitedNodes.add(slug);
                this.nodePipes.set(slug, pipe);
                if (e.tool === "okf_read") this.readNodes.add(slug);
                this.currentNode = slug;
            }
            // Subgrafo del resultado: hereda el pipe de la tool que lo generó
            // (okf_search result_nodes → pipe "search", okf_graph → "search", etc.)
            if (Array.isArray(e.result_nodes)) {
                const resPipe: PipeKey = (e.tool === "okf_traverse") ? "traverse" : "search";
                for (const p of e.result_nodes) {
                    if (this.settings.revealStagger > 0) {
                        if (!this.visitedNodes.has(p) && !this.revealQueue.includes(p)) {
                            this.revealQueue.push(p);
                        }
                    } else {
                        this.visitedNodes.add(p);
                    }
                    // Respetar jerarquía de pipes: read > traverse > search
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
        if (this.revealTimer != null) return;
        const step = () => {
            this.revealTimer = null;
            const path = this.revealQueue.shift();
            if (path == null) return;
            this.visitedNodes.add(path);
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
                for (const n of cmd.nodes || []) {
                    if (!this.commandHighlights.has(n)) this.pendingPulses.add(n);
                    this.commandHighlights.set(n, cmd.color || this.settings.colorCommand);
                    this.nodePipes.set(n, "commands");
                }
                break;
            case "highlight_session":
                for (const n of cmd.nodes || []) {
                    if (!this.commandHighlights.has(n)) this.pendingPulses.add(n);
                    this.commandHighlights.set(n, cmd.color || this.settings.colorCommand);
                    this.nodePipes.set(n, "commands");
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
    private focusTag: string | null = null;

    private applyFocusCluster(r: any): void {
        if (!this.focusTag || !r?.links) return;
        const tagId = "#" + this.focusTag;
        const tagNode = r.nodes.find((n: any) => n.id === tagId || (n.type === "tag" && (n.id || "").includes(this.focusTag as string)));
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

    reset(): void {
        this.visitedNodes.clear();
        this.readNodes.clear();
        this.nodePipes.clear();
        this.currentNode = null;
        this.commandHighlights.clear();
        this.focusTag = null;
        this.highlightedPath = [];
        this.pendingPulses.clear();
        this.revealQueue = [];
        if (this.revealTimer != null) { window.clearTimeout(this.revealTimer); this.revealTimer = null; }
        this.clearPulses();
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

        for (const node of r.nodes) {
            const path: string = node.id || "";
            if (!path) continue;

            let targetColor: number | null = null;

            for (const [cn, cc] of this.commandHighlights) {
                if (path.includes(cn)) {
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
            if (targetColor == null && this.currentNode && path.includes(this.currentNode)) {
                targetColor = this.hex(this.settings.colorCurrent);
                let isRead = false;
                for (const rn of this.readNodes) { if (path.includes(rn)) { isRead = true; break; } }
                this.nodePipes.set(path, isRead ? "read" : "traverse");
            }
            if (targetColor == null) {
                // Leídos (body en contexto) tienen prioridad sobre vistos (solo ficha)
                let isRead = false;
                for (const rn of this.readNodes) { if (path.includes(rn)) { isRead = true; break; } }
                if (isRead) {
                    targetColor = this.hex(this.settings.colorRead);
                    this.nodePipes.set(path, "read");
                }
            }
            if (targetColor == null) {
                let visited = false;
                for (const vn of this.visitedNodes) { if (path.includes(vn)) { visited = true; break; } }
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
                    if (this.settings.pulseEnabled) {
                        for (const key of this.pendingPulses) {
                            if (path.includes(key)) { this.spawnPulse(r, node, targetColor); break; }
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
        const node = r?.nodes?.find((n: any) => (n.id || "").includes(this.currentNode as string));
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
    private static readonly LINK_PATCH_V = 2;

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
                if (this.arrow) this.arrow.tint = c;
            }
            // Capa intermedia: encima de las líneas de tema (zIndex 0), debajo de
            // nodos/flechas (zIndex 1). El hanger tiene sortableChildren apagado,
            // así que el re-sort se dispara manualmente y solo en transiciones.
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
            for (const link of r.links) { if (link.$ctColor != null) link.$ctColor = null; }
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
                    continue;
                }
                // Color de current si toca ese nodo; hereda el color si ambos endpoints
                // coinciden (visitados, path, highlights); neutro (visitados) si son mixtos.
                if (sc.rgb === gold || tc.rgb === gold) link.$ctColor = gold;
                else if (sc.rgb === tc.rgb) link.$ctColor = sc.rgb;
                else link.$ctColor = neutral;
            } else if (link.$ctColor != null) {
                link.$ctColor = null;
            }
        }
    }

    // ── Pulsos ───────────────────────────────────────────────────────────────
    // Onda expansiva alrededor de un nodo recién pintado. El anillo es un
    // PIXI.Graphics propio en el hanger (instanciado vía el constructor del
    // círculo de un nodo — no hay global PIXI garantizado), redibujado por
    // frame para seguir al nodo mientras la simulación lo mueve.

    private spawnPulse(r: any, node: any, rgb: number, beacon = false): void {
        try {
            if (!r?.hanger) return;
            const GraphicsCtor = node.circle?.constructor || r.links?.[0]?.arrow?.constructor;
            if (!GraphicsCtor) return;
            const gfx: any = new GraphicsCtor();
            gfx.eventMode = "none";
            gfx.zIndex = 1.5; // sobre nodos (1), bajo labels (2) si algo re-sortea
            r.hanger.addChild(gfx);
            this.pulses.push({ node, gfx, renderer: r, start: performance.now(), rgb, dur: this.settings.pulseDuration || 900, beacon });
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
                    if (t >= 1) {
                        if (!p.beacon) { this.killPulse(i); continue; }
                        // Beacon: pausa del 35% del ciclo entre ondas, luego reinicia
                        if (t >= 1.35) { p.start = now; t = 0; }
                        else { p.gfx.clear(); continue; }
                    }
                    const ease = 1 - (1 - t) * (1 - t);
                    const worldR = p.node.getSize() * p.renderer.nodeScale;
                    const lw = Math.max(1, 1.5 / (p.renderer.scale || 1));
                    p.gfx.clear();
                    p.gfx.lineStyle(lw, p.rgb, 0.55 * (1 - t));
                    p.gfx.drawCircle(0, 0, worldR * (1.15 + 1.1 * ease));
                    p.gfx.x = p.node.x;
                    p.gfx.y = p.node.y;
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
        try { p.gfx.parent?.removeChild(p.gfx); p.gfx.destroy(); } catch (_) {}
        this.pulses.splice(i, 1);
    }

    private clearPulses(): void {
        while (this.pulses.length) this.killPulse(this.pulses.length - 1);
        if (this.pulseRaf != null) { cancelAnimationFrame(this.pulseRaf); this.pulseRaf = null; }
    }
}
