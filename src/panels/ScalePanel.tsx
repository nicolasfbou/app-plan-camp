/**
 * Échelle et orientation du plan : calibration (distance connue entre deux points), unités, nord.
 * La calibration n'est jamais inventée : sans elle, tout reste en pixels et aucune échelle n'est
 * affichée. Le nord n'est jamais supposé être en haut de l'image.
 */
import { Compass, Ruler, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { calibrationPixels, calibrationUncertainty, metersPerPixel } from '@/domain/model/measure.ts';
import { normalizeAngle } from '@/domain/model/shapes.ts';
import type { Point } from '@/domain/model/types.ts';
import { formatInteger, t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { Modal } from '@/ui/Modal.tsx';
import { NumberField, Section, SelectField } from './fields.tsx';

const fmt = (value: number, digits: number) =>
  new Intl.NumberFormat('fr-CA', { maximumSignificantDigits: digits }).format(value);

export function ScalePanel() {
  const plan = usePlanStore((s) => s.doc?.plan);
  if (!plan) return null;
  const cal = plan.calibration;
  const mpp = metersPerPixel(cal);
  const update = (
    label: string,
    recipe: (d: NonNullable<ReturnType<typeof planStore.getState>['doc']>) => void,
  ) => planStore.getState().update(label, recipe);

  return (
    <div className="space-y-3" data-testid="scale-panel">
      <Section title={t('scale.title')}>
        {cal && mpp ? (
          <p className="text-xs text-slate-700" data-testid="calibration-status">
            {t('scale.calibrated', {
              meters: fmt(cal.distanceMeters, 4),
              pixels: formatInteger(Math.round(calibrationPixels(cal))),
              mpp: fmt(mpp, 3),
              uncertainty: Math.round(calibrationUncertainty(cal) * 100),
            })}
          </p>
        ) : (
          <p className="text-xs text-amber-800" data-testid="calibration-status">
            {t('scale.uncalibrated')}
          </p>
        )}
        <p className="text-xs text-slate-500">{t('scale.approximate')}</p>
        {cal && (
          <NumberField
            label={t('scale.distance')}
            value={cal.distanceMeters}
            min={0.01}
            digits={3}
            onCommit={(distanceMeters) =>
              update('Modifier la calibration', (d) => {
                if (d.plan.calibration) d.plan.calibration.distanceMeters = distanceMeters;
              })
            }
          />
        )}
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => useEditorStore.getState().setTool('calibrate')}>
            <Ruler size={16} /> {cal ? t('scale.recalibrate') : t('scale.calibrate')}
          </Button>
          {cal && (
            <Button
              aria-label={t('scale.remove')}
              title={t('scale.remove')}
              onClick={() =>
                update('Supprimer la calibration', (d) => {
                  d.plan.calibration = null;
                })
              }
            >
              <Trash2 size={16} />
            </Button>
          )}
        </div>
        <SelectField
          label={t('scale.units')}
          value={plan.units}
          options={[
            { value: 'metric', label: t('scale.units.metric') },
            { value: 'imperial', label: t('scale.units.imperial') },
          ]}
          onChange={(units) =>
            update('Unités', (d) => {
              d.plan.units = units;
            })
          }
        />
      </Section>

      <Section title={t('north.title')}>
        <p className="text-xs text-slate-700" data-testid="north-status">
          {plan.northStatus === 'undefined'
            ? t('north.undefined')
            : t(plan.northStatus === 'verified' ? 'north.verified' : 'north.estimated', {
                angle: Math.round(plan.northAngleDeg),
              })}
        </p>
        <Button className="w-full" onClick={() => useEditorStore.getState().setTool('north')}>
          <Compass size={16} /> {t('north.orient')}
        </Button>
        {plan.northStatus !== 'undefined' && (
          <>
            <NumberField
              label={t('north.angle')}
              value={plan.northAngleDeg}
              onCommit={(angle) =>
                update('Orienter le nord', (d) => {
                  d.plan.northAngleDeg = normalizeAngle(angle);
                })
              }
            />
            <SelectField
              label={t('north.status')}
              value={plan.northStatus}
              options={[
                { value: 'estimated', label: t('north.status.estimated') },
                { value: 'verified', label: t('north.status.verified') },
                { value: 'undefined', label: t('north.status.undefined') },
              ]}
              onChange={(northStatus) =>
                update('Statut du nord', (d) => {
                  d.plan.northStatus = northStatus;
                })
              }
            />
          </>
        )}
      </Section>
    </div>
  );
}

/** Distance réelle entre les deux points cliqués (outil Calibrer). */
export function CalibrationDialog({ p1, p2 }: { p1: Point; p2: Point }) {
  const previous = usePlanStore((s) => s.doc?.plan.calibration ?? null);
  const [text, setText] = useState('');
  const pixels = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const meters = Number(text.trim().replace(/\s/g, '').replace(',', '.'));
  const valid = text.trim() !== '' && Number.isFinite(meters) && meters > 0 && pixels >= 1;
  const close = () => useEditorStore.getState().setPendingCalibration(null);
  const confirm = () => {
    if (!valid) return;
    planStore.getState().update('Calibrer', (d) => {
      d.plan.calibration = { p1, p2, distanceMeters: meters };
    });
    close();
  };
  return (
    <Modal
      open
      title={t('scale.dialog.title')}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!valid} onClick={confirm}>
            {t('scale.dialog.confirm')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <p>{t('scale.dialog.pixels', { pixels: formatInteger(Math.round(pixels)) })}</p>
        <label className="block">
          <span className="mb-1 block font-medium text-slate-800">{t('scale.dialog.meters')}</span>
          <input
            autoFocus
            inputMode="decimal"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        {pixels < 50 && <p className="text-xs text-amber-800">{t('scale.dialog.short')}</p>}
        <p className="text-xs text-slate-600">{t('scale.dialog.help')}</p>
        {previous && <p className="text-xs text-slate-600">{t('scale.dialog.replace')}</p>}
      </form>
    </Modal>
  );
}
