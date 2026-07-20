# Cognitive Trace

## Commands

- Install dependencies with `npm install` when `node_modules` is absent; `package-lock.json` is the lockfile.
- Run `npm test` for the full Vitest suite. Run one focused file with `npx vitest run tests/event_reader.test.ts` or `npx vitest run tests/graph_animator.test.ts`.
- Run `npm run build` for the required verification: it runs strict TypeScript checking and then bundles `main.ts` with esbuild into `main.js`.
- Run `npm run dev` for the esbuild development watch build; it writes `main.js` with an inline source map.
- `main.js` and source maps are generated and ignored; do not edit them or use them as source.

## Structure

- `main.ts` is the Obsidian plugin entrypoint and wires the reader, graph animator, timeline view, commands, settings, and lifecycle cleanup.
- `event_reader.ts` watches `.obsidian/plugins/cognitive-trace/event_log.jsonl` inside the active vault, with 500 ms polling fallback and partial-JSON-line handling.
- `graph_animator.ts` patches Obsidian’s graph renderer to color nodes/links and animate pulses; it relies on Obsidian desktop internals and should be tested through its existing fakes rather than browser assumptions.
- `timeline_view.ts` renders and filters the event history, grouping prompts at gaps over 60 seconds; `settings.ts` defines persisted plugin settings and their UI.
- `tests/` uses Vitest’s Node environment and aliases the `obsidian` import to `tests/obsidian-mock.ts`; production TypeScript compilation includes only the plugin source files listed in `tsconfig.json`.

## Runtime Gotchas

- The plugin is desktop-only (`manifest.json`); it needs an Obsidian vault path and exits early if the adapter cannot provide one.
- `event_log.jsonl`, database files, and `data.json` are runtime/user data and are ignored. Do not commit them or use `data.json` as a source of defaults.
- Build output is CommonJS for the browser, targets ES2020, and keeps `obsidian`, `electron`, `fs`, and `path` external; preserve these esbuild boundaries when changing imports.
- Audio replay requires a real Obsidian pointer interaction to resume `AudioContext`; tests stub browser/audio globals and timers accordingly.
