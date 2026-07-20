// event_reader.ts — Lee event_log.jsonl con fs.watch + polling fallback
import * as fs from "fs";
import * as path from "path";

export interface TraceEvent {
    type: "tool" | "command";
    session: string;
    ts: string;
    tool?: string;
    params?: Record<string, any>;
    exit_code?: number;
    duration_ms?: number;
    result_nodes?: string[];  // paths del subgrafo resultado (traverse/search)
    // command fields
    action?: string;
    nodes?: string[];
    tag?: string;
    color?: string;
    session_id?: string;
}

export type EventCallback = (events: TraceEvent[]) => void;

export class EventReader {
    private filePath: string;
    private lastSize = 0;
    private partialLine = "";
    private watcher: fs.FSWatcher | null = null;
    private listeners: EventCallback[] = [];
    private pollInterval: ReturnType<typeof setInterval> | null = null;

    constructor(vaultPath: string) {
        this.filePath = path.join(
            vaultPath, ".obsidian", "plugins", "cognitive-trace", "event_log.jsonl"
        );
        if (fs.existsSync(this.filePath)) {
            this.lastSize = fs.statSync(this.filePath).size;
        }
    }

    onEvents(cb: EventCallback): void {
        this.listeners.push(cb);
    }

    /** Leer los últimos eventos históricos del JSONL (para carga inicial). */
    readAll(maxEvents = Infinity): TraceEvent[] {
        if (!fs.existsSync(this.filePath)) return [];
        const content = fs.readFileSync(this.filePath, "utf-8");
        this.lastSize = fs.statSync(this.filePath).size;
        const events: TraceEvent[] = [];
        const lines = content.split("\n");
        for (let i = lines.length - 1; i >= 0 && events.length < maxEvents; i--) {
            const line = lines[i];
            if (!line.trim()) continue;
            try { events.unshift(JSON.parse(line)); } catch { /* línea malformada */ }
        }
        return events;
    }

    start(): void {
        // Intentar fs.watch
        try {
            this.watcher = fs.watch(this.filePath, (eventType) => {
                if (eventType === "change") {
                    this.poll();
                }
            });
        } catch {
            // fs.watch no disponible — solo polling
        }

        // Polling fallback cada 500ms
        this.pollInterval = setInterval(() => this.poll(), 500);
    }

    stop(): void {
        if (this.watcher) { this.watcher.close(); this.watcher = null; }
        if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
    }

    private poll(): void {
        if (!fs.existsSync(this.filePath)) return;

        const currentSize = fs.statSync(this.filePath).size;
        // Una rotación/truncamiento invalida el offset anterior.
        if (currentSize < this.lastSize) {
            this.lastSize = 0;
            this.partialLine = "";
        }
        if (currentSize === this.lastSize && !this.partialLine) return;

        const fd = fs.openSync(this.filePath, "r");
        const buf = Buffer.alloc(currentSize - this.lastSize);
        if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, this.lastSize);
        fs.closeSync(fd);
        this.lastSize = currentSize;

        const content = this.partialLine + buf.toString("utf-8");
        const hasFinalNewline = content.endsWith("\n");
        const lines = content.split("\n");
        this.partialLine = hasFinalNewline ? "" : (lines.pop() || "");
        const events: TraceEvent[] = [];

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                events.push(JSON.parse(line));
            } catch {
                // línea malformada, ignorar
            }
        }

        if (events.length > 0) {
            for (const cb of this.listeners) cb(events);
        }
    }
}
