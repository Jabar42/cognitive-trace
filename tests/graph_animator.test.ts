import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";
import { GraphAnimator } from "../graph_animator";

class FakeAudioParam {
    setValueAtTime = vi.fn();
    exponentialRampToValueAtTime = vi.fn();
}

class FakeOscillator {
    frequency = new FakeAudioParam();
    type = "sine";
    onended: (() => void) | null = null;
    connect = vi.fn(() => this);
    start = vi.fn();
    stop = vi.fn();
    disconnect = vi.fn();
}

class FakeGain {
    gain = new FakeAudioParam();
    connect = vi.fn(() => this);
    disconnect = vi.fn();
}

class FakeAudioContext {
    static instances: FakeAudioContext[] = [];
    state: AudioContextState = "suspended";
    currentTime = 10;
    oscillators: FakeOscillator[] = [];
    resumeCalls = 0;
    private resolveResume: (() => void) | null = null;

    constructor() { FakeAudioContext.instances.push(this); }
    resume(): Promise<void> {
        this.resumeCalls++;
        return new Promise((resolve) => { this.resolveResume = () => { this.state = "running"; resolve(); }; });
    }
    finishResume(): void { this.resolveResume?.(); }
    createOscillator(): FakeOscillator {
        const oscillator = new FakeOscillator();
        this.oscillators.push(oscillator);
        return oscillator;
    }
    createGain(): FakeGain { return new FakeGain(); }
    destination = {};
}

class FakeGraphics {
    destroyed = false;
    eventMode = "none";
    zIndex = 0;
    scale = { x: 1, y: 1 };
    clear = vi.fn();
    beginFill = vi.fn();
    drawCircle = vi.fn();
    endFill = vi.fn();
    lineStyle = vi.fn();
}

class FakeLink {
    line = { width: 10, tint: 0 };
    arrow = { tint: 0, alpha: 1 };
    px = { zIndex: 0 };
    renderer = { changed: vi.fn(), hanger: { sortChildren: vi.fn() } };
    $ctColor = 0xff00ff;

    render(): void { this.line.width = 10; }
}

function makeRenderer(paths: string[]) {
    const nodes = paths.map((id) => ({
        id,
        color: null as { a: number; rgb: number } | null,
        circle: new FakeGraphics(),
        x: 0,
        y: 0,
        getSize: () => 100,
    }));
    return {
        nodes,
        links: [],
        hanger: { addChild: vi.fn(), sortChildren: vi.fn() },
        nodeScale: 1,
        scale: 1,
        changed: vi.fn(),
        setData: vi.fn(),
    };
}

function makeEvent(result_nodes: string[]) {
    return {
        type: "tool" as const,
        session: "test",
        ts: "2026-07-19T04:00:00.000Z",
        tool: "okf_search",
        result_nodes,
    };
}

function makeCreateEvent(created_path: string) {
    return {
        type: "tool" as const,
        session: "test",
        ts: "2026-07-19T04:00:00.000Z",
        tool: "okf_new",
        params: { created_path },
        exit_code: 0,
    };
}

describe("GraphAnimator replay audio sync", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(performance, "now").mockReturnValue(1000);
        vi.stubGlobal("AudioContext", FakeAudioContext);
        vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
        vi.stubGlobal("window", globalThis);
        FakeAudioContext.instances = [];
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("espera a resume antes de emitir el primer beep", async () => {
        const renderer = makeRenderer(["Notes/alpha.md"]);
        const app = { workspace: { on: vi.fn(), getLeavesOfType: vi.fn(() => [{ view: { renderer } }]) } } as any;
        const animator = new GraphAnimator(app, { ...DEFAULT_SETTINGS, revealStagger: 0 });

        const replay = animator.replayPrompt([makeEvent(["Notes/alpha.md"])]);
        await Promise.resolve();

        const audio = FakeAudioContext.instances[0];
        expect(audio.resumeCalls).toBe(1);
        expect(audio.oscillators).toHaveLength(0);

        audio.finishResume();
        await replay;

        expect(audio.oscillators).toHaveLength(2);
        expect(audio.oscillators[0].start).toHaveBeenCalledWith(10.04);
        expect((animator as any).pulses[0].start).toBe(1040);
    });

    it("emite exactamente un beep por cada nodo revelado", async () => {
        const renderer = makeRenderer(["Notes/alpha.md", "Notes/beta.md"]);
        const app = { workspace: { on: vi.fn(), getLeavesOfType: vi.fn(() => [{ view: { renderer } }]) } } as any;
        const animator = new GraphAnimator(app, { ...DEFAULT_SETTINGS, revealStagger: 0 });
        const replay = animator.replayPrompt([makeEvent(["Notes/alpha.md", "Notes/beta.md"])]);
        const audio = FakeAudioContext.instances[0];
        audio.finishResume();
        await replay;

        expect(audio.oscillators).toHaveLength(4);
        expect((animator as any).pulses).toHaveLength(2);
        expect((animator as any).pulses.map((p: any) => p.start)).toEqual([1040, 1040]);
    });

    it("no confunde un tag con otro que solo comparte su prefijo", async () => {
        const renderer = makeRenderer(["#agente", "#agentes"]);
        const app = { workspace: { on: vi.fn(), getLeavesOfType: vi.fn(() => [{ view: { renderer } }]) } } as any;
        const animator = new GraphAnimator(app, { ...DEFAULT_SETTINGS, revealStagger: 0 });
        const replay = animator.replayPrompt([makeEvent(["#agente"])]);
        const audio = FakeAudioContext.instances[0];
        audio.finishResume();
        await replay;

        expect(audio.oscillators).toHaveLength(2);
        expect((animator as any).pulses).toHaveLength(1);
        expect(renderer.nodes[0].color).not.toBeNull();
        expect(renderer.nodes[1].color).toBeNull();
    });

    it("representa okf_new con su pipe create", async () => {
        const renderer = makeRenderer(["insights/nuevo-insight.md"]);
        const app = { workspace: { on: vi.fn(), getLeavesOfType: vi.fn(() => [{ view: { renderer } }]) } } as any;
        const animator = new GraphAnimator(app, { ...DEFAULT_SETTINGS, revealStagger: 0 });
        const replay = animator.replayPrompt([makeCreateEvent("insights/nuevo-insight.md")]);
        const audio = FakeAudioContext.instances[0];
        audio.finishResume();
        await replay;

        expect(audio.oscillators).toHaveLength(2);
        expect(renderer.nodes[0].color?.rgb).toBe(0xFF4FD8);
        expect((animator as any).nodePipes.get("insights/nuevo-insight.md")).toBe("create");
        expect((animator as any).pulses).toHaveLength(1);
    });

    it("emite beep para un evento realtime sin replay activo", () => {
        const renderer = makeRenderer(["Notes/live.md"]);
        const app = { workspace: { on: vi.fn(), getLeavesOfType: vi.fn(() => [{ view: { renderer } }]) } } as any;
        const animator = new GraphAnimator(app, { ...DEFAULT_SETTINGS, revealStagger: 0 });
        const audio = new FakeAudioContext();
        audio.state = "running";
        (animator as any).audioCtx = audio;

        animator.processEvents([{
            type: "tool",
            session: "live",
            ts: "2026-07-19T04:00:00.000Z",
            tool: "okf_traverse",
            params: { slug: "Notes/live" },
            exit_code: 0,
        }]);

        expect(audio.oscillators).toHaveLength(2);
        expect((animator as any).replayActive).toBe(false);
        expect((animator as any).pulses).toHaveLength(1);
    });

    it("detiene los siguientes lotes de un replay", async () => {
        const renderer = makeRenderer(["Notes/alpha.md", "Notes/beta.md"]);
        const app = { workspace: { on: vi.fn(), getLeavesOfType: vi.fn(() => [{ view: { renderer } }]) } } as any;
        const animator = new GraphAnimator(app, { ...DEFAULT_SETTINGS, revealStagger: 0, replayBeeps: false });
        const replay = animator.replayPrompt([
            makeEvent(["Notes/alpha.md"]),
            { ...makeEvent(["Notes/beta.md"]), ts: "2026-07-19T04:00:03.000Z" },
        ]);
        await replay;

        expect(renderer.nodes[0].color).not.toBeNull();
        expect(renderer.nodes[1].color).toBeNull();

        animator.stopReplay();
        vi.advanceTimersByTime(1000);

        expect(renderer.nodes[1].color).toBeNull();
        expect((animator as any).replayActive).toBe(false);
    });

    it("limpia el grafo al cruzar 60s y conserva solo el último conjunto", () => {
        const renderer = makeRenderer(["Notes/old.md", "Notes/new.md"]);
        const app = { workspace: { on: vi.fn(), getLeavesOfType: vi.fn(() => [{ view: { renderer } }]) } } as any;
        const animator = new GraphAnimator(app, { ...DEFAULT_SETTINGS, revealStagger: 0 });

        animator.loadHistory([{
            type: "tool", session: "history", ts: "2026-07-19T04:00:00.000Z",
            tool: "okf_traverse", params: { slug: "Notes/old" }, exit_code: 0,
        }]);
        animator.processEvents([{
            type: "tool", session: "live", ts: "2026-07-19T04:02:00.000Z",
            tool: "okf_traverse", params: { slug: "Notes/new" }, exit_code: 0,
        }]);

        expect(renderer.nodes[0].color).toBeNull();
        expect(renderer.nodes[1].color).not.toBeNull();
    });

    it("reintenta la aparición de okf_new si el índice del grafo llega tarde", () => {
        const renderer = makeRenderer(["insights/delayed.md"]);
        const delayedNode = renderer.nodes[0];
        renderer.nodes = [];
        const app = { workspace: { on: vi.fn(), getLeavesOfType: vi.fn(() => [{ view: { renderer } }]) } } as any;
        const animator = new GraphAnimator(app, { ...DEFAULT_SETTINGS, revealStagger: 0 });
        const audio = new FakeAudioContext();
        audio.state = "running";
        (animator as any).audioCtx = audio;

        animator.processEvents([{
            type: "tool", session: "live", ts: "2026-07-19T04:00:00.000Z",
            tool: "okf_new", params: { created_path: "insights/delayed.md" }, exit_code: 0,
        }]);
        expect(audio.oscillators).toHaveLength(0);

        renderer.nodes = [delayedNode];
        animator.refresh();

        expect(audio.oscillators).toHaveLength(2);
        expect((animator as any).pulses).toHaveLength(1);
        expect(delayedNode.color).not.toBeNull();
    });

    it("no apaga la línea en el frame previo al inicio de la animación", () => {
        const link = new FakeLink();
        const renderer = { links: [link] };
        const app = { workspace: { on: vi.fn(), getLeavesOfType: vi.fn(() => []) } } as any;
        const animator = new GraphAnimator(app, { ...DEFAULT_SETTINGS });
        (animator as any).patchLinkRender(renderer);
        link.$ctAnimStart = 1016;
        link.$ctAnimBaseWidth = 10;

        link.render();
        expect(link.line.width).toBe(10);

        vi.mocked(performance.now).mockReturnValue(1250);
        link.$ctAnimStart = 1000;
        link.render();
        expect(link.line.width).toBe(7.5);
    });
});
