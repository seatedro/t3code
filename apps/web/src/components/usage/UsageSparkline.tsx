const WIDTH = 64;
const HEIGHT = 18;

export function UsageSparkline({
  values,
  color,
}: {
  readonly values: readonly number[];
  readonly color: string;
}) {
  const peak = Math.max(0, ...values);
  const step = values.length < 2 ? 0 : (WIDTH - 2) / (values.length - 1);
  const points = values
    .map((value, index) => {
      const x = 1 + index * step;
      const y = HEIGHT - 1.5 - (peak === 0 ? 0 : (value / peak) * (HEIGHT - 3));
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg aria-hidden width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
