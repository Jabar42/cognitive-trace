// graph_animator.ts — node.color en formato nativo {a, rgb}
// El renderer dibuja cada círculo blanco (radio 100) y lo colorea vía tint desde getFillColor().
// Un int crudo en node.color produce alpha NaN (u.a === undefined) y el nodo se vuelve invisible.
import { App } from "obsidian";
import { TraceEvent } from "./event_reader";
import { CTSettings } from "./settings";

export class GraphAnimator {
    private app: App;
    private settings: CTSettings;
    private enabled = true;
    private visitedNodes = new Set<string>();
    private readNodes = new Set<string>();  // body completo leído vía okf_read
    private currentNode: string | null = null;
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

    processEvents(events: TraceEvent[]): void {
        for (const e of events) {
            if (e.type === "command") { this.executeCommand(e); continue; }
            if ((e.tool === "okf_traverse" || e.tool === "okf_read") && e.params?.slug) {
                const slug = e.params.slug;
                if (!this.visitedNodes.has(slug) || this.currentNode !== slug) {
                    this.pendingPulses.add(slug);
                }
                this.visitedNodes.add(slug);
                // okf_read = body completo inyectado al contexto → nivel epistémico propio
                if (e.tool === "okf_read") this.readNodes.add(slug);
                this.currentNode = slug;
            }
            // Subgrafo del resultado (traverse/search): se pintan como visitados
            // pero SIN pendingPulses — 60 pulsos simultáneos serían ruido visual.
            // Con revealStagger > 0 se encolan y revelan uno por uno.
            if (Array.isArray(e.result_nodes)) {
                for (const p of e.result_nodes) {
                    if (this.settings.revealStagger > 0) {
                        if (!this.visitedNodes.has(p) && !this.revealQueue.includes(p)) {
                            this.revealQueue.push(p);
                        }
                    } else {
                        this.visitedNodes.add(p);
                    }
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
                }
                break;
            case "highlight_path": this.highlightedPath = cmd.nodes || []; break;
            case "clear_highlights": this.commandHighlights.clear(); this.highlightedPath = []; break;
            case "reset_graph": this.reset(); break;
        }
    }

    reset(): void {
        this.visitedNodes.clear();
        this.readNodes.clear();
        this.currentNode = null;
        this.commandHighlights.clear();
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

        for (const node of r.nodes) {
            const path: string = node.id || "";
            if (!path) continue;

            let targetColor: number | null = null;

            for (const [cn, cc] of this.commandHighlights) {
                if (path.includes(cn)) { targetColor = parseInt(cc.replace("#",""), 16); break; }
            }
            if (targetColor == null && this.currentNode && path.includes(this.currentNode)) targetColor = this.hex(this.settings.colorCurrent);
            if (targetColor == null) {
                // Leídos (body en contexto) tienen prioridad sobre vistos (solo ficha)
                let isRead = false;
                for (const rn of this.readNodes) { if (path.includes(rn)) { isRead = true; break; } }
                if (isRead) targetColor = this.hex(this.settings.colorRead);
            }
            if (targetColor == null) {
                let visited = false;
                for (const vn of this.visitedNodes) { if (path.includes(vn)) { visited = true; break; } }
                if (visited) targetColor = this.hex(this.settings.colorVisited);
            }
            if (targetColor == null && this.highlightedPath.includes(path)) targetColor = this.hex(this.settings.colorPath);

            if (targetColor != null) {
                // Formato nativo de Obsidian: {a, rgb} — igual que renderer.colors.*
                // La geometría y el tamaño NO se tocan: el renderer tintea el círculo base.
                if (!node.color || node.color.rgb !== targetColor) {
                    node.color = { a: 1, rgb: targetColor };
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
