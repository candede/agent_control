import { useId } from "react";
import { isValidUsageCount, usageCount, usageDate } from "../usageInsights";

export function DashboardObservationChart({ points, label, source, caption, format = "count" }: {
  points: Array<{ id: string; date: string; label: string; value: number | null; connected: boolean }>;
  label: string; source: string; caption: string;
  format?: "count" | "percent";
}) {
  const title = useId(), description = useId();
  if (!points.length) return null;
  const valid = (value: number | null): value is number => format==="percent"
    ? typeof value==="number" && Number.isFinite(value) && value>=0 && value<=100 : isValidUsageCount(value);
  const display = (value: number) => format==="percent" ? `${value.toFixed(1)}%` : usageCount(value);
  const maximum = format==="percent" ? 100 : Math.max(1, ...points.map(point => valid(point.value) ? point.value : 0));
  const first = Date.parse(points[0].date), last = Date.parse(points.at(-1)!.date);
  const x = (point: typeof points[number]) => first === last ? 190 : 44 + (Date.parse(point.date) - first) / (last - first) * 292;
  const y = (point: typeof points[number]) => 154 - (valid(point.value) ? point.value : 0) / maximum * 118;
  return <section className="dashboard-chart" aria-labelledby={title}>
    <h3 id={title}>{label} over {source}</h3>
    <svg viewBox="0 0 360 210" role="img" aria-labelledby={title} aria-describedby={description}>
      {[0, 0.5, 1].map(fraction => <g key={fraction}>
        <line x1="44" x2="336" y1={154 - fraction * 118} y2={154 - fraction * 118} className="dashboard-grid" />
        <text x="36" y={158 - fraction * 118} textAnchor="end">{format==="percent" ? `${maximum*fraction}%` :
          (maximum * fraction).toLocaleString(undefined, { maximumFractionDigits: 1, notation: "compact" })}</text>
      </g>)}
      {points.map((point, index) => <g key={point.id}>
        {index > 0 && point.connected && valid(point.value) && valid(points[index-1].value) ? <line className="dashboard-trend-line" x1={x(points[index - 1])} y1={y(points[index - 1])} x2={x(point)} y2={y(point)} /> : null}
        {valid(point.value) ? <circle className="dashboard-trend-point" cx={x(point)} cy={y(point)}
          r={index === 0 || index === points.length - 1 ? 5 : 3.5}>
          <title>{point.label}: {display(point.value)} {label.toLowerCase()}</title>
        </circle> : null}
      </g>)}
      <text x="44" y="178">{usageDate(points[0].date)}</text>
      {first !== last ? <text x="336" y="178" textAnchor="end">{usageDate(points.at(-1)!.date)}</text> : null}
      <text x="190" y="203" textAnchor="middle">Report observations (UTC)</text>
    </svg>
    <p id={description}>{caption}</p>
  </section>;
}
