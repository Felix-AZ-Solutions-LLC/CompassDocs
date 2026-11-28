// The plan meter (STYLEGUIDE §Plan meter, 1.22.0): the usage meter's
// variant for a plan limit with a soft buffer. The bar runs to the end of
// the buffer (120% of the limit by default), so the buffer is visible as
// its hatched end; within the limit the fill is the accent, past it amber
// (the UsageMeter rule). Ticks mark the limit and, for agents, the included
// count. role="meter" with the real numbers; the card's chip says the state
// in words, so color is never the only signal. Server-safe.

export interface MeterMark {
  at: number;
  label: string;
}

export function PlanMeter({
  value,
  limit,
  end,
  label,
  valueText,
  marks = [],
  startLabel = "0",
  className = "",
}: {
  value: number;
  /** The plan's limit (the meter's maximum for ARIA). */
  limit: number;
  /** Where the bar ends: the buffer's end, else 120% of the limit. */
  end: number;
  /** What is counted ("Active users this month"). */
  label: string;
  /** The real count in words ("271 of 250, over by 21"). */
  valueText: string;
  /** Ticks under the bar (the limit first). */
  marks?: MeterMark[];
  startLabel?: string;
  className?: string;
}) {
  const top = Math.max(end, limit, 1e-9);
  const pos = (n: number) => `${Math.max(0, Math.min(100, (n / top) * 100))}%`;
  const over = value > limit;
  return (
    <div className={className}>
      <div className="relative">
        <div
          className="relative h-2 w-full overflow-hidden rounded-full bg-slate-100"
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={limit}
          // A meter's value can't pass its maximum (ARIA): valuetext carries the real count.
          aria-valuenow={Math.min(value, limit)}
          aria-valuetext={valueText}
        >
          {end > limit && <div aria-hidden className="plan-buffer absolute inset-y-0 right-0" style={{ left: pos(limit) }} />}
          <div aria-hidden className={`absolute inset-y-0 left-0 rounded-full ${over ? "bg-amber-500" : "bg-compass-600"}`} style={{ width: pos(value) }} />
        </div>
        {marks.map((m) => (
          <div key={`${m.at}-${m.label}`} aria-hidden className="absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-slate-600" style={{ left: pos(m.at) }} />
        ))}
      </div>
      <div aria-hidden className="relative mt-1 h-4 text-2xs text-slate-500 tabular-nums">
        <span className="absolute left-0">{startLabel}</span>
        {marks.map((m) => (
          <span key={`${m.at}-${m.label}`} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: pos(m.at) }}>
            {m.label}
          </span>
        ))}
      </div>
    </div>
  );
}
