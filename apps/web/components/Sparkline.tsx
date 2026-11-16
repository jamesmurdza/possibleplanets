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

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return [x, y];
  });

  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  // Zero line (where emissions cross from positive to negative), only
  // drawn when the series actually spans zero -- real reference point for
  // scenarios that go net-negative, not shown for ones that never do.
  const showZeroLine = min < 0 && max > 0;
  const zeroY = height - ((0 - min) / range) * height;

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
