#!/usr/bin/env python3
# Event Horizon Code - Omarchy bar widget poller.
# One shot: reads ~/.eventhorizon/runtime.json (port + per-launch password),
# queries the LOCAL runtime only (127.0.0.1), prints one JSON line for the QML
# widget. Never talks to a model, never leaves the machine. Absent password or
# unreachable runtime -> {"reachable": false} and the widget says so plainly.
import base64
import json
import sys
import urllib.request

ACTIVE_STATES = {"running", "planning"}


def main() -> int:
    cfg_path = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        cfg = json.load(open(cfg_path))
        port, pw = cfg["port"], cfg["password"]
        auth = "Basic " + base64.b64encode(f"eventhorizon:{pw}".encode()).decode()
    except Exception:
        print(json.dumps({"reachable": False, "reason": "no readable runtime.json"}))
        return 0

    def get(path):
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}", headers={"authorization": auth})
        return json.load(urllib.request.urlopen(req, timeout=2))

    try:
        paused = bool(get("/api/runtime/pause")["paused"])
        runs = get("/api/runs")
        active = sum(1 for r in runs if r.get("status") in ACTIVE_STATES)
        approvals = len(get("/api/approvals")["approvals"])
        print(json.dumps({"reachable": True, "paused": paused,
                          "active": active, "approvals": approvals}))
    except Exception as e:
        print(json.dumps({"reachable": False, "reason": str(e)[:80]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
