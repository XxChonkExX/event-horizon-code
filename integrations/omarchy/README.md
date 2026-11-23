# Omarchy shell plugin for Event Horizon Code

Desktop-shell integration (bar widget + panel) driven by EHC's local runtime
API. The plugin never talks to a model itself; it reads sessions, approvals,
runs and the global pause state from the runtime on 127.0.0.1.

## Layout

```
integrations/omarchy/eventhorizon.sessions/
├── manifest.json     # plugin contract (id, kinds, entry points)
├── BarWidget.qml     # bar indicator: running / paused agents, approval count
├── Panel.qml         # session list + approvals + global pause toggle
├── poll.py           # one-shot runtime poller (bar widget data source)
└── README.md         # plugin notes
```

## Contract (verified against http.ts, runtime 0.0.3)

| Endpoint | Shape | Use |
|---|---|---|
| `GET /api/sessions` | `{sessions:[{id,title,...}]}` | panel session list |
| `GET /api/approvals` | `{approvals:[{kind,runId,sop,node,command}]}` | what is waiting on a human (SOP gates / script pauses) |
| `GET /api/runs` | `[{id,status,...}]` | bar widget active-run count |
| `GET /api/capabilities` | capability snapshot | panel banner |
| `GET/POST /api/runtime/pause` | `{paused:bool}` | global pause toggle (POST) |

Auth: HTTP Basic, user `eventhorizon`. Port + per-launch password are read from
`~/.eventhorizon/runtime.json` (0600, same user) by `poll.py` / `Panel.qml`.
Unreachable runtime or unreadable file -> the widget shows "EHC · offline" and
the panel states why. It never guesses a state.

Security posture: the plugin only ever talks to 127.0.0.1, only ever reads the
operator's own runtime descriptor, and its only write is the global pause
toggle — the operator's hand on the switch, not an agent capability.

## Implementation notes

- `poll.py` (stdlib only) does one runtime sweep per invocation and prints a
  single JSON line; the QML timer invokes it every 5s via Quickshell `Process`.
  Keeping the HTTP/parse logic in Python keeps the QML dumb and testable
  (`python3 poll.py ~/.eventhorizon/runtime.json` is the whole test).
- `Panel.qml` uses `curl` one-shots for reads and the pause POST (curl is
  omnipresent on Omarchy; XHR inside Quickshell is less predictable).
- Both QML files handle a dead runtime as a first-class state (offline label),
  matching EHC's stated-plainly rule.

## Status & publishing

Validated against the live runtime API on the Strix Linux box (poll.py output
matches the endpoint shapes above; endpoint routes verified in `http.ts`).
QML layout/styling is scaffold-grade until tested on a real Omarchy/Quattro
desktop (Quickshell + Wayland). Before marketplace submission per
https://plugins.omarchy.org/publish.html: `omarchy plugin validate <dir>` +
`qmllint`, namespaced id `xchonkex.eventhorizon`, then re-validate after every
EHC runtime API change.
