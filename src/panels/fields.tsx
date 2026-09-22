/** Contrôles de formulaire compacts du panneau de propriétés. */
import { type ReactNode, useId, useState } from 'react';
import { t } from '@/i18n/index.ts';
import { QUICK_COLORS } from './quickColors.ts';

const inputClass =
  'w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm tabular-nums focus:border-accent focus:outline-none disabled:bg-slate-100 disabled:text-slate-400';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section role="group" aria-labelledby={id} className="space-y-2 border-t border-slate-200 pt-3">
      <h3 id={id} className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2">{children}</div>;
}

/** Champ texte : chaque frappe met à jour l'objet ; les frappes rapprochées forment une action. */
export function TextField({
  label,
  value,
  onChange,
  disabled,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  multiline?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-0.5 block text-xs text-slate-600">
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          rows={2}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      ) : (
        <input
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        />
      )}
    </div>
  );
}

/**
 * Champ numérique : la valeur est validée à la sortie du champ ou avec Entrée (une seule action
 * d'historique), jamais à chaque chiffre tapé.
 */
export function NumberField({
  label,
  value,
  onCommit,
  disabled,
  min,
  step = 1,
  digits = 1,
}: {
  label: string;
  value: number;
  onCommit(value: number): void;
  disabled?: boolean;
  min?: number;
  step?: number;
  digits?: number;
}) {
  const id = useId();
  const shown = Number(value.toFixed(digits));
  // Saisie en cours (null = on affiche la valeur actuelle de l'objet).
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(shown);
  const commit = () => {
    setDraft(null);
    const parsed = Number(text.replace(',', '.'));
    if (!Number.isFinite(parsed) || (min !== undefined && parsed < min)) return;
    if (parsed !== shown) onCommit(parsed);
  };
  return (
    <div>
      <label htmlFor={id} className="mb-0.5 block text-xs text-slate-600">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        value={text}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(null);
        }}
        className={inputClass}
      />
    </div>
  );
}

/** Opacité de 0 à 100 %. Le glissement du curseur forme une seule action. */
export function OpacityField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
  disabled?: boolean;
}) {
  const id = useId();
  const percent = Math.round(value * 100);
  return (
    <div>
      <label htmlFor={id} className="mb-0.5 flex justify-between text-xs text-slate-600">
        <span>{label}</span>
        <span className="tabular-nums">{percent} %</span>
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        value={percent}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="w-full accent-accent"
      />
    </div>
  );
}

export function ColorField({
  label,
  value,
  onChange,
  disabled,
  allowNone = false,
}: {
  label: string;
  value: string | null;
  onChange(value: string | null): void;
  disabled?: boolean;
  allowNone?: boolean;
}) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id}>
      <div id={id} className="mb-1 text-xs text-slate-600">
        {label}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {allowNone && (
          <button
            type="button"
            disabled={disabled}
            aria-pressed={value === null}
            title={t('props.noFill')}
            aria-label={`${label} : ${t('props.noFill')}`}
            onClick={() => onChange(null)}
            className={`h-6 w-6 rounded border bg-[linear-gradient(135deg,transparent_45%,#dc2626_45%,#dc2626_55%,transparent_55%)] ${value === null ? 'ring-2 ring-accent ring-offset-1' : 'border-slate-300'}`}
          />
        )}
        {QUICK_COLORS.map(({ key, hex }) => (
          <button
            key={hex}
            type="button"
            disabled={disabled}
            aria-pressed={value?.toLowerCase() === hex}
            title={t(key)}
            aria-label={`${label} : ${t(key)}`}
            onClick={() => onChange(hex)}
            className={`h-6 w-6 rounded border border-slate-300 ${value?.toLowerCase() === hex ? 'ring-2 ring-accent ring-offset-1' : ''}`}
            style={{ background: hex }}
          />
        ))}
        <input
          type="color"
          disabled={disabled}
          aria-label={`${label} : ${t('props.customColor')}`}
          title={t('props.customColor')}
          value={value ?? '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="h-6 w-8 cursor-pointer rounded border border-slate-300 bg-white p-0"
        />
      </div>
    </div>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange(v: boolean): void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
      {label}
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-0.5 block text-xs text-slate-600">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className={inputClass}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
