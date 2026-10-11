import { PRESETS, presetRange, type DateRange } from '../format';

interface Props {
  value: DateRange;
  onChange: (r: DateRange) => void;
}

export function RangePicker({ value, onChange }: Props) {
  return (
    <div className="range">
      <div className="presets">
        {PRESETS.map((p) => {
          const r = presetRange(p.key);
          const active = r.from === value.from && r.to === value.to;
          return (
            <button key={p.key} className={active ? 'chip active' : 'chip'} onClick={() => onChange(r)}>
              {p.label}
            </button>
          );
        })}
      </div>
      <label>
        Desde <input type="date" value={value.from} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} />
      </label>
      <label>
        Hasta <input type="date" value={value.to} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} />
      </label>
    </div>
  );
}
