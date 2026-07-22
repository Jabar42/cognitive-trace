import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";
import { TimelineView } from "../timeline_view";
import type { TraceEvent } from "../event_reader";

class FakeClassList {
    private values = new Set<string>();

    add(...names: string[]): void { names.forEach((name) => this.values.add(name)); }
    remove(...names: string[]): void { names.forEach((name) => this.values.delete(name)); }
    contains(name: string): boolean { return this.values.has(name); }
    toggle(name: string, force?: boolean): void {
        const shouldAdd = force ?? !this.values.has(name);
        if (shouldAdd) this.values.add(name);
        else this.values.delete(name);
    }
}

class FakeElement {
    children: FakeElement[] = [];
    parent: FakeElement | null = null;
    classList = new FakeClassList();
    style = { setProperty: vi.fn() };
    textContent = "";
    title = "";
    private listeners = new Map<string, (event: any) => void>();

    createEl(_tag: string, options: { cls?: string; text?: string } = {}): FakeElement {
        const child = new FakeElement();
        if (options.cls) child.classList.add(...options.cls.split(" ").filter(Boolean));
        if (options.text) child.textContent = options.text;
        child.parent = this;
        this.children.push(child);
        return child;
    }

    addClass(name: string): void { this.classList.add(name); }
    empty(): void { this.children = []; }
    setText(text: string): void { this.textContent = text; }
    setAttribute(_name: string, _value: string): void {}
    addEventListener(name: string, listener: (event: any) => void): void { this.listeners.set(name, listener); }
    click(): void { this.listeners.get("click")?.({ stopPropagation: vi.fn() }); }
    remove(): void {
        if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    }

    querySelector(selector: string): FakeElement | null {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector: string): FakeElement[] {
        const matches: FakeElement[] = [];
        const visit = (element: FakeElement) => {
            if (selector.split(".").filter(Boolean).every((name) => element.classList.contains(name))) {
                matches.push(element);
            }
            element.children.forEach(visit);
        };
        this.children.forEach(visit);
        return matches;
    }
}

function makeRoot(): FakeElement {
    const root = new FakeElement();
    root.children = [new FakeElement(), new FakeElement()];
    root.children.forEach((child) => { child.parent = root; });
    return root;
}

function makeEvent(tool: TraceEvent["tool"], ts: string, extra: Partial<TraceEvent> = {}): TraceEvent {
    return { type: "tool", session: "test", ts, tool, ...extra };
}

function makeView(events: TraceEvent[], callbacks: Record<string, ReturnType<typeof vi.fn>> = {}) {
    const root = makeRoot();
    const view = new TimelineView(
        { containerEl: root } as any,
        events,
        { ...DEFAULT_SETTINGS },
        callbacks.filter,
        callbacks.activate,
        callbacks.stop,
        callbacks.pause,
    );
    return { root, view };
}

describe("TimelineView", () => {
    beforeEach(() => {
        vi.stubGlobal("window", { setTimeout, clearTimeout });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("agrupa eventos en prompts separados por gaps de más de 60 segundos", async () => {
        const events = [
            makeEvent("okf_traverse", "2026-07-19T04:00:00.000Z", { params: { slug: "Notes/a" } }),
            makeEvent("okf_read", "2026-07-19T04:00:01.000Z", { params: { slug: "Notes/a" } }),
            makeEvent("okf_search", "2026-07-19T04:02:00.000Z", { result_nodes: ["Notes/b.md"] }),
        ];
        const { root, view } = makeView(events);

        await view.onOpen();

        expect(root.querySelectorAll(".trace-prompt-header")).toHaveLength(2);
        expect(root.querySelectorAll(".trace-event")).toHaveLength(3);
    });

    it("aplica filtros y notifica al grafo", async () => {
        const onFilterChange = vi.fn();
        const events = [
            makeEvent("okf_traverse", "2026-07-19T04:00:00.000Z", { params: { slug: "Notes/a" } }),
            makeEvent("okf_read", "2026-07-19T04:00:01.000Z", { params: { slug: "Notes/a" } }),
        ];
        const { root, view } = makeView(events, { filter: onFilterChange });

        await view.onOpen();
        root.querySelectorAll(".trace-filter-chip")[0].click();

        expect(onFilterChange).toHaveBeenCalledOnce();
        expect(root.querySelectorAll(".trace-event")).toHaveLength(1);
    });

    it("expone progreso y controles de pausa y detención del replay", async () => {
        const onActivate = vi.fn();
        const onStop = vi.fn();
        const onPause = vi.fn();
        const events = [makeEvent("okf_traverse", "2026-07-19T04:00:00.000Z", { params: { slug: "Notes/a" } })];
        const { root, view } = makeView(events, {
            activate: onActivate,
            stop: onStop,
            pause: onPause,
        });

        await view.onOpen();
        const play = root.querySelectorAll(".trace-prompt-play")[0];
        play.click();

        expect(onActivate).toHaveBeenCalledOnce();
        expect(root.querySelector(".trace-prompt-progress")?.textContent).toBe("0/1");
        expect(root.querySelectorAll(".trace-prompt-stop-hidden")).toHaveLength(0);

        onActivate.mock.calls[0][2](1, 1);
        expect(root.querySelector(".trace-prompt-progress")?.textContent).toBe("1/1");

        play.click();
        expect(onPause).toHaveBeenCalledOnce();
        expect(play.textContent).toBe("▶");

        root.querySelectorAll(".trace-prompt-stop")[0].click();
        expect(onStop).toHaveBeenCalledOnce();
        expect(root.querySelectorAll(".trace-prompt-stop-hidden")).toHaveLength(2); // stop + skip
    });
});
