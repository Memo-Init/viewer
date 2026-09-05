<!-- TODO on publication: swap the static badges for a live test-on-push.yml status badge + Codecov badge once the repo has a remote -->
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg) ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

# memo-init / viewer

The **memo-viewer** — a local live-preview server for memos, revisions and
transcripts, with Mermaid-SVG rendering and the deterministic `questions-json`
question format.

The viewer is a core-like building block of the memo-system: it renders the
strategy documents a memo produces so they can be read and reviewed while they
are written. It runs as a single local server on a fixed port (3333) and
auto-refreshes the browser as files change.

## Quickstart

Clone the repository, install dependencies, and start the server in server mode:

```bash
git clone https://github.com/memo-init/viewer.git
cd viewer
npm i
memo-view --server
```

The server listens on `http://localhost:3333`. Always use server mode on the
fixed port — do not pass a custom port. Add documents by pointing the CLI at a
file or directory:

```bash
memo-view .memo/004-example/revisions/
```

## Features

- **Multi-document live preview** — serves memos, revisions and transcripts
  from one local server on port 3333.
- **Mermaid-SVG rendering** — fenced `mermaid` blocks are rendered to SVG, not
  left as code.
- **Scientific diagrams (Vega-Lite)** — fenced `vega-lite` blocks render
  statistical charts (line, bar, boxplot, median layers) from an inline JSON
  spec. See [Scientific diagrams](#scientific-diagrams-vega-lite).
- **Deterministic question format** — the `questions-json` schema renders
  multiple-choice and single questions consistently across documents.
- **Auto-refresh** — a WebSocket channel pushes updates to the browser as files
  change, no manual reload.
- **Transcript support** — a transcript registry serves voice-memo transcripts
  alongside memos.
- **Answer channel (`wait_for_answer`)** — a waiting tool call returns the
  moment the user presses "Abschliessen", so the answer reaches the calling
  session without polling. See [Answer channel](#answer-channel-wait_for_answer).

## Table of Contents

- [memo-init / viewer](#memo-init--viewer)
  - [Quickstart](#quickstart)
  - [Features](#features)
  - [Scientific diagrams (Vega-Lite)](#scientific-diagrams-vega-lite)
  - [Answer channel (wait_for_answer)](#answer-channel-wait_for_answer)
  - [Methods](#methods)
    - [.start()](#start)
    - [.startDirectory()](#startdirectory)
  - [Contributing](#contributing)
  - [License](#license)

## Scientific diagrams (Vega-Lite)

To put a statistical chart in a memo, write a fenced `vega-lite` block whose body
is a [Vega-Lite](https://vega.github.io/vega-lite/) JSON spec. The viewer renders
it to an SVG inline (next to Mermaid), and a click opens the shared full-view
modal. No build step, no per-diagram source change — the renderer is a registry
entry, so the author only writes the spec.

**Security constraint (enforced):** a spec may only carry **inline** data
(`"data": { "values": [...] }`). Any remote reference — a `url` anywhere in the
spec — is rejected and shown as an error instead of being fetched. The renderer
runs Vega's CSP-safe AST interpreter (no `eval`), with the export menu disabled.

A simple line chart:

```vega-lite
{
  "data": { "values": [
    { "memo": "013", "score": 68 },
    { "memo": "014", "score": 82 },
    { "memo": "019", "score": 92 }
  ] },
  "mark": "line",
  "encoding": {
    "x": { "field": "memo", "type": "ordinal" },
    "y": { "field": "score", "type": "quantitative" }
  }
}
```

A bar chart:

```vega-lite
{
  "data": { "values": [
    { "phase": "P1", "prds": 1 },
    { "phase": "P2", "prds": 3 },
    { "phase": "P3", "prds": 1 }
  ] },
  "mark": "bar",
  "encoding": {
    "x": { "field": "phase", "type": "nominal" },
    "y": { "field": "prds", "type": "quantitative" }
  }
}
```

"Add a median line" — a layered spec where the statistical layer is written
directly into the spec (the viewer does not compute, it renders what you write):

```vega-lite
{
  "data": { "values": [
    { "memo": "013", "score": 68 },
    { "memo": "014", "score": 82 },
    { "memo": "017", "score": 88 },
    { "memo": "019", "score": 92 }
  ] },
  "layer": [
    { "mark": "point",
      "encoding": {
        "x": { "field": "memo", "type": "ordinal" },
        "y": { "field": "score", "type": "quantitative" }
      } },
    { "mark": { "type": "rule", "color": "firebrick" },
      "encoding": { "y": { "aggregate": "median", "field": "score", "type": "quantitative" } } }
  ]
}
```

## Answer channel (wait_for_answer)

The viewer exposes ONE tool endpoint, `POST /mcp`, on the server it already
runs — same process, same port 3333, same loopback bind. It offers a single
tool, `wait_for_answer`. A session calls it, the call waits, and it returns the
moment the user presses "Abschliessen" for that transcript.

**Read the disk after the wake — do not trust the delivery.** Every result
carries `evidencePath` pointing at the durable answer store, and the answers in
the result are re-read from that store after the wake. A missed message costs
speed, never the answer. This is not caution on principle: in the rollout of
2026-08-31/09-01, 75 agents worked cleanly, wrote their files and their return
text still mostly failed to arrive.

**Call it from the orchestrator session only.** A sub-agent gets no automatic
backgrounding, so the call would really block it.

### Registration

Put this in the project root as `.mcp.json`; the client asks once for approval:

```json
{
    "mcpServers": {
        "memo-view": {
            "type": "http",
            "url": "http://127.0.0.1:3333/mcp"
        }
    }
}
```

### Calling it

| Argument | Type | Description | Required |
|----------|------|-------------|----------|
| memo | string | memo number, e.g. `"080"` | Yes |
| transcriptId | string | the transcript to wait on | Yes |
| questionId | string | narrow the result to one question, e.g. `"F12"` | No |
| timeoutSeconds | integer | wait ceiling, default 3600, maximum 86400 | No |

The result is the same shape on both paths — `status`, `transcriptId`,
`answers[]`, `evidencePath`, `waitedMs`, `reason`. A timeout answers
`status: false`, `reason: "timeout"` and **still** carries `evidencePath`, so
the caller knows where to look instead of learning nothing.

### The four deadlines

| Deadline | Documented | What the endpoint does about it |
|----------|-----------|---------------------------------|
| auto-backgrounding above 2 min | client >= 2.1.212 | nothing — a client property; the endpoint neither needs nor influences it |
| HTTP idle deadline | 5 min | a progress message every 60 s while the call is open |
| overall wall clock | ~28 h default | never inherited: own ceiling, default 3600 s, maximum 86400 s |
| sub-agents | no auto-backgrounding | the tool text forbids the sub-agent call, with its reason |

`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` switches the auto-backgrounding off,
which makes a long call block the session. That is an operating limit of this
road, named here rather than worked around.

### Origin

The endpoint validates the `Origin` header and answers `403` for a foreign
**and** for an absent origin (DNS-rebinding guard). A rejection is logged as
`MCP-ORIGIN-403` with the origin it saw, so a first call that fails diagnoses
itself.

### Measuring it

```bash
MEMOVIEW_NO_BROWSER=1 node tests/manual/mcp-wait-for-answer-e2e.mjs
node scripts/firstflight-report.mjs --protocol tests/manual/test-results/firstflight-protocol.json
```

The harness flies 5 completion events over 2 concurrently waiting sessions, one
of them pressed only after more than 6 minutes. The report always states how
much it compared, and it keeps `diskCount` (durable store) and
`deliveredCount` (tool result) apart — `deliveredCount < diskCount` means the
delivery road is defective and the file road stays leading.

### Not chosen, with reasons

- **Elicitation, both modes** — the form mode puts the answer in the terminal
  and blocks the session; the URL mode needs a terminal confirmation per
  question. Both work against the purpose of this channel.
- **Sampling** — deprecated in the specification since 2026-07-28 and without
  client support. Doubly dead.
- **Channels** — a research preview behind an allow-list and an explicitly
  dangerous start flag. Documented as a successor option, not built.
- The existing **file road** (`/api/session/<id>/arm`, `/wake`, the wake flag)
  is untouched and stays the fallback.

## Methods

The `MemoView` class exposes static entry points for starting the preview
server. The CLI (`memo-view`) is a thin wrapper around them.

### `.start()`

Starts the preview server for a single Markdown file.

**Method**

```
MemoView.start( { filePath, port } )
```

| Key | Type | Description | Required |
|-----|------|-------------|----------|
| filePath | string | Path to the Markdown file to preview | Yes |
| port | number | Port to listen on (defaults to the fixed server port) | No |

**Example**

```javascript
import { MemoView } from './src/MemoView.mjs'

await MemoView.start( { filePath: '.memo/004-example/revisions/REV-01.md' } )
```

### `.startDirectory()`

Starts the preview server for a directory, auto-adding every Markdown file it
contains.

**Method**

```
MemoView.startDirectory( { dirPath, port } )
```

| Key | Type | Description | Required |
|-----|------|-------------|----------|
| dirPath | string | Path to the directory to serve | Yes |
| port | number | Port to listen on (defaults to the fixed server port) | No |

**Example**

```javascript
import { MemoView } from './src/MemoView.mjs'

await MemoView.startDirectory( { dirPath: '.memo/004-example/revisions/' } )
```

## Contributing

Contributions are welcome! Please open an issue first to discuss what you would
like to change.

## License

[MIT](LICENSE)
