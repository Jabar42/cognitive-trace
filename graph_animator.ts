// graph_animator.ts — node.color en formato nativo {a, rgb}
// El renderer dibuja cada círculo blanco (radio 100) y lo colorea vía tint desde getFillColor().
// Un int crudo en node.color produce alpha NaN (u.a === undefined) y el nodo se vuelve invisible.
import { App } from "obsidian";
import { TraceEvent } from "./event_reader";

export class GraphAnimator {
    private app: App;
    private enabled = true;
    private visitedNodes = new Set<string>();
    private currentNode: string | null = null;
    private commandHighlights = new Map<string, string>();
    private highlightedPath: string[] = [];

    constructor(app: App) {
        this.app = app;
        this.app.workspace.on("layout-change", () => {
            if (this.enabled) this.patchAndRefresh();
        });
    }

    toggle(): void { this.enabled = !this.enabled; if (!this.enabled) this.reset(); }

    processEvents(events: TraceEvent[]): void {
        for (const e of events) {
            if (e.type === "command") this.executeCommand(e);
            else if ((e.tool === "okf_traverse" || e.tool === "okf_read") && e.params?.slug) {
                this.visitedNodes.add(e.params.slug);
                this.currentNode = e.params.slug;
            }
        }
        this.patchAndRefresh();
    }

    private executeCommand(cmd: TraceEvent): void {
        switch (cmd.action) {
            case "highlight_nodes": case "highlight_most_visited": case "highlight_least_visited":
                for (const n of cmd.nodes || []) this.commandHighlights.set(n, cmd.color || "#FF6B35");
                break;
            case "highlight_path": this.highlightedPath = cmd.nodes || []; break;
            case "clear_highlights": this.commandHighlights.clear(); this.highlightedPath = []; break;
            case "reset_graph": this.reset(); break;
        }
    }

    reset(): void {
        this.visitedNodes.clear();
        this.currentNode = null;
        this.commandHighlights.clear();
        this.highlightedPath = [];
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
            if (targetColor == null && this.currentNode && path.includes(this.currentNode)) targetColor = 0xFFD700;
            if (targetColor == null) {
                let visited = false;
                for (const vn of this.visitedNodes) { if (path.includes(vn)) { visited = true; break; } }
                if (visited) targetColor = 0x4FC3F7; // cyan — distinguible del fill default (#B3B3B3) y del dorado current
            }
            if (targetColor == null && this.highlightedPath.includes(path)) targetColor = 0x00FF00;

            if (targetColor != null) {
                // Formato nativo de Obsidian: {a, rgb} — igual que renderer.colors.*
                // La geometría y el tamaño NO se tocan: el renderer tintea el círculo base.
                if (!node.color || node.color.rgb !== targetColor) {
                    node.color = { a: 1, rgb: targetColor };
                }
            } else if (node.color != null) {
                node.color = null;
            }
        }

        this.applyLinkColors(r);
    }

    // Los links NO tienen slot nativo de color: su render() fuerza line.tint = colors.line
    // con un lerp (vQ) cada frame, así que tintear directo no persiste. Parcheamos el
    // prototipo de la clase link para escribir DESPUÉS del render nativo — nuestro tint
    // gana cada frame sin pelear con el lerp ni tocar geometría. El wrapper es stateless
    // (solo lee link.$ctColor), por lo que sobrevive rebuilds y hot-reloads sin zombies.
    private patchLinkRender(r: any): void {
        const sample = r.links?.[0];
        if (!sample) return;
        const proto = Object.getPrototypeOf(sample);
        if (proto._ctOrigRender) return;
        const orig = proto.render;
        proto._ctOrigRender = orig;
        proto.render = function () {
            orig.call(this);
            const c = this.$ctColor;
            if (c != null && this.line) {
                this.line.tint = c;
                if (this.arrow) this.arrow.tint = c;
            }
        };
    }

    private applyLinkColors(r: any): void {
        if (!r?.links) return;
        this.patchLinkRender(r);
        for (const link of r.links) {
            const sc = link.source?.color;
            const tc = link.target?.color;
            if (sc && tc) {
                // Dorada si toca el nodo current; hereda el color si ambos endpoints
                // coinciden (cyan-cyan, verde de path, etc.); cyan neutro si son mixtos.
                if (sc.rgb === 0xFFD700 || tc.rgb === 0xFFD700) link.$ctColor = 0xFFD700;
                else if (sc.rgb === tc.rgb) link.$ctColor = sc.rgb;
                else link.$ctColor = 0x4FC3F7;
            } else if (link.$ctColor != null) {
                link.$ctColor = null;
            }
        }
    }
}
