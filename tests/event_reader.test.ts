import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { EventReader } from "../event_reader";

const tempDirs: string[] = [];

function makeEvent(tool: string) {
    return JSON.stringify({
        type: "tool",
        session: "test",
        ts: "2026-07-19T04:00:00.000Z",
        tool,
    });
}

function makeReader(initial = "") {
    const vault = mkdtempSync(join(tmpdir(), "cognitive-trace-test-"));
    tempDirs.push(vault);
    const dir = join(vault, ".obsidian", "plugins", "cognitive-trace");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "event_log.jsonl"), initial);
    return { reader: new EventReader(vault), path: join(dir, "event_log.jsonl") };
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("EventReader", () => {
    it("conserva una línea JSON parcialmente escrita hasta completarla", () => {
        const { reader, path } = makeReader();
        const received: unknown[] = [];
        reader.onEvents((events) => received.push(...events));
        const line = makeEvent("okf_traverse");
        const split = Math.floor(line.length / 2);

        appendFileSync(path, line.slice(0, split));
        (reader as any).poll();
        expect(received).toHaveLength(0);

        appendFileSync(path, line.slice(split) + "\n");
        (reader as any).poll();
        expect(received).toHaveLength(1);
    });

    it("reinicia el offset después de una truncación del JSONL", () => {
        const first = makeEvent("okf_traverse") + "\n";
        const { reader, path } = makeReader(first + " ".repeat(100));
        const received: any[] = [];
        reader.onEvents((events) => received.push(...events));

        writeFileSync(path, makeEvent("okf_new") + "\n");
        (reader as any).poll();

        expect(received).toHaveLength(1);
        expect(received[0].tool).toBe("okf_new");
    });

    it("puede cargar solo los eventos históricos más recientes", () => {
        const initial = ["okf_traverse", "okf_read", "okf_search"]
            .map(makeEvent)
            .join("\n") + "\n";
        const { reader } = makeReader(initial);

        expect(reader.readAll(2).map((event) => event.tool)).toEqual(["okf_read", "okf_search"]);
    });

    it("notifica líneas JSON malformadas sin notificar una línea parcial", () => {
        const { reader, path } = makeReader("{malformed}\n");
        const errors: string[] = [];
        reader.onError((message) => errors.push(message));

        expect(reader.readAll()).toEqual([]);
        expect(errors).toEqual(["Ignored 1 malformed event-log line"]);

        appendFileSync(path, "{partial");
        (reader as any).poll();
        expect(errors).toHaveLength(1);
    });
});
