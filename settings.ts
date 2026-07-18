// settings.ts — Configuración del plugin Cognitive Trace
import { App, PluginSettingTab, Setting } from "obsidian";
import type CognitiveTracePlugin from "./main";

export interface CTSettings {
    colorCurrent: string;   // nodo que el agente lee ahora
    colorVisited: string;   // nodos ya visitados
    colorPath: string;      // highlight_path
    colorCommand: string;   // default de highlight_nodes
    edgeColoring: boolean;  // colorear aristas entre nodos trazados
    pulseEnabled: boolean;  // onda expansiva al pintar
    pulseDuration: number;  // ms
}

export const DEFAULT_SETTINGS: CTSettings = {
    colorCurrent: "#FFD700",
    colorVisited: "#4FC3F7",
    colorPath: "#00FF00",
    colorCommand: "#FF6B35",
    edgeColoring: true,
    pulseEnabled: true,
    pulseDuration: 900,
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

        const color = (name: string, desc: string, key: "colorCurrent" | "colorVisited" | "colorPath" | "colorCommand") => {
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
        color("Nodo actual", "El nodo que el agente está leyendo ahora", "colorCurrent");
        color("Nodos visitados", "Nodos por los que el agente ya pasó", "colorVisited");
        color("Camino resaltado", "Nodos de highlight_path", "colorPath");
        color("Highlight de comandos", "Color default de highlight_nodes", "colorCommand");

        new Setting(containerEl).setName("Aristas").setHeading();
        new Setting(containerEl)
            .setName("Colorear aristas")
            .setDesc("Pinta las aristas entre nodos trazados, por encima de las líneas de tema")
            .addToggle(t => t
                .setValue(this.plugin.settings.edgeColoring)
                .onChange(async (v) => {
                    this.plugin.settings.edgeColoring = v;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName("Pulso").setHeading();
        new Setting(containerEl)
            .setName("Pulso al pintar")
            .setDesc("Onda expansiva cuando un nodo se pinta o pasa a ser el actual")
            .addToggle(t => t
                .setValue(this.plugin.settings.pulseEnabled)
                .onChange(async (v) => {
                    this.plugin.settings.pulseEnabled = v;
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
    }
}
