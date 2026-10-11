import { useShared } from '../data';

interface Props {
  value: number | null;
  source?: 'auto' | 'rule' | 'manual' | null;
  placeholder?: string;
  onChange: (categoryId: number | null | 'auto') => void;
}

const SOURCE_HINT = { auto: 'Asignada automáticamente', rule: 'Asignada por una regla', manual: 'Asignada a mano' };

export function CategorySelect({ value, source, placeholder = '— Sin categoría —', onChange }: Props) {
  const { categories } = useShared();
  const color = categories.find((c) => c.id === value)?.color;
  return (
    <select
      className={`category ${source ?? ''}`}
      style={color ? { borderLeftColor: color } : undefined}
      title={source ? SOURCE_HINT[source] : undefined}
      value={value ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === 'auto' ? 'auto' : v === '' ? null : Number(v));
      }}
    >
      <option value="">{placeholder}</option>
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
      {source === 'manual' && <option value="auto">↺ Volver a automática</option>}
    </select>
  );
}
