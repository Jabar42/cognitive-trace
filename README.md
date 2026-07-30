# Cognitive Trace

Obsidian plugin that animates the native graph in real time as an AI agent navigates your OKF vault. Nodes light up, connections trace step by step.

## What it does

Cognitive Trace reads `event_log.jsonl` — a stream of events emitted by the [OKF MCP Server](https://github.com/Jabar42/mcp-okf) — and visualizes them directly in Obsidian's graph view:

- **Nodes light up** when the agent traverses, reads, or creates concepts
- **Edges pulse** when connections are discovered
- **Timeline view** shows a chronological, filterable event history grouped by prompt
- **Replay mode** animates past sessions step by step with configurable speed
- **Commands** let external agents highlight nodes, focus clusters, or reset the graph

## How it works

```
OKF MCP Server                 Cognitive Trace
     │                              │
     ├─ okf_traverse ──────────────►│ node colored visited
     ├─ okf_read ──────────────────►│ node colored read
     ├─ okf_search ────────────────►│ result nodes pulse
     ├─ okf_new ───────────────────►│ new node appears
     └─ graph_command ─────────────►│ highlight / focus / path
```

The MCP server writes JSONL events to `.obsidian/plugins/cognitive-trace/event_log.jsonl`. Cognitive Trace watches that file and updates the graph in real time.

## Requirements

- Obsidian >= 1.5.0
- [OKF MCP Server](https://github.com/Jabar42/mcp-okf) (emits the events)
- Desktop only (uses Obsidian's graph renderer internals)

## Installation

### From source

```bash
cd /path/to/your-vault/.obsidian/plugins
git clone https://github.com/Jabar42/cognitive-trace.git
cd cognitive-trace
npm install
npm run build
```

Then enable the plugin in Obsidian: Settings → Community plugins → Cognitive Trace.

### Via Obsidian Community Plugins

(Coming soon)

## Usage

1. Make sure the OKF MCP Server is running and `features.cognitive_trace: true` in your `.okf.config.yaml`
2. Open Obsidian's graph view
3. Open the Cognitive Trace panel (Command Palette → "Cognitive Trace: Open timeline")
4. Use your AI agent — watch the graph animate

### Timeline filters

Click the filter chips to show/hide event types:

- **Navigation** (okf_traverse)
- **Reads** (okf_read)
- **Searches** (okf_search, okf_graph, okf_health, okf_index, okf_touch)
- **Creations** (okf_new)
- **Commands** (highlight, focus, path)

### Replay

Click the ▶ button on any prompt group to replay that session in the graph. Adjust speed with the ⏩ button.

## Configuration

All settings are in the plugin settings tab in Obsidian:

- **Colors**: node and edge colors per event type
- **Pulse**: enable/disable pulse animations
- **Replay speed**: animation playback speed
- **Reveal stagger**: delay between nodes appearing (ms)
- **Beeps**: audio feedback for events
- **Edge coloring**: color edges by relationship type

## Structure

```
.
├── main.ts              # Plugin entry point
├── event_reader.ts      # Watches event_log.jsonl
├── graph_animator.ts    # Patches Obsidian's graph renderer
├── timeline_view.ts     # Timeline panel UI
├── settings.ts          # Plugin settings
├── tests/               # Vitest test suite
│   ├── event_reader.test.ts
│   ├── graph_animator.test.ts
│   └── obsidian-mock.ts
├── styles.css           # Timeline styles
├── manifest.json        # Obsidian plugin manifest
└── esbuild.config.mjs   # Build config
```

## Development

```bash
npm install       # Install dependencies
npm run dev       # Watch build
npm run build     # Production build (strict type checking + bundle)
npm test          # Run Vitest suite
```

## License

MIT — [Tp3studio](https://tp3studio.com)
