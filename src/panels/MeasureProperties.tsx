/**
 * Mesures d'un objet (longueur, périmètre, surface), générateur de cases de stationnement et
 * informations d'une case. Valeurs en mètres si le plan est calibré (arrondies selon
 * l'incertitude), sinon en pixels de la photo.
 */
import { Grid3x3, Unlink } from 'lucide-react';
import { useState } from 'react';
import { formatArea, formatLength, measureObject, metersPerPixel } from '@/domain/model/measure.ts';
import { generateStalls, STALL_DEFAULTS_M, stallCount } from '@/domain/model/parking.ts';
import type { PlanDocument, PlanObject } from '@/domain/model/types.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore } from '@/store/planStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';
import { Button } from '@/ui/Button.tsx';
import { NumberField, Row, Section } from './fields.tsx';

export function MeasureSection({ object, doc }: { object: PlanObject; doc: PlanDocument }) {
  const m = measureObject(object);
  const { calibration: cal, units } = doc.plan;
  if (m.length === undefined && m.area === undefined) return null;
  return (
    <Section title={t('measure.title')}>
      <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-sm" data-testid="object-measures">
        {m.length !== undefined && (
          <>
            <dt className="text-slate-600">{t('measure.length')}</dt>
            <dd data-testid="measure-length">{formatLength(m.length, cal, units)}</dd>
          </>
        )}
        {m.perimeter !== undefined && (
          <>
            <dt className="text-slate-600">{t('measure.perimeter')}</dt>
            <dd data-testid="measure-perimeter">{formatLength(m.perimeter, cal, units)}</dd>
          </>
        )}
        {m.area !== undefined && (
          <>
            <dt className="text-slate-600">{t('measure.area')}</dt>
            <dd data-testid="measure-area">{formatArea(m.area, cal, units)}</dd>
          </>
        )}
      </dl>
      <p className="text-xs text-slate-500">{cal ? t('measure.approximate') : t('measure.uncalibrated')}</p>
    </Section>
  );
}

/** Générateur de cases : visible sur les zones de stationnement. */
export function ParkingGenerator({
  zone,
  doc,
  disabled,
}: {
  zone: PlanObject;
  doc: PlanDocument;
  disabled: boolean;
}) {
  const mpp = metersPerPixel(doc.plan.calibration);
  const defaults = STALL_DEFAULTS_M[zone.presetId ?? ''] ?? STALL_DEFAULTS_M['zone.parking-custom']!;
  // Paramètres saisis en mètres si le plan est calibré, sinon en pixels de la photo.
  const [params, setParams] = useState(() => ({
    width: mpp ? defaults.width : 30,
    length: mpp ? defaults.length : 60,
    aisle: mpp ? defaults.aisle : 60,
    rows: 1,
    angle: zone.geometry.kind === 'rect' ? zone.rotation : 0,
  }));
  const count = stallCount(doc, zone.id);
  const unit = mpp ? 'm' : 'px';
  const toPx = (v: number) => (mpp ? v / mpp : v);
  const generate = () => {
    let created = 0;
    const strokeWidth = Math.max(0.5, 2 / useViewportStore.getState().viewport.scale);
    planStore.getState().update('Générer les cases de stationnement', (d) => {
      created = generateStalls(
        d,
        zone.id,
        {
          width: toPx(params.width),
          length: toPx(params.length),
          aisle: toPx(params.aisle),
          rows: params.rows,
          angleDeg: params.angle,
        },
        strokeWidth,
      );
    });
    useEditorStore.getState().notify(t('parking.created', { count: created }));
  };
  const field = (key: 'width' | 'length' | 'aisle', label: string) => (
    <NumberField
      label={`${label} (${unit})`}
      value={params[key]}
      min={0.1}
      digits={2}
      disabled={disabled}
      onCommit={(v) => setParams((p) => ({ ...p, [key]: v }))}
    />
  );
  return (
    <Section title={t('parking.title')}>
      <p className="text-sm" data-testid="stall-count">
        {t('parking.count', { count })}
      </p>
      <Row>
        {field('width', t('parking.width'))}
        {field('length', t('parking.length'))}
      </Row>
      <Row>
        <NumberField
          label={t('parking.rows')}
          value={params.rows}
          min={1}
          digits={0}
          disabled={disabled}
          onCommit={(rows) => setParams((p) => ({ ...p, rows: Math.max(1, Math.min(50, Math.round(rows))) }))}
        />
        {field('aisle', t('parking.aisle'))}
      </Row>
      <NumberField
        label={t('parking.angle')}
        value={params.angle}
        disabled={disabled}
        onCommit={(angle) => setParams((p) => ({ ...p, angle }))}
      />
      <Button className="w-full" disabled={disabled} onClick={generate}>
        <Grid3x3 size={16} /> {count ? t('parking.regenerate') : t('parking.generate')}
      </Button>
      <p className="text-xs text-slate-500">{t('parking.help')}</p>
    </Section>
  );
}

export function StallSection({
  stall,
  doc,
  disabled,
  set,
}: {
  stall: Extract<PlanObject, { type: 'stall' }>;
  doc: PlanDocument;
  disabled: boolean;
  set(next: PlanObject, label: string): void;
}) {
  const parent = stall.parentZoneId ? doc.objects[stall.parentZoneId] : undefined;
  return (
    <Section title={t('parking.stall')}>
      <p className="text-xs text-slate-600">
        {parent ? t('parking.stallOf', { name: parent.name }) : t('parking.stallFree')}
      </p>
      {parent && (
        <Button
          className="w-full"
          disabled={disabled}
          onClick={() => set({ ...stall, parentZoneId: null }, 'Détacher la case')}
        >
          <Unlink size={16} /> {t('parking.detach')}
        </Button>
      )}
    </Section>
  );
}
