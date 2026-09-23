/**
 * Réglages de mise en page enregistrés dans le plan : page, contenu, éléments, calques, légende et
 * cartouche. Chaque modification est une action annulable du plan (et voyage dans le .campplan).
 */
import { ImageUp, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { repository } from '@/app/repository.ts';
import { newId, nowIso } from '@/domain/model/factories.ts';
import type {
  LegendSettings,
  PlanDocument,
  PlanStatus,
  PrintSettings,
  TitleBlock,
} from '@/domain/model/types.ts';
import { legendEntries } from '@/domain/print/legend.ts';
import { editableSettings } from '@/domain/print/views.ts';
import { PAPER } from '@/domain/print/paper.ts';
import { setPlanStatus, STATUS_LABELS } from '@/domain/print/titleBlock.ts';
import { checkSymbolFile, MAX_SYMBOL_BYTES } from '@/domain/symbols/importSymbol.ts';
import { formatDateTime, t, type MessageKey } from '@/i18n/index.ts';
import { NumberField, Row, Section, SelectField, TextField, Toggle } from '@/panels/fields.tsx';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore } from '@/store/planStore.ts';
import { Button } from '@/ui/Button.tsx';
import { Modal } from '@/ui/Modal.tsx';

const update = (label: string, recipe: (d: PlanDocument) => void, mergeKey?: string) =>
  planStore.getState().update(label, recipe, mergeKey ? { mergeKey } : undefined);

/** Réglages de la vue sélectionnée (ou du plan de base si `viewId` est null). */
const setPrint = (
  viewId: string | null,
  label: string,
  recipe: (p: PrintSettings) => void,
  mergeKey?: string,
) => update(label, (d) => recipe(editableSettings(d, viewId).print), mergeKey);
const setLegend = (
  viewId: string | null,
  label: string,
  recipe: (l: LegendSettings) => void,
  mergeKey?: string,
) => update(label, (d) => recipe(editableSettings(d, viewId).legend), mergeKey);
const setBlock = (label: string, recipe: (b: TitleBlock) => void, mergeKey?: string) =>
  update(
    label,
    (d) => {
      recipe(d.plan.titleBlock);
      d.plan.updatedAt = nowIso();
    },
    mergeKey,
  );

export type OutputFormat = 'pdf' | 'png' | 'jpeg';

export function PageSettings({
  doc,
  output,
  viewId,
}: {
  doc: PlanDocument;
  output: OutputFormat;
  viewId: string | null;
}) {
  const { print } = editableSettings(doc, viewId);
  return (
    <Section title={t('print.page')}>
      <Row>
        <SelectField
          label={t('print.paper')}
          value={print.paper}
          options={Object.entries(PAPER).map(([value, p]) => ({
            value: value as PrintSettings['paper'],
            label: p.name,
          }))}
          onChange={(paper) => setPrint(viewId, 'Format de page', (p) => void (p.paper = paper))}
        />
        <SelectField
          label={t('print.orientation')}
          value={print.orientation}
          options={[
            { value: 'landscape', label: t('print.orientation.landscape') },
            { value: 'portrait', label: t('print.orientation.portrait') },
          ]}
          onChange={(orientation) =>
            setPrint(viewId, 'Orientation', (p) => void (p.orientation = orientation))
          }
        />
      </Row>
      <SelectField
        label={t('print.mode')}
        value={print.mode}
        options={(['complete', 'simplified', 'annotations'] as const).map((value) => ({
          value,
          label: t(`print.mode.${value}`),
        }))}
        onChange={(mode) => setPrint(viewId, 'Contenu exporté', (p) => void (p.mode = mode))}
      />
      {print.mode === 'annotations' && output === 'png' && (
        <SelectField
          label={t('print.background')}
          value={print.background}
          options={[
            { value: 'white', label: t('print.background.white') },
            { value: 'transparent', label: t('print.background.transparent') },
          ]}
          onChange={(background) => setPrint(viewId, 'Fond de page', (p) => void (p.background = background))}
        />
      )}
      <SelectField
        label={t('print.extent')}
        value={print.extent}
        options={[
          { value: 'image', label: t('print.extent.image') },
          { value: 'annotations', label: t('print.extent.annotations') },
        ]}
        onChange={(extent) => setPrint(viewId, 'Cadrage', (p) => void (p.extent = extent))}
      />
      <Row>
        <NumberField
          label={t('print.margin')}
          value={print.marginMm}
          min={0}
          digits={0}
          onCommit={(v) => setPrint(viewId, 'Marges', (p) => void (p.marginMm = Math.min(50, v)))}
        />
        <NumberField
          label={t('print.dpi')}
          value={print.dpi}
          min={72}
          step={25}
          digits={0}
          onCommit={(v) =>
            setPrint(viewId, 'Résolution', (p) => void (p.dpi = Math.min(600, Math.max(72, Math.round(v)))))
          }
        />
      </Row>
      <label className="block text-xs text-slate-600">
        <span className="flex justify-between">
          <span>{t('print.quality')}</span>
          <span className="tabular-nums">{Math.round(print.jpegQuality * 100)} %</span>
        </span>
        <input
          type="range"
          min={40}
          max={100}
          value={Math.round(print.jpegQuality * 100)}
          onChange={(e) =>
            setPrint(
              viewId,
              'Qualité JPEG',
              (p) => void (p.jpegQuality = Number(e.target.value) / 100),
              `print-quality-${viewId ?? 'base'}`,
            )
          }
          className="w-full accent-accent"
        />
      </label>
    </Section>
  );
}

const INCLUDES = [
  'title',
  'legend',
  'titleBlock',
  'logo',
  'north',
  'scaleBar',
  'date',
  'revision',
  'notes',
] as const;

export function ElementSettings({ doc, viewId }: { doc: PlanDocument; viewId: string | null }) {
  const { print } = editableSettings(doc, viewId);
  const include = print.include;
  return (
    <Section title={t('print.elements')}>
      <div className="grid grid-cols-2 gap-1">
        {INCLUDES.map((key) => (
          <Toggle
            key={key}
            label={t(`print.include.${key}` as MessageKey)}
            checked={include[key]}
            disabled={key === 'titleBlock' && print.mode === 'simplified'}
            onChange={(v) => setPrint(viewId, 'Éléments exportés', (p) => void (p.include[key] = v))}
          />
        ))}
      </div>
    </Section>
  );
}

export function LayerSettings({ doc, viewId }: { doc: PlanDocument; viewId: string | null }) {
  const excluded = new Set(editableSettings(doc, viewId).print.excludedLayerIds);
  return (
    <Section title={t('print.layers')}>
      <ul className="space-y-1" data-testid="print-layers">
        {[...doc.layers].reverse().map((layer) => (
          <li key={layer.id}>
            <Toggle
              label={`${layer.name}${layer.visible ? '' : ` ${t('print.layerHidden')}`}`}
              checked={layer.visible && !excluded.has(layer.id)}
              disabled={!layer.visible}
              onChange={(on) =>
                setPrint(viewId, 'Calques exportés', (p) => {
                  p.excludedLayerIds = on
                    ? p.excludedLayerIds.filter((id) => id !== layer.id)
                    : [...p.excludedLayerIds, layer.id];
                })
              }
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function LegendSettingsSection({ doc, viewId }: { doc: PlanDocument; viewId: string | null }) {
  const { legend, print } = editableSettings(doc, viewId);
  const entries = legendEntries(doc, print.excludedLayerIds, print.excludedObjectIds, print.detail);
  const hidden = new Set(legend.hidden);
  return (
    <Section title={t('print.legend')}>
      <Row>
        <SelectField
          label={t('print.legend.placement')}
          value={legend.placement}
          options={(
            ['side', 'map-auto', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
          ).map((value) => ({
            value,
            label: t(`print.legend.placement.${value}`),
          }))}
          onChange={(placement) =>
            setLegend(viewId, 'Position de la légende', (l) => void (l.placement = placement))
          }
        />
        <SelectField
          label={t('print.legend.mode')}
          value={legend.mode}
          options={[
            { value: 'detailed', label: t('print.legend.mode.detailed') },
            { value: 'compact', label: t('print.legend.mode.compact') },
          ]}
          onChange={(mode) => setLegend(viewId, 'Présentation de la légende', (l) => void (l.mode = mode))}
        />
      </Row>
      <label className="block text-xs text-slate-600">
        <span className="flex justify-between">
          <span>{t('print.legend.size')}</span>
          <span className="tabular-nums">{Math.round(legend.sizeFactor * 100)} %</span>
        </span>
        <input
          type="range"
          min={50}
          max={250}
          step={5}
          value={Math.round(legend.sizeFactor * 100)}
          onChange={(e) =>
            setLegend(
              viewId,
              'Taille de la légende',
              (l) => void (l.sizeFactor = Number(e.target.value) / 100),
              `legend-size-${viewId ?? 'base'}`,
            )
          }
          className="w-full accent-accent"
          data-testid="legend-size"
        />
      </label>
      <TextField
        label={t('print.legend.heading')}
        value={legend.title}
        onChange={(title) =>
          setLegend(
            viewId,
            'Titre de la légende',
            (l) => void (l.title = title),
            `legend-title-${viewId ?? 'base'}`,
          )
        }
      />
      <p className="text-xs font-medium text-slate-600">
        {t('print.legend.entries', { count: entries.length })}
      </p>
      {entries.length === 0 && <p className="text-xs text-slate-500">{t('print.legend.none')}</p>}
      <ul className="space-y-1.5" data-testid="legend-entries">
        {entries.map((entry) => (
          <li key={entry.key} className="flex items-center gap-2" data-legend-key={entry.key}>
            <input
              type="checkbox"
              className="accent-accent"
              aria-label={t('print.legend.show', { label: entry.defaultLabel })}
              checked={!hidden.has(entry.key)}
              onChange={(e) =>
                setLegend(viewId, 'Catégories de la légende', (l) => {
                  l.hidden = e.target.checked
                    ? l.hidden.filter((k) => k !== entry.key)
                    : [...l.hidden, entry.key];
                })
              }
            />
            <input
              className="min-w-0 flex-1 rounded border border-slate-300 px-1.5 py-0.5 text-xs"
              aria-label={t('print.legend.label', { label: entry.defaultLabel })}
              placeholder={entry.defaultLabel}
              value={legend.labels[entry.key] ?? ''}
              onChange={(e) =>
                setLegend(
                  viewId,
                  'Intitulé de légende',
                  (l) => {
                    if (e.target.value) l.labels[entry.key] = e.target.value;
                    else delete l.labels[entry.key];
                  },
                  `legend-label-${viewId ?? 'base'}-${entry.key}`,
                )
              }
            />
            <span className="w-6 text-right text-xs text-slate-500 tabular-nums">{entry.count}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const TB_FIELDS = [
  'campName',
  'title',
  'client',
  'company',
  'preparedBy',
  'checkedBy',
  'date',
  'planNumber',
  'revision',
] as const;

export function TitleBlockSection({ doc, viewId }: { doc: PlanDocument; viewId: string | null }) {
  const view = viewId ? doc.plan.views.find((v) => v.id === viewId) : undefined;
  const block = doc.plan.titleBlock;
  const [approving, setApproving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const logo = block.logoAssetId ? doc.assets[block.logoAssetId] : undefined;

  const chooseStatus = (status: PlanStatus) => {
    if (status === 'approved') {
      setApproving(true); // choix explicite, confirmé dans une boîte dédiée
      return;
    }
    update('Statut du plan', (d) => setPlanStatus(d, status, null));
  };

  const importLogo = async (file: File) => {
    const notify = useEditorStore.getState().notify;
    if (file.size > MAX_SYMBOL_BYTES) {
      notify(t('print.tb.logoRejected', { reason: 'fichier trop volumineux (2 Mo au maximum).' }));
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkSymbolFile(bytes, file.name);
    if (!check.ok) {
      notify(t('print.tb.logoRejected', { reason: check.reason }));
      return;
    }
    try {
      const stored = await repository.putBlob(bytes.slice().buffer, check.mimeType);
      const id = newId();
      update('Logo du cartouche', (d) => {
        d.assets[id] = {
          id,
          name: `Logo — ${file.name.replace(/\.(png|svg)$/i, '')}`,
          blobId: stored.id,
          mimeType: check.mimeType,
          byteLength: stored.byteLength,
          sha256: stored.sha256,
          createdAt: nowIso(),
        };
        d.plan.titleBlock.logoAssetId = id;
      });
    } catch (error) {
      notify(t('print.tb.logoRejected', { reason: error instanceof Error ? error.message : String(error) }));
    }
  };

  return (
    <Section title={t('print.titleBlock')}>
      <SelectField
        label={t('print.tb.placement')}
        value={view ? view.titleBlockPlacement : block.placement}
        options={[
          { value: 'side', label: t('print.tb.placement.side') },
          { value: 'bottom', label: t('print.tb.placement.bottom') },
        ]}
        onChange={(placement) =>
          view
            ? update('Position du cartouche', (d) => {
                const v = d.plan.views.find((x) => x.id === view.id);
                if (v) v.titleBlockPlacement = placement;
              })
            : setBlock('Position du cartouche', (b) => void (b.placement = placement))
        }
      />
      <SelectField
        label={t('print.tb.status')}
        value={block.status}
        options={(Object.keys(STATUS_LABELS) as PlanStatus[]).map((value) => ({
          value,
          label: STATUS_LABELS[value],
        }))}
        onChange={chooseStatus}
      />
      {block.status === 'approved' && block.approvedAt && (
        <p className="text-xs text-emerald-800" data-testid="approval-info">
          {t('print.tb.approvedBy', { name: block.approvedBy, date: formatDateTime(block.approvedAt) })}
        </p>
      )}
      {TB_FIELDS.map((key) => (
        <TextField
          key={key}
          label={t(`print.tb.${key}` as MessageKey)}
          value={block[key]}
          onChange={(value) => setBlock('Cartouche', (b) => void (b[key] = value), `tb-${key}`)}
        />
      ))}
      <TextField
        label={t('print.tb.notes')}
        value={block.notes}
        multiline
        onChange={(notes) => setBlock('Cartouche', (b) => void (b.notes = notes), 'tb-notes')}
      />
      <div>
        <p className="mb-1 text-xs text-slate-600">{t('print.tb.logo')}</p>
        <div className="flex items-center gap-2">
          <Button onClick={() => fileInput.current?.click()}>
            <ImageUp size={16} /> {logo ? logo.name : t('print.tb.logoAdd')}
          </Button>
          {logo && (
            <Button
              aria-label={t('print.tb.logoRemove')}
              title={t('print.tb.logoRemove')}
              onClick={() => setBlock('Retirer le logo', (b) => void (b.logoAssetId = null))}
            >
              <Trash2 size={16} />
            </Button>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".png,.svg,image/png,image/svg+xml"
          className="hidden"
          data-testid="logo-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void importLogo(file);
          }}
        />
      </div>
      {approving && <ApprovalDialog initialName={block.approvedBy} onClose={() => setApproving(false)} />}
    </Section>
  );
}

/** Approbation : nom de l'approbateur + confirmation explicite d'autorisation. */
function ApprovalDialog({ initialName, onClose }: { initialName: string; onClose(): void }) {
  const [name, setName] = useState(initialName);
  const [confirmed, setConfirmed] = useState(false);
  const valid = confirmed && name.trim() !== '';
  return (
    <Modal
      open
      title={t('print.approve.title')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => {
              update('Approuver le plan', (d) =>
                setPlanStatus(d, 'approved', { confirmed, approvedBy: name }),
              );
              onClose();
            }}
          >
            {t('print.approve.action')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p>{t('print.approve.body')}</p>
        <TextField label={t('print.approve.name')} value={name} onChange={setName} />
        <Toggle label={t('print.approve.confirm')} checked={confirmed} onChange={setConfirmed} />
      </div>
    </Modal>
  );
}
