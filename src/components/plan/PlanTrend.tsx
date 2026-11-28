// A meter's six-month trend (1.22.0, STYLEGUIDE §Plan meter): one value a
// month (the month's final count; agents the month's highest), drawn to
// scale from zero, with the plan's limit as a dashed hairline. The current
// month's point is hollow: the month isn't over. Hand-rolled SVG (the
// house charts method): a 2px line in the accent, a 10% wash, end dots with
// a surface ring, slate text. The numbers are an sr-only table. Server-safe.

import { monthShort, type TrendPoint } from "@/lib/plan-shared";

const W = 160;
const H = 44;
const PAD_T = 6;
const PAD_B = 2;

export function PlanTrend({
  points,
  limit,
  label,
  format,
  limitLabel,
  className = "",
}: {
  points: TrendPoint[];
  limit: number | null;
  /** The caption ("Active users, last six months"). */
  label: string;
  format: (n: number) => string;
  /** The dashed line's label ("250", "$15"). */
  limitLabel?: string;
  className?: string;
}) {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  const top = Math.max(limit !== null ? limit * 1.2 : 0, ...values, 1) * 1.05;
  const x = (i: number) => (points.length <= 1 ? W / 2 : 4 + (i * (W - 8)) / (points.length - 1));
  const y = (v: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - v / top);
  const drawn = points.map((p, i) => ({ ...p, i })).filter((p): p is TrendPoint & { i: number; value: number } => p.value !== null);
  const line = drawn.map((p) => `${x(p.i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = drawn.length > 1 ? `M${x(drawn[0].i).toFixed(1)},${H - PAD_B} L${line.replace(/ /g, " L")} L${x(drawn[drawn.length - 1].i).toFixed(1)},${H - PAD_B} Z` : "";
  return (
    <figure className={`min-w-0 ${className}`}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-11 w-full overflow-visible" aria-hidden preserveAspectRatio="none">
        {limit !== null && (
          <>
            <line x1={0} x2={W} y1={y(limit)} y2={y(limit)} className="stroke-slate-400" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          </>
        )}
        {area && <path d={area} className="fill-compass-500/10" />}
        {drawn.length > 1 && <polyline points={line} fill="none" className="stroke-compass-500" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      </svg>
      {/* Dots and labels in HTML, so a stretched SVG never turns a dot into an oval. */}
      <div aria-hidden className="relative -mt-11 h-11">
        {drawn.map((p) => (
          <span
            key={p.month}
            className={`absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface ${p.partial ? "border-2 border-compass-500 bg-surface" : "bg-compass-500"}`}
            style={{ left: `${(x(p.i) / W) * 100}%`, top: `${(y(p.value) / H) * 100}%` }}
          />
        ))}
        {limit !== null && limitLabel && (
          <span className="absolute right-0 -translate-y-full text-2xs leading-none text-slate-500 tabular-nums" style={{ top: `${(y(limit) / H) * 100}%` }}>
            {limitLabel}
          </span>
        )}
      </div>
      <div aria-hidden className="mt-1 flex justify-between text-2xs text-slate-500">
        {points.map((p) => (
          <span key={p.month}>{monthShort(p.month)}</span>
        ))}
      </div>
      {/* sr-only on a wrapper: a table sizes to its content and ignores the 1px box (it widened a phone page). */}
      <div className="sr-only">
      <table>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.month}>
              <th scope="row">{p.month}</th>
              <td>
                {p.value === null ? "Not counted" : format(p.value)}
                {p.partial ? " (so far)" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  );
}
