import QtQuick
import Quickshell.Io

// Event Horizon Code - Omarchy bar widget.
// State comes from the local runtime only (127.0.0.1, Basic auth read from
// ~/.eventhorizon/runtime.json by poll.py). No model calls, no network beyond
// loopback. On any failure it says "EHC offline" - never a guessed state.
Item {
    id: root

    property bool reachable: false
    property bool paused: false
    property int active: 0
    property int approvals: 0

    readonly property string label: !reachable
        ? "EHC · offline"
        : paused ? "EHC ⏸"
        : approvals > 0 ? "EHC ⏵ " + approvals + "⏳"
        : "EHC ⚡ " + active

    readonly property color tint: !reachable
        ? "#8f8f9c"
        : paused ? "#fbbf24"
        : approvals > 0 ? "#fbbf24"
        : "#22d3ee"

    Text {
        anchors.verticalCenter: parent.verticalCenter
        text: root.label
        color: root.tint
        font.pixelSize: 14
    }

    Process {
        id: poll
        command: ["python3", Qt.resolvedUrl("poll.py").toString().replace(/^file:\/\//, ""),
                  Quickshell.env("HOME") + "/.eventhorizon/runtime.json"]
        stdout: StdioCollector {
            onStreamFinished: {
                try {
                    const s = JSON.parse(this.text.trim());
                    root.reachable = s.reachable === true;
                    root.paused = s.paused === true;
                    root.active = s.active ?? 0;
                    root.approvals = s.approvals ?? 0;
                } catch {
                    root.reachable = false;
                }
            }
        }
    }

    Timer {
        interval: 5000
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: poll.running = true
    }
}
