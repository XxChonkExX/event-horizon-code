// Event Horizon Code — Radar view: a planar lidar scan, drawn as it is read.
//
// The picture is never the only form of a reading. The nearest obstacle is
// computed in one place (src/shared/radar.ts) and shown both as the bright
// wedge and as the sentence under the picture, which is also the SVG's
// accessible name. Angle 0 is ahead (up), clockwise.

import { For, Show } from "solid-js";
import { asLaserScan, describeScan, nearestSector, ringRadii, scanSectors, wedgePath } from "../shared/radar";
import { latestScan } from "./sensorStore";

const SIZE = 240;
const CX = 120;
const CY = 120;
const R = 108;
const R_INNER = 12;
const EMPTY_TEXT = "No scan yet. Start a lidar source and sweep it, or push scans through the bridge.";

function fmt(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour12: false });
}

export default function RadarView() {
  const scan = () => {
    const s = latestScan();
    if (!s) return null;
    const parsed = asLaserScan(s.observation.payload);
    if (!parsed) return null;
    const label = s.source?.label ?? s.observation.source;
    return {
      parsed, label,
      sectors: scanSectors(parsed),
      nearest: nearestSector(parsed),
      text: describeScan(parsed, label),
      at: s.observation.t,
    };
  };
  const text = (): string => scan()?.text ?? EMPTY_TEXT;

  return (
    <div class="radar">
      <svg class="radar-svg" width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={text()}>
        <title>{text()}</title>
        {/* Range rings: each is labelled with the metres it stands for. */}
        <For each={ringRadii(R, scan()?.parsed.rangeM ?? 5)}>{(ring) => (
          <>
            <circle cx={CX} cy={CY} r={ring.r} class="radar-ring" />
            <text x={CX + 4} y={CY - ring.r + 10} class="radar-label">{ring.metres.toFixed(1)} m</text>
          </>
        )}</For>
        <line x1={CX - R} y1={CY} x2={CX + R} y2={CY} class="radar-axis" />
        <line x1={CX} y1={CY - R} x2={CX} y2={CY + R} class="radar-axis" />
        {/* Ahead marker: a small notch at the top of the dial. */}
        <path d={`M ${CX - 5} ${CY - R - 4} L ${CX} ${CY - R - 10} L ${CX + 5} ${CY - R - 4}`} class="radar-ahead" />
        <For each={scan()?.sectors ?? []}>{(s, i) => (
          <path
            d={wedgePath(CX, CY, R_INNER, R, s.startDeg, s.endDeg)}
            class="radar-wedge"
            classList={{ "radar-wedge-nearest": i() === scan()?.nearest?.index }}
            style={{ opacity: String(0.05 + 0.95 * s.proximity) }}
          />
        )}</For>
        <g class="radar-sweep"><line x1={CX} y1={CY} x2={CX} y2={CY - R} /></g>
        <circle cx={CX} cy={CY} r={R_INNER} class="radar-center" />
      </svg>
      <p class="radar-text" role="status" aria-live="off">{text()}</p>
      <p class="radar-meta">
        <Show when={scan()} fallback="nothing received">
          {`${scan()!.label} \u00B7 ${scan()!.parsed.sectors.length} sectors \u00B7 ${fmt(scan()!.at)}`}
        </Show>
      </p>
    </div>
  );
}
