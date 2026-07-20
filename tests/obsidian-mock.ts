export class App {}
export class PluginSettingTab {}
export class Setting {}
export class WorkspaceLeaf {}
export class ItemView {
    containerEl: any;

    constructor(leaf: any) {
        this.containerEl = leaf.containerEl;
    }
}
