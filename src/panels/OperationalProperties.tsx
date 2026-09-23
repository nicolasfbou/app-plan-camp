/**
 * Propriétés des objets de circulation et des zones opérationnelles : trajets de véhicules,
 * corridors piétons, pictogrammes, pictogramme et nom d'une zone, limites d'affichage des repères.
 * Toutes les tailles sont en pixels de la PHOTO (aucune mesure réelle sans calibration).
 */
import { ArrowLeftRight } from 'lucide-react';
import { useState } from 'react';
import { displaySettingsSchema } from '@/domain/model/schema.ts';
import { FLOW_PRESETS, findFlowPreset } from '@/domain/presets/flowPresets.ts';
import { assetSymbolId, findSymbol, SYMBOLS } from '@/domain/symbols/catalog.ts';
import type {
  CorridorObject,
  DisplaySettings,
  FlowCategory,
  FlowObject,
  IconObject,
  PlanDocument,
  PlanObject,
  ZoneObject,
} from '@/domain/model/types.ts';
import { t } from '@/i18n/index.ts';
import { planStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { NumberField, OpacityField, Row, Section, SelectField, TextField, Toggle } from './fields.tsx';

type Set = (next: PlanObject, label: string, field?: string) => void;

const NONE = '__none__';

/** Pictogrammes proposés : bibliothèque puis pictogrammes importés du plan. */
function symbolOptions(doc: PlanDocument) {
  return [
    ...SYMBOLS.map((s) => ({ value: s.id, label: s.name })),
    ...Object.values(doc.assets).map((a) => ({ value: assetSymbolId(a.id), label: `${a.name} (importé)` })),
  ];
}

export function FlowProperties({
  object,
  disabled,
  set,
}: {
  object: FlowObject;
  disabled: boolean;
  set: Set;
}) {
  const setArrows = (patch: Partial<FlowObject['arrows']>, label: string, field?: string) =>
    set({ ...object, arrows: { ...object.arrows, ...patch } }, label, field);
  return (
    <Section title={t('flow.title')}>
      <SelectField
        label={t('flow.category')}
        value={object.category}
        disabled={disabled}
        options={FLOW_PRESETS.map((p) => ({ value: p.category, label: p.name }))}
        onChange={(category: FlowCategory) => {
          // Nouvelle catégorie : sa couleur et son style de trait (l'épaisseur est conservée).
          const preset = findFlowPreset(category);
          set(
            {
              ...object,
              category,
              presetId: preset.id,
              style: { ...object.style, stroke: preset.style.stroke, dash: preset.style.dash },
            },
            'Catégorie du trajet',
          );
        }}
      />
      <SelectField
        label={t('flow.direction')}
        value={object.arrows.direction}
        disabled={disabled}
        options={(['forward', 'backward', 'both'] as const).map((d) => ({
          value: d,
          label: t(`flow.direction.${d}`),
        }))}
        onChange={(direction) => setArrows({ direction }, 'Sens de circulation')}
      />
      <Button
        className="w-full"
        disabled={disabled || object.arrows.direction === 'both'}
        onClick={() =>
          setArrows(
            { direction: object.arrows.direction === 'forward' ? 'backward' : 'forward' },
            'Inverser le sens',
          )
        }
      >
        <ArrowLeftRight size={16} /> {t('flow.reverse')}
      </Button>
      <Toggle
        label={t('flow.showArrows')}
        checked={object.arrows.visible}
        disabled={disabled}
        onChange={(visible) =>
          setArrows({ visible }, visible ? 'Afficher les flèches' : 'Masquer les flèches')
        }
      />
      <Row>
        <NumberField
          label={t('flow.arrowSize')}
          value={object.arrows.size}
          min={0.1}
          disabled={disabled}
          onCommit={(size) => setArrows({ size }, 'Taille des flèches')}
        />
        <NumberField
          label={t('flow.arrowSpacing')}
          value={object.arrows.spacing}
          min={0.1}
          disabled={disabled}
          onCommit={(spacing) => setArrows({ spacing }, 'Espacement des flèches')}
        />
      </Row>
      <p className="text-xs text-slate-500">{t('flow.help')}</p>
    </Section>
  );
}

export function CorridorProperties({
  object,
  disabled,
  set,
}: {
  object: CorridorObject;
  disabled: boolean;
  set: Set;
}) {
  return (
    <Section title={t('corridor.title')}>
      <NumberField
        label={t('corridor.width')}
        value={object.width}
        min={0.1}
        disabled={disabled}
        onCommit={(width) => set({ ...object, width }, 'Largeur du corridor')}
      />
      <p className="text-xs text-slate-500">{t('corridor.units')}</p>
      <Toggle
        label={t('corridor.showIcons')}
        checked={object.showIcons}
        disabled={disabled}
        onChange={(showIcons) => set({ ...object, showIcons }, 'Pictogrammes du corridor')}
      />
      <Toggle
        label={t('corridor.oriented')}
        checked={object.iconsOriented}
        disabled={disabled || !object.showIcons}
        onChange={(iconsOriented) => set({ ...object, iconsOriented }, 'Orientation des pictogrammes')}
      />
      <Row>
        <NumberField
          label={t('corridor.iconSpacing')}
          value={object.iconSpacing}
          min={0.1}
          disabled={disabled || !object.showIcons}
          onCommit={(iconSpacing) => set({ ...object, iconSpacing }, 'Espacement des pictogrammes')}
        />
        <NumberField
          label={t('corridor.iconSize')}
          value={object.iconSize}
          min={0.1}
          disabled={disabled || !object.showIcons}
          onCommit={(iconSize) => set({ ...object, iconSize }, 'Taille des pictogrammes')}
        />
      </Row>
    </Section>
  );
}

export function IconProperties({
  object,
  doc,
  disabled,
  set,
}: {
  object: IconObject;
  doc: PlanDocument;
  disabled: boolean;
  set: Set;
}) {
  const symbol = findSymbol(object.symbolId);
  return (
    <Section title={t('icon.title')}>
      <SelectField
        label={t('icon.symbol')}
        value={object.symbolId}
        disabled={disabled}
        options={symbolOptions(doc)}
        onChange={(symbolId) =>
          set(
            { ...object, symbolId, text: findSymbol(symbolId)?.defaultText ?? null },
            'Changer de pictogramme',
          )
        }
      />
      {symbol?.defaultText !== undefined && (
        <TextField
          label={t('icon.text')}
          value={object.text ?? ''}
          disabled={disabled}
          onChange={(text) => set({ ...object, text: text.slice(0, 3) }, 'Texte du pictogramme', 'iconText')}
        />
      )}
      <NumberField
        label={t('icon.size')}
        value={object.size}
        min={1}
        disabled={disabled}
        onCommit={(size) => set({ ...object, size }, 'Taille du pictogramme')}
      />
      <OpacityField
        label={t('icon.opacity')}
        value={object.style.fillOpacity}
        disabled={disabled}
        onChange={(fillOpacity) =>
          set({ ...object, style: { ...object.style, fillOpacity } }, 'Opacité du pictogramme', 'iconOpacity')
        }
      />
    </Section>
  );
}

export function ZoneMarkerProperties({
  object,
  doc,
  disabled,
  set,
}: {
  object: ZoneObject;
  doc: PlanDocument;
  disabled: boolean;
  set: Set;
}) {
  const boundary = (color: string) =>
    set(
      {
        ...object,
        style: {
          ...object.style,
          stroke: color,
          strokeOpacity: 1,
          dash: 'solid',
          strokeWidth: Math.max(object.style.strokeWidth, (object.icon?.size ?? 40) / 8),
        },
      },
      'Bordure de délimitation',
    );
  return (
    <Section title={t('zoneMarker.title')}>
      <SelectField
        label={t('zoneMarker.symbol')}
        value={object.icon?.symbolId ?? NONE}
        disabled={disabled}
        options={[{ value: NONE, label: t('zoneMarker.none') }, ...symbolOptions(doc)]}
        onChange={(symbolId) =>
          set(
            {
              ...object,
              icon:
                symbolId === NONE ? null : { symbolId, size: object.icon?.size ?? defaultIconSize(object) },
            },
            'Pictogramme de la zone',
          )
        }
      />
      {object.icon && (
        <NumberField
          label={t('zoneMarker.size')}
          value={object.icon.size}
          min={1}
          disabled={disabled}
          onCommit={(size) => set({ ...object, icon: { ...object.icon!, size } }, 'Taille du pictogramme')}
        />
      )}
      <Toggle
        label={t('zoneMarker.showName')}
        checked={object.showName}
        disabled={disabled}
        onChange={(showName) => set({ ...object, showName }, 'Nom de la zone')}
      />
      <div>
        <div className="mb-1 text-xs text-slate-600">{t('zoneMarker.boundary')}</div>
        <div className="flex gap-2">
          <Button className="flex-1" disabled={disabled} onClick={() => boundary('#dc2626')}>
            <span aria-hidden className="h-3 w-3 rounded-sm border-2 border-red-600" /> {t('zoneMarker.red')}
          </Button>
          <Button className="flex-1" disabled={disabled} onClick={() => boundary('#ea580c')}>
            <span aria-hidden className="h-3 w-3 rounded-sm border-2 border-orange-600" />{' '}
            {t('zoneMarker.orange')}
          </Button>
        </div>
      </div>
    </Section>
  );
}

/** Taille par défaut d'un pictogramme ajouté à une zone : proportionnée à la zone. */
function defaultIconSize(object: ZoneObject): number {
  const g = object.geometry;
  const extent =
    g.kind === 'rect'
      ? Math.min(g.width, g.height)
      : g.kind === 'ellipse'
        ? Math.min(g.rx, g.ry) * 2
        : Math.min(
            Math.max(...g.points.map((p) => p.x)) - Math.min(...g.points.map((p) => p.x)),
            Math.max(...g.points.map((p) => p.y)) - Math.min(...g.points.map((p) => p.y)),
          );
  return Math.max(4, Math.round(extent * 0.3));
}

/** Limites d'affichage des repères répétés (flèches, pictogrammes) : réglage du plan entier. */
export function DisplayLimits({ display }: { display: DisplaySettings }) {
  const [error, setError] = useState<string | null>(null);
  const update = (patch: Partial<DisplaySettings>) => {
    const next = { ...display, ...patch };
    const parsed = displaySettingsSchema.safeParse(next);
    if (!parsed.success) {
      setError(t('display.invalid'));
      return;
    }
    setError(null);
    planStore.getState().update('Limites d’affichage', (d) => {
      d.plan.display = next;
    });
  };
  return (
    <Section title={t('display.title')}>
      <Row>
        <NumberField
          label={t('display.min')}
          value={display.symbolMinPx}
          min={4}
          onCommit={(symbolMinPx) => update({ symbolMinPx })}
        />
        <NumberField
          label={t('display.max')}
          value={display.symbolMaxPx}
          min={4}
          onCommit={(symbolMaxPx) => update({ symbolMaxPx })}
        />
      </Row>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      <p className="text-xs text-slate-500">{t('display.help')}</p>
    </Section>
  );
}
