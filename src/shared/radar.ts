// Event Horizon Code - radar geometry (pure: no DOM, no Node).
//
// A lidar arrives on the sensor bus as a bounded `laserscan` Observation:
// `{ sectors: number[], rangeM, resolutionDeg }` - one range in metres per
// angular sector, sector 0 straight ahead, clockwise. This module turns that
// into the two things the Radar view shows: the shapes it draws, and the
// TEXT equivalent. The text is not a courtesy: the picture is never the only
// way a reading is stated (docs/SENSORS-ACCESSIBILITY.md), so the nearest
// obstacle is computed here once and both the picture and the words use it.

export type LaserScan = { sectors: number[]; rangeM: number; resolutionDeg: number };
export type ScanSector = { index: number; value: number; startDeg: number; endDeg: number; proximity: number };
export type Nearest = { index: number; value: number; bearingDeg: number };

const MAX_SECTORS = 720;
const DEFAULT_RANGE_M = 5;

/** Accepts only a well-formed scan: an array of finite, non-negative numbers. Anything else is `null` (stated, not guessed). */
export function asLaserScan(payload: unknown): LaserScan | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { sectors?: unknown; rangeM?: unknown; resolutionDeg?: unknown };
  if (!Array.isArray(p.sectors) || p.sectors.length < 4 || p.sectors.length > MAX_SECTORS) return null;
  if (!p.sectors.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) return null;
  const n = p.sectors.length;
  const rangeM = typeof p.rangeM === "number" && Number.isFinite(p.rangeM) && p.rangeM > 0 ? p.rangeM : DEFAULT_RANGE_M;
  const resolutionDeg = typeof p.resolutionDeg === "number" && Number.isFinite(p.resolutionDeg) && p.resolutionDeg > 0
    ? p.resolutionDeg
    : 360 / n;
  return { sectors: p.sectors.filter((v): v is number => typeof v === "number"), rangeM, resolutionDeg };
}

/** How close a reading is, 0 (at the range limit or beyond) to 1 (touching). */
export function proximity(value: number, rangeM: number): number {
  if (!(rangeM > 0)) return 0;
  return Math.max(0, Math.min(1, 1 - value / rangeM));
}

/** Every sector with its angle span (degrees clockwise from ahead). */
export function scanSectors(scan: LaserScan): ScanSector[] {
  return scan.sectors.map((value, index) => {
    const startDeg = index * scan.resolutionDeg;
    return { index, value, startDeg, endDeg: startDeg + scan.resolutionDeg, proximity: proximity(value, scan.rangeM) };
  });
}

/** The nearest reading and where it is (the centre of its sector, degrees clockwise from ahead: 0 ahead, 90 right, 180 behind). */
export function nearestSector(scan: LaserScan): Nearest | null {
  let best = -1;
  scan.sectors.forEach((v, i) => { if (best < 0 || v < scan.sectors[best]!) best = i; });
  if (best < 0) return null;
  return { index: best, value: scan.sectors[best]!, bearingDeg: Math.round((best + 0.5) * scan.resolutionDeg) % 360 };
}

/** The reading in words: the same nearest obstacle the picture highlights. */
export function describeScan(scan: LaserScan, sourceLabel = ""): string {
  const n = nearestSector(scan);
  const where = sourceLabel ? `${sourceLabel}: ` : "";
  if (!n) return `${where}no sectors`;
  const side = (d: number): string => {
    const b = ((d % 360) + 360) % 360;
    if (b < 15 || b >= 345) return "ahead";
    if (b < 75) return "ahead right";
    if (b < 105) return "to the right";
    if (b < 165) return "behind right";
    if (b < 195) return "behind";
    if (b < 255) return "behind left";
    if (b < 285) return "to the left";
    return "ahead left";
  };
  return `${where}nearest ${n.value.toFixed(2)} m ${side(n.bearingDeg)} (${n.bearingDeg}\u00B0, sector ${n.index + 1} of ${scan.sectors.length}, ${scan.rangeM} m range)`;
}

/**
 * SVG path of one annular sector (a radar wedge). Angles are degrees
 * clockwise from ahead, which is UP on screen: 0 is up, 90 is right.
 */
export function wedgePath(cx: number, cy: number, rInner: number, rOuter: number, startDeg: number, endDeg: number): string {
  const pt = (r: number, deg: number): string => {
    const rad = (deg * Math.PI) / 180;
    return `${(cx + r * Math.sin(rad)).toFixed(2)} ${(cy - r * Math.cos(rad)).toFixed(2)}`;
  };
  // A wedge is always under half a turn (a scan has at least 4 sectors), so
  // the large-arc flag is 0; clockwise on screen is sweep-flag 1.
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return [
    `M ${pt(rOuter, startDeg)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${pt(rOuter, endDeg)}`,
    `L ${pt(rInner, endDeg)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${pt(rInner, startDeg)}`,
    "Z",
  ].join(" ");
}

/** The polar rings a scan draws: equal fractions of its range, each labelled with the metres it stands for. */
export function ringRadii(radius: number, rangeM: number, steps = 4): Array<{ r: number; metres: number }> {
  return Array.from({ length: steps }, (_, i) => ({ r: (radius * (i + 1)) / steps, metres: (rangeM * (i + 1)) / steps }));
}
