/**
 * Minimal inline SVG line chart -- no Chart.js here on purpose: this is a
 * tiny (~60x20px) decoration drawn dozens of times across the scenario
 * grid, not an interactive chart, so a plain <path> is both cheaper and
 * simpler than mounting a Chart.js canvas per card.
 */
export default function Sparkline({
  values,
  width = 64,
  height = 20,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  // The path's highest/lowest points would otherwise land exactly on y=0
  // and y=height -- with a non-zero strokeWidth, half the stroke extends
  // past those coordinates and gets clipped by the viewBox edge (confirmed
  // visually: the line's peaks/troughs were flattened off at the top and
  // bottom of the card). Reserving a small vertical margin and plotting
  // within [PAD, height - PAD] keeps the full stroke inside the viewBox.
  const PAD = 2;
  const plotHeight = height - PAD * 2;

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = PAD + (plotHeight - ((v - min) / range) * plotHeight);
    return [x, y];
  });

  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  // Zero line (where emissions cross from positive to negative), only
  // drawn when the series actually spans zero -- real reference point for
  // scenarios that go net-negative, not shown for ones that never do.
  const showZeroLine = min < 0 && max > 0;
  const zeroY = PAD + (plotHeight - ((0 - min) / range) * plotHeight);

  return (
    <svg
      className="scenario-sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {showZeroLine && (
        <line x1={0} y1={zeroY} x2={width} y2={zeroY} stroke="currentColor" strokeWidth={0.5} opacity={0.25} />
      )}
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
