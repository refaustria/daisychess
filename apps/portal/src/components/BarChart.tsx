import ui from '../ui.module.css';

export interface Bar {
  label: string;
  value: number;
}

/** Simple vertical bar chart (SVG, theme colours via CSS classes). The data table next to it is the accessible form. */
export function BarChart({ bars, title, unit }: { bars: Bar[]; title: string; unit: string }) {
  const W = 600;
  const H = 160;
  const pad = 4;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const slot = (W - pad * 2) / Math.max(1, bars.length);
  return (
    <svg viewBox={`0 0 ${W} ${H + 20}`} className={ui.chart} role="img" aria-label={`${title}: ${bars.reduce((s, b) => s + b.value, 0)} ${unit} in the last ${bars.length} days. Details in the table below.`}>
      <line x1={pad} x2={W - pad} y1={H} y2={H} className={ui.chartAxis} />
      {bars.map((b, i) => {
        const h = (b.value / max) * (H - 8);
        return (
          <rect key={b.label} x={pad + i * slot + slot * 0.15} width={slot * 0.7} y={H - h} height={h} className={ui.chartBar}>
            <title>{`${b.label}: ${b.value} ${unit}`}</title>
          </rect>
        );
      })}
      <text x={pad} y={H + 15} className={ui.chartText}>
        {bars[0]?.label ?? ''}
      </text>
      <text x={W - pad} y={H + 15} textAnchor="end" className={ui.chartText}>
        {bars[bars.length - 1]?.label ?? ''}
      </text>
      <text x={W - pad} y={10} textAnchor="end" className={ui.chartText}>
        {`max ${max}`}
      </text>
    </svg>
  );
}
