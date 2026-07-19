// main.ts — Entry point del plugin Cognitive Trace
import { Plugin, Notice } from "obsidian";
import { EventReader, TraceEvent } from "./event_reader";
import { GraphAnimator } from "./graph_animator";
import { TimelineView, TIMELINE_VIEW_TYPE } from "./timeline_view";
import { CTSettings, DEFAULT_SETTINGS, CTSettingTab } from "./settings";

export default class CognitiveTracePlugin extends Plugin {
    private reader: EventReader | null = null;
    private animator: GraphAnimator | null = null;
    private eventsBuffer: TraceEvent[] = [];  // compartido con TimelineView
    settings: CTSettings = { ...DEFAULT_SETTINGS };

    async onload(): Promise<void> {
        console.log("[CognitiveTrace] onload — starting plugin");

        // Cargar settings ANTES de crear el animator (comparte la referencia viva)
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        // Obtener ruta del vault (múltiples fallbacks por compatibilidad)
        let vaultPath = "";
        try {
            const adapter = this.app.vault.adapter as any;
            vaultPath = adapter.getBasePath?.()
                || adapter.basePath
                || "";
        } catch (e) {
            console.error("[CognitiveTrace] Failed to get vault path:", e);
        }

        console.log("[CognitiveTrace] vaultPath:", vaultPath);
        if (!vaultPath) {
            console.error("[CognitiveTrace] Could not determine vault path. Plugin disabled.");
            new Notice("Cognitive Trace: Could not determine vault path");
            return;
        }

        // Inicializar componentes
        try {
            this.reader = new EventReader(vaultPath);
            this.animator = new GraphAnimator(this.app, this.settings);
            console.log("[CognitiveTrace] EventReader and GraphAnimator initialized");
        } catch (e) {
            console.error("[CognitiveTrace] Failed to init components:", e);
            return;
        }

        // Conectar reader → animator + buffer + timeline
        this.reader.onEvents((events) => {
            console.log(`[CognitiveTrace] Received ${events.length} events`);
            // Buffer compartido: guardar siempre
            this.eventsBuffer.push(...events);
            // Mantener máximo 500 eventos en buffer
            if (this.eventsBuffer.length > 500) {
                this.eventsBuffer = this.eventsBuffer.slice(-500);
            }
            try {
                this.animator?.processEvents(events);
            } catch (e) {
                console.error("[CognitiveTrace] animator error:", e);
            }

            // Notificar al timeline si está abierto
            try {
                const leaves = this.app.workspace.getLeavesOfType(TIMELINE_VIEW_TYPE);
                for (const leaf of leaves) {
                    const view = leaf.view as TimelineView;
                    view.refresh(this.eventsBuffer);
                }
            } catch (e) {
                console.error("[CognitiveTrace] timeline update error:", e);
            }
        });

        // Cargar historial completo desde JSONL (sin esperar nuevos eventos)
        try {
            const history = this.reader.readAll();
            console.log(`[CognitiveTrace] Cargando ${history.length} eventos históricos...`);
            // Poblar el buffer compartido para que el timeline tenga datos
            this.eventsBuffer.push(...history);
            this.animator?.loadHistory(history);
            console.log("[CognitiveTrace] Historial cargado — grafo + buffer poblados.");
            // Si el timeline ya está abierto (restaurado por Obsidian), refrescarlo
            for (const leaf of this.app.workspace.getLeavesOfType(TIMELINE_VIEW_TYPE)) {
                try { (leaf.view as TimelineView).refresh(this.eventsBuffer); } catch (_) {}
            }
        } catch (e) {
            console.error("[CognitiveTrace] Error cargando historial:", e);
        }

        this.reader.start();
        console.log("[CognitiveTrace] EventReader started (fs.watch + polling 500ms)");

        // Registrar vista Timeline — comparte activePipes y callback de prompt con el animator
        this.registerView(
            TIMELINE_VIEW_TYPE,
            (leaf) => {
                const view = new TimelineView(leaf, this.eventsBuffer, () => {
                    this.animator?.refresh();
                }, (events: TraceEvent[]) => {
                    this.animator?.replayPrompt(events);
                });
                if (this.animator) this.animator.activePipes = view.activePipes;
                return view;
            }
        );

        // Comando: abrir/cerrar timeline
        this.addCommand({
            id: "open-timeline",
            name: "Open Cognitive Trace timeline",
            callback: () => this.activateTimeline(),
        });

        // Comando: toggle animación
        this.addCommand({
            id: "toggle-animation",
            name: "Toggle graph animation",
            callback: () => {
                this.animator?.toggle();
                const enabled = (this.animator as any)?.enabled ? "ON" : "OFF";
                console.log(`[CognitiveTrace] Animation ${enabled}`);
                new Notice(`Cognitive Trace: animation ${enabled}`);
            },
        });

        // Comando: reset
        this.addCommand({
            id: "reset-graph",
            name: "Reset graph to default state",
            callback: () => this.animator?.reset(),
        });

        // Panel de configuración
        this.addSettingTab(new CTSettingTab(this.app, this));

        // Ribbon icon
        this.addRibbonIcon("activity", "Cognitive Trace", () => {
            this.activateTimeline();
        });

        console.log("[CognitiveTrace] Plugin loaded successfully");
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
        // Re-aplicar en vivo: los colores/toggles se leen del objeto settings compartido
        this.animator?.refresh();
    }

    async onunload(): Promise<void> {
        console.log("[CognitiveTrace] Unloading plugin");
        this.reader?.stop();
        this.animator?.reset();
        this.app.workspace.detachLeavesOfType(TIMELINE_VIEW_TYPE);
    }

    async activateTimeline(): Promise<void> {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(TIMELINE_VIEW_TYPE)[0];
        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                await rightLeaf.setViewState({ type: TIMELINE_VIEW_TYPE, active: true });
                leaf = rightLeaf;
            }
        }
        if (leaf) workspace.revealLeaf(leaf);
    }
}
