/**
 * Propriétés d'une ligne de réseau technique : réseau (et donc calque), état, disposition,
 * diamètre, matériau, profondeur, remarques, étiquette sur le plan, sens d'écoulement.
 */
import { ArrowLeftRight } from 'lucide-react';
import { ensureTierLayer, isLayerUsable } from '@/domain/model/objectFactory.ts';
import { replaceObject } from '@/domain/model/operations.ts';
import { UTILITY_PLACEMENTS, UTILITY_STATUSES } from '@/domain/model/schema.ts';
import type { NetworkTier, PlanObject, UtilityObject } from '@/domain/model/types.ts';
import {
  findNetworkPreset,
  NETWORK_PRESETS,
  STATUS_DASH,
  utilityLabel,
} from '@/domain/presets/networkPresets.ts';
import { t } from '@/i18n/index.ts';
import { planStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { OptionalNumberField, Row, Section, SelectField, TextField, Toggle } from './fields.tsx';

type Set = (next: PlanObject, label: string, field?: string) => void;

/**
 * Change le réseau d'une ligne : couleur du nouveau réseau, nom par défaut s'il n'a pas été
 * personnalisé, et passage dans le calque de ce réseau (créé au besoin) ; une seule action.
 */
function changeNetwork(object: UtilityObject, network: NetworkTier) {
  const from = findNetworkPreset(object.network);
  const to = findNetworkPreset(network);
  planStore.getState().update('Réseau de la ligne', (d) => {
    const layer = ensureTierLayer(d, network);
    const next: UtilityObject = {
      ...object,
      network,
      presetId: to.id,
      name: object.name === from.name ? to.name : object.name,
      style: { ...object.style, stroke: to.style.stroke },
      arrows: {
        ...object.arrows,
        visible: object.arrows.visible === from.arrows ? to.arrows : object.arrows.visible,
      },
    };
    // Calque du réseau masqué ou verrouillé : la ligne change de réseau mais reste où elle est.
    replaceObject(d, isLayerUsable(layer) ? { ...next, layerId: layer.id } : next);
  });
}

export function UtilityProperties({
  object,
  disabled,
  set,
}: {
  object: UtilityObject;
  disabled: boolean;
  set: Set;
}) {
  const setArrows = (patch: Partial<UtilityObject['arrows']>, label: string) =>
    set({ ...object, arrows: { ...object.arrows, ...patch } }, label);
  const label = utilityLabel(object);
  return (
    <Section title={t('utility.title')}>
      <SelectField
        label={t('utility.network')}
        value={object.network}
        disabled={disabled}
        options={NETWORK_PRESETS.map((p) => ({ value: p.network, label: t(`tier.${p.network}`) }))}
        onChange={(network) => changeNetwork(object, network)}
      />
      <Row>
        <SelectField
          label={t('utility.status')}
          value={object.status}
          disabled={disabled}
          options={UTILITY_STATUSES.map((s) => ({ value: s, label: t(`utility.status.${s}`) }))}
          onChange={(status) =>
            // L'état se lit sur le plan : plein, tireté ou pointillé.
            set(
              { ...object, status, style: { ...object.style, dash: STATUS_DASH[status] } },
              'État de la ligne',
            )
          }
        />
        <SelectField
          label={t('utility.placement')}
          value={object.placement}
          disabled={disabled}
          options={UTILITY_PLACEMENTS.map((p) => ({ value: p, label: t(`utility.placement.${p}`) }))}
          onChange={(placement) => set({ ...object, placement }, 'Disposition de la ligne')}
        />
      </Row>
      <Row>
        <TextField
          label={t('utility.size')}
          value={object.nominalSize}
          disabled={disabled}
          onChange={(nominalSize) => set({ ...object, nominalSize }, 'Diamètre / calibre', 'nominalSize')}
        />
        <TextField
          label={t('utility.material')}
          value={object.material}
          disabled={disabled}
          onChange={(material) => set({ ...object, material }, 'Matériau', 'material')}
        />
      </Row>
      {object.placement === 'underground' && (
        <OptionalNumberField
          label={t('utility.depth')}
          value={object.depthMeters}
          min={0}
          placeholder={t('utility.depthUnknown')}
          disabled={disabled}
          onCommit={(depthMeters) => set({ ...object, depthMeters }, 'Profondeur')}
        />
      )}
      <TextField
        label={t('utility.notes')}
        multiline
        value={object.notes}
        disabled={disabled}
        onChange={(notes) => set({ ...object, notes }, 'Remarques', 'notes')}
      />
      <Toggle
        label={t('utility.showLabel')}
        checked={object.showLabel}
        disabled={disabled}
        onChange={(showLabel) =>
          set({ ...object, showLabel }, showLabel ? 'Afficher l’étiquette' : 'Masquer l’étiquette')
        }
      />
      {object.showLabel && (
        <p className="text-xs text-slate-600" data-testid="utility-label">
          {t('utility.label', { text: label })}
        </p>
      )}
      <Toggle
        label={t('utility.arrows')}
        checked={object.arrows.visible}
        disabled={disabled}
        onChange={(visible) =>
          setArrows({ visible }, visible ? 'Afficher le sens d’écoulement' : 'Masquer le sens d’écoulement')
        }
      />
      {object.arrows.visible && (
        <Button
          className="w-full"
          disabled={disabled || object.arrows.direction === 'both'}
          onClick={() =>
            setArrows(
              { direction: object.arrows.direction === 'forward' ? 'backward' : 'forward' },
              'Inverser le sens d’écoulement',
            )
          }
        >
          <ArrowLeftRight size={16} /> {t('utility.reverse')}
        </Button>
      )}
      <p className="text-xs text-slate-500">{t('utility.help')}</p>
    </Section>
  );
}
