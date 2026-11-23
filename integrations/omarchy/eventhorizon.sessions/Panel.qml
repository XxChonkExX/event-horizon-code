import QtQuick
import QtQuick.Controls
import Quickshell.Io

// Event Horizon Code - Omarchy panel: sessions, pending approvals, pause.
// Read-only views over the local runtime API; the only write is the global
// pause toggle (POST /api/runtime/pause), which is the operator's hand on the
// switch, not an agent capability. Scaffold: validated against the runtime API
// shapes (http.ts) but styling/layout awaits a real Omarchy/Quattro desktop.
Rectangle {
    id: root

    color: "#0b0b10"
    width: 420
    height: 560

    property bool paused: false
    property var sessions: []     // [{id,title,messages?}]
    property var approvals: []    // [{kind,runId,sop,node,command}]
    property string note: ""

    Column {
        anchors.fill: parent
        anchors.margins: 12
        spacing: 8

        Row {
            width: parent.width
            Text { text: "Event Horizon"; color: "#22d3ee"; font.pixelSize: 16; font.bold: true }
            Item { width: parent.width - 260; height: 1 }
            Button {
                text: root.paused ? "▶ resume" : "⏸ pause"
                onClicked: pauseProc.command = [
                    "curl", "-sf", "-m", "3",
                    "-u", "eventhorizon:" + auth.password,
                    "-X", "POST",
                    "-H", "content-type: application/json",
                    "-d", JSON.stringify({ paused: !root.paused }),
                    "http://127.0.0.1:" + auth.port + "/api/runtime/pause"
                ]
            }
        }

        Text { text: root.note; color: "#8f8f9c"; font.pixelSize: 11; visible: root.note !== "" }

        Text { text: "Approvals"; color: "#fbbf24"; font.pixelSize: 12 }
        Repeater {
            model: root.approvals.length
            Text {
                property var a: root.approvals[index]
                width: parent.width
                text: a ? `⏳ ${a.sop} · ${a.node} (${a.kind})` : ""
                color: "#d6d6de"
                font.pixelSize: 12
            }
        }
        Text { text: root.approvals.length ? "" : "nothing waiting on you"; color: "#8f8f9c"; font.pixelSize: 11 }

        Text { text: "Sessions"; color: "#22d3ee"; font.pixelSize: 12 }
        Repeater {
            model: root.sessions.length
            Text {
                property var s: root.sessions[index]
                width: parent.width
                text: s ? (s.title || s.id) : ""
                color: "#d6d6de"
                elide: Text.ElideRight
                font.pixelSize: 12
            }
        }
    }

    // runtime.json: port + per-launch password (0600, same user only).
    FileView {
        id: auth
        path: Quickshell.env("HOME") + "/.eventhorizon/runtime.json"
        property string port: ""
        property string password: ""
        onLoaded: {
            try {
                const d = JSON.parse(text());
                port = String(d.port ?? "");
                password = String(d.password ?? "");
                refreshTimer.restart();
            } catch { root.note = "runtime.json unreadable"; }
        }
    }

    Process {
        id: fetcher
        property string path: "/api/sessions"
        property var onDone: null
        command: ["curl", "-sf", "-m", "3",
                  "-u", "eventhorizon:" + auth.password,
                  "http://127.0.0.1:" + auth.port + path]
        stdout: StdioCollector {
            onStreamFinished: {
                if (!fetcher.onDone) return;
                try { fetcher.onDone(JSON.parse(this.text)); }
                catch { root.note = "runtime offline"; }
                fetcher.onDone = null;
            }
        }
    }

    Process {
        id: pauseProc
        stdout: StdioCollector {
            onStreamFinished: { refreshTimer.restart(); }
        }
    }

    function refresh() {
        if (!auth.port || !auth.password) return;
        fetcher.path = "/api/sessions";
        fetcher.onDone = (d) => { root.sessions = d.sessions ?? d ?? []; };
        fetcher.running = true;
        fetcher.path = "/api/approvals";
        fetcher.onDone = (d) => { root.approvals = d.approvals ?? []; };
        fetcher.running = true;
        fetcher.path = "/api/runtime/pause";
        fetcher.onDone = (d) => { root.paused = d.paused === true; };
        fetcher.running = true;
    }

    Timer {
        id: refreshTimer
        interval: 10000
        repeat: true
        running: true
        triggeredOnStart: false
        onTriggered: root.refresh()
    }
}
