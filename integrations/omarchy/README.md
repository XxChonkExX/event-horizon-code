# Omarchy shell plugin for Event Horizon Code

Desktop-shell integration (bar widget + session menu) driven by EHC's local
runtime API. The plugin never talks to a model itself; it reads sessions,
approvals and run state from the local runtime on 127.0.0.1.

## Contract (as of runtime 0.1.0)

| Endpoint | Use |
|---|---|
| `GET /api/sessions` | session list (titles, message counts) |
| `GET /api/approvals` | pending human decisions (SOP gates / script pauses) |
| `GET /api/capabilities` | what this install can actually do |
| `GET /api/runtime/pause` · `POST /api/runtime/pause` | global agent pause/resume |

Auth: HTTP Basic, user `eventhorizon`. The password is printed at app boot (or
`EH_PASS`). The plugin reads it once from the user's `~/.eventhorizon/runtime.json`
only if the file is readable; otherwise the widget shows "runtime not reachable"
and leaves auth to the user.

> This is a scaffold: layout and API calls are placeholders to be validated on
> a real Omarchy/Quattro install before publishing to the plugin marketplace.

## Layout

```
integrations/omarchy/eventhorizon.sessions/
├── manifest.json     # plugin contract (id, kind, entry points)
├── BarWidget.qml     # small bar indicator: running/paused agents
├── Panel.qml         # session list + approvals + pause toggle
└── README.md
```

## manifest.json

```json
{
  "schemaVersion": 1,
  "id": "xchonkex.eventhorizon",
  "name": "Event Horizon Sessions",
  "version": "0.1.0",
  "kinds": ["bar-widget"],
  "entryPoints": { "barWidget": "BarWidget.qml" }
}
```

## BarWidget.qml (skeleton)

```qml
import Quickshell
import QtQuick

Item {
  property bool paused: false
  property int active: 0

  // Poll the local runtime (127.0.0.1 only). Token/ticket exchange happens in
  // the app; the widget uses Basic auth against the runtime password file.
  Timer {
    interval: 5000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  function refresh() {
    // curl-style fetch via Quickshell's IShell; auth header from
    // ~/.eventhorizon/runtime.json. On failure show "ehc: offline".
  }

  Text {
    text: root.paused ? "EHC ⏸" : `EHC ⚡ ${root.active}`
    color: root.paused ? "#fbbf24" : "#22d3ee"
  }
}
```

## Publishing

Per https://plugins.omarchy.org/publish.html: validate the folder with
`omarchy plugin validate <dir>` + `qmllint`, keep the namespaced id, then submit
to the marketplace repo. Re-validate after every EHC runtime API change.
