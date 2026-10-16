import { useEffect, useState } from 'react';
import { LABELS_LIST_ID } from '../data';

interface Props {
  value: string;
  placeholder?: string;
  fromRule?: boolean;
  /** Se llama al salir del campo o con Enter, solo si el valor cambió. null = borrar comentario. */
  onCommit: (label: string | null) => void;
}

export function LabelInput({ value, placeholder = '', fromRule, onCommit }: Props) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  const commit = () => {
    const v = text.trim();
    if (v === value.trim()) return;
    onCommit(v === '' ? null : v);
  };

  return (
    <input
      className={`label-input ${fromRule ? 'rule' : ''}`}
      title={fromRule ? 'Asignada por una regla' : undefined}
      list={LABELS_LIST_ID}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setText(value);
      }}
    />
  );
}
