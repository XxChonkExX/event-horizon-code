import Quickshell
import QtQuick

// Event Horizon Sessions - bar widget (scaffold).
// Shows live agent state from EHC's local runtime (127.0.0.1 only) and opens
// the panel with sessions, approvals, and the global pause toggle.
Item {
  id: root
  property bool paused: false
  property int active: 0
  property string note: "ehc: offline"

  // The runtime password lives in ~/.eventhorizon/runtime.json (created by the
  // app, 0600). The widget never writes it anywhere; it is used only for the
  // localhost request. On any failure the widget stays visibly offline.
  function runtimeBaseUrl() { return "http://127.0.0.1:4126"; }

  Timer {
    interval: 5000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  function refresh() {
    // TODO: validate against a real Quattro shell. Intended call:
    //   curl -s -u eventhorizon:<password> <runtimeBaseUrl>/api/sessions
    //   curl -s -u ... <runtimeBaseUrl>/api/runtime/pause
    // On success: root.active = sessions.length; root.paused = pause.paused
  }

  Text {
    text: root.note !== "ehc: offline" ? `EHC ${root.paused ? "⏸" : "⚡"} ${root.active}` : root.note
    color: root.paused ? "#fbbf24" : "#22d3ee"
    font.pixelSize: 12
  }

  MouseArea {
    anchors.fill: parent
    onClicked: {
      // TODO: summon Panel.qml via the plugin shell route
      // Quickshell.execDetached(["eventhorizon-app"]) would open the app itself.
    }
  }
}
