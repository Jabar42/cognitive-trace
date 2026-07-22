// settings.ts — Configuración del plugin Cognitive Trace
import { App, PluginSettingTab, Setting } from "obsidian";
import type CognitiveTracePlugin from "./main";

export interface CTSettings {
    colorCurrent: string;   // último nodo consultado — foco actual del agente
    colorRead: string;      // nodos con body completo leído (okf_read)
    colorVisited: string;   // nodos cuya ficha apareció en resultados (traverse/search)
    colorPath: string;      // highlight_path
    colorCommand: string;   // default de highlight_nodes
    colorCreate: string;    // archivos creados vía okf_new
    edgeColoring: boolean;  // colorear aristas entre nodos iluminados
    pulseEnabled: boolean;  // onda expansiva al pintar
    pulseIndefinite: boolean; // el nodo actual pulsa en loop hasta que el agente avance
    pulseDuration: number;  // ms
    revealStagger: number;  // ms entre nodos al revelar resultados (0 = todos a la vez)
    replaySpeed: number;    // factor de velocidad del replay (0.25 — 5.0, default 1)
    replayBeeps: boolean;   // sonido al aparecer cada nodo en vivo o durante replay
}

export const DEFAULT_SETTINGS: CTSettings = {
    colorCurrent: "#FFD700",
    colorRead: "#B388FF",
    colorVisited: "#4FC3F7",
    colorPath: "#00FF00",
    colorCommand: "#FF6B35",
    colorCreate: "#FF4FD8",
    edgeColoring: true,
    pulseEnabled: true,
    pulseIndefinite: false,
    pulseDuration: 900,
    revealStagger: 80,
    replaySpeed: 1,
    replayBeeps: true,
};

export class CTSettingTab extends PluginSettingTab {
    plugin: CognitiveTracePlugin;

    constructor(app: App, plugin: CognitiveTracePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        const color = (name: string, desc: string, key: "colorCurrent" | "colorRead" | "colorVisited" | "colorPath" | "colorCommand" | "colorCreate") => {
            new Setting(containerEl)
                .setName(name)
                .setDesc(desc)
                .addColorPicker(cp => cp
                    .setValue(this.plugin.settings[key])
                    .onChange(async (v) => {
                        this.plugin.settings[key] = v;
                        await this.plugin.saveSettings();
                    }));
        };

        new Setting(containerEl).setName("Colores").setHeading();
        color("Nodo actual",
            "El último nodo que el agente consultó — su foco ahora mismo. Al avanzar, pasa al color de leído o visto según cómo lo consultó.",
            "colorCurrent");
        color("Nodos leídos",
            "El agente leyó el contenido completo con okf_read: el body del documento entró a su contexto. Es el mapa de su memoria de trabajo.",
            "colorRead");
        color("Nodos vistos",
            "El agente vio la ficha del nodo en un resultado de traverse/search — título, tipo, description y conexiones — pero no leyó su contenido.",
            "colorVisited");
        color("Camino resaltado",
            "Ruta entre nodos que el agente marcó explícitamente vía okf_graph_command highlight_path.",
            "colorPath");
        color("Highlight de comandos",
            "Color default cuando el agente resalta nodos vía okf_graph_command (highlight_nodes, most/least visited).",
            "colorCommand");
        color("Nodos creados",
            "Archivos nuevos creados por el agente mediante okf_new.",
            "colorCreate");

        new Setting(containerEl).setName("Aristas").setHeading();
        new Setting(containerEl)
            .setName("Colorear aristas")
            .setDesc("Colorea las aristas que conectan dos nodos iluminados — el camino que el agente recorrió — por encima de las líneas del tema.")
            .addToggle(t => t
                .setValue(this.plugin.settings.edgeColoring)
                .onChange(async (v) => {
                    this.plugin.settings.edgeColoring = v;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName("Pulso").setHeading();
        new Setting(containerEl)
            .setName("Pulso al pintar")
            .setDesc("Onda expansiva cuando un nodo se ilumina por primera vez o el agente vuelve a él.")
            .addToggle(t => t
                .setValue(this.plugin.settings.pulseEnabled)
                .onChange(async (v) => {
                    this.plugin.settings.pulseEnabled = v;
                    await this.plugin.saveSettings();
                }));
        new Setting(containerEl)
            .setName("Pulso indefinido en el nodo actual")
            .setDesc("El nodo actual emite ondas continuamente hasta que el agente pasa a otro nodo. Mantiene el render del grafo activo mientras esté encendido.")
            .addToggle(t => t
                .setValue(this.plugin.settings.pulseIndefinite)
                .onChange(async (v) => {
                    this.plugin.settings.pulseIndefinite = v;
                    await this.plugin.saveSettings();
                }));
        new Setting(containerEl)
            .setName("Duración del pulso")
            .setDesc("Milisegundos que dura la onda")
            .addSlider(s => s
                .setLimits(300, 2000, 100)
                .setValue(this.plugin.settings.pulseDuration)
                .setDynamicTooltip()
                .onChange(async (v) => {
                    this.plugin.settings.pulseDuration = v;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName("Replay").setHeading();
        new Setting(containerEl)
            .setName("Velocidad del replay")
            .setDesc("Factor de velocidad: 0.25 = lento, 5 = rápido. Afecta el delay entre batches de eventos durante la reproducción.")
            .addDropdown(d => d
                .addOptions({
                    "0.25": "0.25×",
                    "0.5": "0.5×",
                    "0.75": "0.75×",
                    "1": "1×",
                    "1.5": "1.5×",
                    "2": "2×",
                    "3": "3×",
                    "5": "5×",
                })
                .setValue(String(this.plugin.settings.replaySpeed))
                .onChange(async (v) => {
                    this.plugin.settings.replaySpeed = Number(v);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName("Sonido").setHeading();
        new Setting(containerEl)
            .setName("Beeps de aparición")
            .setDesc("Un ping al aparecer cada nodo en vivo o durante replay. Tono distinto por tipo: navegación (C6), lecturas (G5), búsquedas (D5), creaciones (E6), comandos (A4). Requiere una interacción inicial en Obsidian para desbloquear el audio.")
            .addToggle(t => t
                .setValue(this.plugin.settings.replayBeeps)
                .onChange(async (v) => {
                    this.plugin.settings.replayBeeps = v;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName("Revelado").setHeading();
        new Setting(containerEl)
            .setName("Cascada de resultados")
            .setDesc("Milisegundos entre nodo y nodo al iluminar el resultado de un traverse/search. Los nodos llegan en orden de profundidad, así que la onda se expande desde el nodo de entrada. 0 = todos a la vez.")
            .addSlider(s => s
                .setLimits(0, 300, 20)
                .setValue(this.plugin.settings.revealStagger)
                .setDynamicTooltip()
                .onChange(async (v) => {
                    this.plugin.settings.revealStagger = v;
                    await this.plugin.saveSettings();
                }));
    }
}
