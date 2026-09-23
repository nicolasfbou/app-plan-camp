import {
  ArrowDown,
  ArrowUp,
  ChevronsDown,
  ChevronsUp,
  Copy,
  Group,
  PenLine,
  Pentagon,
  Trash2,
  Ungroup,
  EyeOff,
  Palette,
  Undo2,
} from 'lucide-react';
import { isEditable, layerOf } from '@/domain/model/operations.ts';
import { geometryBox, moveGeometryTo, resizeGeometry, normalizeAngle } from '@/domain/model/shapes.ts';
import type { PlanDocument, PlanObject, Style } from '@/domain/model/types.ts';
import { editActions } from '@/editor/editActions.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';
import { resetLabelPlacement } from '@/domain/print/readabilityReviews.ts';
import { Button } from '@/ui/Button.tsx';
import {
  ColorField,
  NumberField,
  OpacityField,
  Row,
  Section,
  SelectField,
  TextField,
  Toggle,
} from './fields.tsx';
import { MeasureSection, ParkingGenerator, StallSection } from './MeasureProperties.tsx';
import { findZonePreset } from '@/domain/presets/zonePresets.ts';
import {
  CorridorProperties,
  DisplayLimits,
  FlowProperties,
  IconProperties,
  ZoneMarkerProperties,
} from './OperationalProperties.tsx';

type TextObject = Extract<PlanObject, { type: 'text' }>;

export function PropertiesPanel() {
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const doc = usePlanStore((s) => s.doc);
  const objects = doc
    ? selectedIds.map((id) => doc.objects[id]).filter((o): o is PlanObject => Boolean(o))
    : [];
  if (!doc || objects.length === 0) return <p className="text-sm text-slate-500">{t('props.empty')}</p>;
  return (
    <>
      <HideInView ids={objects.map((o) => o.id)} doc={doc} />
      {objects.length > 1 ? (
        <MultiProperties objects={objects} doc={doc} />
      ) : (
        <>
          <ObjectProperties key={objects[0]!.id} object={objects[0]!} doc={doc} />
          <CompanyStyle object={objects[0]!} />
          <LabelReset object={objects[0]!} />
        </>
      )}
    </>
  );
}

/** Étiquette écartée (proposition acceptée) : la remettre à sa place d'origine. */
function LabelReset({ object }: { object: PlanObject }) {
  const moved =
    (object.type === 'text' && object.leaderTo !== null) ||
    (object.type === 'zone' && object.nameOffset !== null);
  if (!moved) return null;
  return (
    <Button
      className="mt-3 w-full"
      data-testid="label-reset"
      onClick={() =>
        planStore
          .getState()
          .update('Remettre l’étiquette en place', (d) => void resetLabelPlacement(d, object.id))
      }
    >
      <Undo2 size={16} /> {t('labels.reset')}
    </Button>
  );
}

/**
 * Style d'entreprise : les couleurs, pointillés et hachures de cet objet deviennent ceux des
 * nouveaux objets du même modèle (enregistrés dans le plan, puis dans les modèles d'entreprise).
 */
function CompanyStyle({ object }: { object: PlanObject }) {
  if (!object.presetId || object.type === 'stall' || object.type === 'icon' || object.type === 'text')
    return null;
  return (
    <Button
      className="mt-3 w-full"
      data-testid="company-style"
      onClick={() => {
        planStore.getState().update('Style d’entreprise', (d) => {
          d.plan.styleOverrides[object.presetId!] = { ...object.style };
        });
        useEditorStore.getState().notify(t('templates.companyStyleSet', { name: object.name }));
      }}
    >
      <Palette size={16} /> {t('templates.companyStyle', { name: object.name })}
    </Button>
  );
}

/**
 * Vue par public affichée : masquer la sélection DANS CETTE VUE seulement (le plan de base et les
 * autres vues ne changent pas). Réaffichage depuis la mise en page (liste des éléments exclus).
 */
function HideInView({ ids, doc }: { ids: string[]; doc: PlanDocument }) {
  const viewId = useEditorStore((s) => s.activeViewId);
  const view = viewId ? doc.plan.views.find((v) => v.id === viewId) : undefined;
  if (!view) return null;
  return (
    <Button
      className="mb-3 w-full"
      data-testid="hide-in-view"
      onClick={() => {
        planStore.getState().update('Masquer dans la vue', (d) => {
          const v = d.plan.views.find((x) => x.id === view.id);
          if (v) v.print.excludedObjectIds = [...new Set([...v.print.excludedObjectIds, ...ids])];
        });
        useEditorStore.getState().select(null);
      }}
    >
      <EyeOff size={16} /> {t('views.hideObject', { name: view.name })}
    </Button>
  );
}

/** Sélection multiple : propriétés communes appliquées à tous les objets modifiables. */
function MultiProperties({ objects, doc }: { objects: PlanObject[]; doc: PlanDocument }) {
  const editable = objects.filter((o) => isEditable(doc, o));
  const disabled = editable.length === 0;
  const groupIds = new Set(objects.map((o) => o.groupId));
  const oneGroup = groupIds.size === 1 && objects[0]!.groupId !== null;
  const layerIds = new Set(objects.map((o) => o.layerId));
  const commonLayer = layerIds.size === 1 ? objects[0]!.layerId : '';
  const areas = objects.filter((o) => o.type === 'zone' || o.type === 'building');
  const same = <T,>(values: T[]): T | null =>
    values.every((v) => v === values[0]) ? (values[0] ?? null) : null;
  const allLocked = objects.every((o) => o.locked);

  return (
    <div className="space-y-3 text-sm" data-testid="properties-panel">
      <p className="font-medium text-slate-800" data-testid="selection-count">
        {oneGroup
          ? t('multi.grouped', { count: objects.length })
          : t('multi.count', { count: objects.length })}
      </p>
      <div className="flex gap-2">
        <Button className="flex-1" disabled={disabled || oneGroup} onClick={editActions.group}>
          <Group size={16} /> {t('multi.group')}
        </Button>
        <Button
          className="flex-1"
          disabled={disabled || objects.every((o) => !o.groupId)}
          onClick={editActions.ungroup}
        >
          <Ungroup size={16} /> {t('multi.ungroup')}
        </Button>
      </div>
      <SelectField
        label={t('props.layer')}
        value={commonLayer}
        disabled={disabled}
        options={[
          ...(commonLayer ? [] : [{ value: '', label: t('multi.mixed') }]),
          ...[...doc.layers]
            .reverse()
            .filter((l) => l.id === commonLayer || (l.visible && !l.locked))
            .map((l) => ({ value: l.id, label: l.name })),
        ]}
        onChange={(layerId) => layerId && editActions.setLayer(layerId)}
      />
      {areas.length > 0 && (
        <Section title={t('props.fill')}>
          <ColorField
            label={t('props.fill')}
            value={same(areas.map((o) => o.style.fill))}
            allowNone
            disabled={disabled}
            onChange={(fill) => editActions.setStyle({ fill }, 'fill')}
          />
        </Section>
      )}
      <Section title={t('props.stroke')}>
        <ColorField
          label={t('props.strokeColor')}
          value={same(objects.filter((o) => o.type !== 'text').map((o) => o.style.stroke))}
          disabled={disabled}
          onChange={(stroke) => editActions.setStyle({ stroke }, 'stroke')}
        />
      </Section>
      <Section title={t('props.visible')}>
        <Toggle
          label={t('props.locked')}
          checked={allLocked}
          onChange={(locked) => editActions.setLocked(locked)}
        />
      </Section>
      <div className="flex gap-2 border-t border-slate-200 pt-3">
        <Button className="flex-1" onClick={editActions.duplicateSelected}>
          <Copy size={16} /> {t('props.duplicate')}
        </Button>
        <Button
          className="flex-1"
          variant="danger"
          disabled={disabled}
          onClick={() => editActions.deleteSelected()}
        >
          <Trash2 size={16} /> {t('props.delete')}
        </Button>
      </div>
    </div>
  );
}

/** Zone de stationnement (modèle du groupe Stationnement, sauf « interdit »). */
function isParkingZone(object: PlanObject): boolean {
  const preset = object.presetId ? findZonePreset(object.presetId) : undefined;
  return preset?.group === 'parking' && object.presetId !== 'zone.no-parking';
}

function typeLabel(object: PlanObject): string {
  if (object.type === 'text') return t(object.label ? 'objectType.label' : 'objectType.text');
  return t(`objectType.${object.type}`);
}

function ObjectProperties({ object, doc }: { object: PlanObject; doc: PlanDocument }) {
  const vertexEditing = useEditorStore((s) => s.vertexEditing);
  const selectedVertex = useEditorStore((s) => s.selectedVertex);
  const editable = isEditable(doc, object);
  const layerLocked = layerOf(doc, object)?.locked ?? false;
  const disabled = !editable;

  /** Toute modification passe par ici : une action (ou fusionnée par champ via `field`). */
  const set = (next: PlanObject, label: string, field?: string) =>
    editActions.replace(next, label, field ? `${field}:${object.id}` : undefined);
  const setStyle = (patch: Partial<Style>, field?: string) =>
    set({ ...object, style: { ...object.style, ...patch } }, 'Modifier le style', field);

  const box = geometryBox(object.geometry);
  const isText = object.type === 'text';
  const isArea = object.type === 'zone' || object.type === 'building';
  const isPoint = object.geometry.kind === 'point';
  const hasFill = isArea || object.type === 'corridor';
  const hasStroke = !isText && object.type !== 'icon';
  const hasPoints = object.geometry.kind === 'polygon' || object.geometry.kind === 'polyline';

  return (
    <div className="space-y-3 text-sm" data-testid="properties-panel">
      <TextField
        label={t('props.name')}
        value={object.name}
        disabled={disabled}
        onChange={(name) => set({ ...object, name }, 'Renommer', 'name')}
      />
      <Row>
        <div>
          <div className="mb-0.5 text-xs text-slate-600">{t('props.type')}</div>
          <div className="py-1" data-testid="object-type">
            {typeLabel(object)}
          </div>
        </div>
        <SelectField
          label={t('props.layer')}
          value={object.layerId}
          disabled={disabled}
          options={[...doc.layers]
            .reverse()
            .filter((l) => l.id === object.layerId || (l.visible && !l.locked))
            .map((l) => ({ value: l.id, label: l.name }))}
          onChange={(layerId) => editActions.setLayer(layerId)}
        />
      </Row>

      <Section title={t('props.position')}>
        <Row>
          <NumberField
            label={t('props.x')}
            value={isPoint ? (object.geometry as { x: number }).x : box.x}
            disabled={disabled}
            onCommit={(x) =>
              set(
                {
                  ...object,
                  geometry: moveGeometryTo(
                    object.geometry,
                    x,
                    isPoint ? (object.geometry as { y: number }).y : box.y,
                  ),
                } as PlanObject,
                'Déplacer',
              )
            }
          />
          <NumberField
            label={t('props.y')}
            value={isPoint ? (object.geometry as { y: number }).y : box.y}
            disabled={disabled}
            onCommit={(y) =>
              set(
                {
                  ...object,
                  geometry: moveGeometryTo(
                    object.geometry,
                    isPoint ? (object.geometry as { x: number }).x : box.x,
                    y,
                  ),
                } as PlanObject,
                'Déplacer',
              )
            }
          />
        </Row>
        {isArea && (
          <Row>
            <NumberField
              label={t('props.width')}
              value={box.width}
              min={1}
              disabled={disabled}
              onCommit={(w) =>
                set(
                  { ...object, geometry: resizeGeometry(object.geometry, w, box.height) } as PlanObject,
                  'Redimensionner',
                )
              }
            />
            <NumberField
              label={t('props.height')}
              value={box.height}
              min={1}
              disabled={disabled}
              onCommit={(h) =>
                set(
                  { ...object, geometry: resizeGeometry(object.geometry, box.width, h) } as PlanObject,
                  'Redimensionner',
                )
              }
            />
          </Row>
        )}
        <Row>
          <NumberField
            label={t('props.rotation')}
            value={object.rotation}
            disabled={disabled}
            onCommit={(r) => set({ ...object, rotation: normalizeAngle(r) }, 'Pivoter')}
          />
          {object.geometry.kind === 'rect' && (
            <NumberField
              label={t('props.cornerRadius')}
              value={object.geometry.cornerRadius}
              min={0}
              disabled={disabled}
              onCommit={(cornerRadius) =>
                set(
                  { ...object, geometry: { ...object.geometry, cornerRadius } } as PlanObject,
                  'Modifier le style',
                )
              }
            />
          )}
        </Row>
      </Section>

      {object.type === 'flow' && <FlowProperties object={object} disabled={disabled} set={set} />}
      {object.type === 'corridor' && (
        <CorridorProperties object={object} doc={doc} disabled={disabled} set={set} />
      )}
      {object.type === 'icon' && <IconProperties object={object} doc={doc} disabled={disabled} set={set} />}

      {hasFill && (
        <Section title={t('props.fill')}>
          <ColorField
            label={t('props.fill')}
            value={object.style.fill}
            allowNone
            disabled={disabled}
            onChange={(fill) => setStyle({ fill }, 'fill')}
          />
          <OpacityField
            label={t('props.fillOpacity')}
            value={object.style.fillOpacity}
            disabled={disabled || !object.style.fill}
            onChange={(fillOpacity) => setStyle({ fillOpacity }, 'fillOpacity')}
          />
        </Section>
      )}

      {object.type === 'zone' && (
        <ZoneMarkerProperties object={object} doc={doc} disabled={disabled} set={set} />
      )}
      {object.type === 'zone' && isParkingZone(object) && (
        <ParkingGenerator
          key={doc.plan.calibration ? 'm' : 'px'}
          zone={object}
          doc={doc}
          disabled={disabled}
        />
      )}
      {object.type === 'stall' && <StallSection stall={object} doc={doc} disabled={disabled} set={set} />}
      <MeasureSection object={object} doc={doc} />

      {hasStroke && (
        <Section
          title={object.type === 'flow' || object.type === 'line' ? t('props.line') : t('props.stroke')}
        >
          <ColorField
            label={t('props.strokeColor')}
            value={object.style.stroke}
            allowNone={isArea}
            disabled={disabled}
            onChange={(stroke) => setStyle({ stroke }, 'stroke')}
          />
          <OpacityField
            label={t('props.strokeOpacity')}
            value={object.style.strokeOpacity}
            disabled={disabled || !object.style.stroke}
            onChange={(strokeOpacity) => setStyle({ strokeOpacity }, 'strokeOpacity')}
          />
          <Row>
            <NumberField
              label={t('props.strokeWidth')}
              value={object.style.strokeWidth}
              min={0}
              disabled={disabled}
              onCommit={(strokeWidth) => setStyle({ strokeWidth })}
            />
            <SelectField
              label={t('props.dash')}
              value={object.style.dash}
              disabled={disabled}
              options={(['solid', 'dashed', 'dotted'] as const).map((d) => ({
                value: d,
                label: t(`props.dash.${d}`),
              }))}
              onChange={(dash) => setStyle({ dash })}
            />
          </Row>
        </Section>
      )}

      {object.type === 'text' && <TextProperties object={object} disabled={disabled} set={set} />}

      {(object.type === 'flow' ||
        object.type === 'corridor' ||
        object.type === 'icon' ||
        (object.type === 'zone' && object.icon)) && <DisplayLimits display={doc.plan.display} />}

      <Section title={t('props.visible')}>
        <div className="flex gap-4">
          <Toggle
            label={t('props.visible')}
            checked={object.visible}
            onChange={(visible) => set({ ...object, visible }, visible ? 'Afficher' : 'Masquer')}
          />
          <Toggle
            label={t('props.locked')}
            checked={object.locked}
            onChange={(locked) => set({ ...object, locked }, locked ? 'Verrouiller' : 'Déverrouiller')}
          />
        </div>
        {object.locked && <p className="text-xs text-amber-700">{t('props.lockedHint')}</p>}
        {!object.locked && layerLocked && (
          <p className="text-xs text-amber-700">{t('props.layerLockedHint')}</p>
        )}
      </Section>

      <Section title={t('props.order')}>
        <div className="flex gap-1">
          <Button
            className="flex-1 px-1"
            disabled={disabled}
            title={t('props.front')}
            aria-label={t('props.front')}
            onClick={() => editActions.reorder('front')}
          >
            <ChevronsUp size={16} />
          </Button>
          <Button
            className="flex-1 px-1"
            disabled={disabled}
            title={t('props.forward')}
            aria-label={t('props.forward')}
            onClick={() => editActions.reorder('forward')}
          >
            <ArrowUp size={16} />
          </Button>
          <Button
            className="flex-1 px-1"
            disabled={disabled}
            title={t('props.backward')}
            aria-label={t('props.backward')}
            onClick={() => editActions.reorder('backward')}
          >
            <ArrowDown size={16} />
          </Button>
          <Button
            className="flex-1 px-1"
            disabled={disabled}
            title={t('props.back')}
            aria-label={t('props.back')}
            onClick={() => editActions.reorder('back')}
          >
            <ChevronsDown size={16} />
          </Button>
        </div>
      </Section>

      <div className="space-y-2 border-t border-slate-200 pt-3">
        {hasPoints && (
          <Button
            className="w-full"
            disabled={disabled}
            aria-pressed={vertexEditing}
            onClick={() => useEditorStore.getState().setVertexEditing(!vertexEditing)}
          >
            <PenLine size={16} /> {vertexEditing ? t('props.stopEditPoints') : t('props.editPoints')}
          </Button>
        )}
        {hasPoints && vertexEditing && (
          <div className="space-y-2 rounded-md bg-slate-100 p-2">
            <p className="text-xs text-slate-600">{t('vertex.help')}</p>
            <Button
              className="w-full"
              disabled={disabled || selectedVertex === null}
              onClick={() => editActions.deleteSelectedVertex()}
            >
              <Trash2 size={16} /> {t('vertex.delete')}
            </Button>
          </div>
        )}
        {object.type === 'line' && object.geometry.points.length >= 3 && (
          <Button className="w-full" disabled={disabled} onClick={editActions.closeSelectedPolyline}>
            <Pentagon size={16} /> {t('vertex.close')}
          </Button>
        )}
        {object.geometry.kind === 'rect' && (object.type === 'zone' || object.type === 'building') && (
          <Button className="w-full" disabled={disabled} onClick={editActions.convertSelectedToPolygon}>
            <Pentagon size={16} /> {t('vertex.toPolygon')}
          </Button>
        )}
        {object.groupId && (
          <Button className="w-full" disabled={disabled} onClick={editActions.ungroup}>
            <Ungroup size={16} /> {t('multi.ungroup')}
          </Button>
        )}
        <div className="flex gap-2">
          <Button className="flex-1" onClick={editActions.duplicateSelected}>
            <Copy size={16} /> {t('props.duplicate')}
          </Button>
          <Button
            className="flex-1"
            variant="danger"
            disabled={disabled}
            onClick={() => editActions.deleteSelected()}
          >
            <Trash2 size={16} /> {t('props.delete')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TextProperties({
  object,
  disabled,
  set,
}: {
  object: TextObject;
  disabled: boolean;
  set(next: PlanObject, label: string, field?: string): void;
}) {
  const label = object.label;
  const setLabel = (patch: Partial<NonNullable<TextObject['label']>>, field?: string) =>
    label && set({ ...object, label: { ...label, ...patch } }, 'Modifier l’étiquette', field);
  return (
    <>
      <Section title={t('props.text')}>
        <TextField
          label={t('props.text')}
          multiline
          value={object.text}
          disabled={disabled}
          onChange={(text) => set({ ...object, text }, 'Modifier le texte', 'text')}
        />
        <Row>
          <NumberField
            label={t('props.fontSize')}
            value={object.fontSize}
            min={1}
            disabled={disabled}
            onCommit={(fontSize) => set({ ...object, fontSize }, 'Taille du texte')}
          />
          <SelectField
            label={t('props.align')}
            value={object.align}
            disabled={disabled}
            options={(['left', 'center', 'right'] as const).map((a) => ({
              value: a,
              label: t(`props.align.${a}`),
            }))}
            onChange={(align) => set({ ...object, align }, 'Alignement')}
          />
        </Row>
        <div className="flex gap-4">
          <Toggle
            label={t('props.bold')}
            checked={object.fontWeight === 'bold'}
            disabled={disabled}
            onChange={(b) => set({ ...object, fontWeight: b ? 'bold' : 'normal' }, 'Gras')}
          />
          <Toggle
            label={t('props.italic')}
            checked={object.italic}
            disabled={disabled}
            onChange={(italic) => set({ ...object, italic }, 'Italique')}
          />
        </div>
        <ColorField
          label={t('props.textColor')}
          value={object.style.fill}
          disabled={disabled}
          onChange={(fill) =>
            set(
              { ...object, style: { ...object.style, fill: fill ?? '#000000' } },
              'Couleur du texte',
              'textColor',
            )
          }
        />
      </Section>
      {label && (
        <Section title={t('props.labelBackground')}>
          <ColorField
            label={t('props.labelBackground')}
            value={label.background}
            disabled={disabled}
            onChange={(background) => setLabel({ background: background ?? '#ffffff' }, 'labelBg')}
          />
          <OpacityField
            label={t('props.labelOpacity')}
            value={label.backgroundOpacity}
            disabled={disabled}
            onChange={(backgroundOpacity) => setLabel({ backgroundOpacity }, 'labelOpacity')}
          />
          <ColorField
            label={t('props.border')}
            value={label.border}
            allowNone
            disabled={disabled}
            onChange={(border) => setLabel({ border }, 'labelBorder')}
          />
          <Row>
            <NumberField
              label={t('props.borderWidth')}
              value={label.borderWidth}
              min={0}
              disabled={disabled}
              onCommit={(borderWidth) => setLabel({ borderWidth })}
            />
            <NumberField
              label={t('props.padding')}
              value={label.padding}
              min={0}
              disabled={disabled}
              onCommit={(padding) => setLabel({ padding })}
            />
          </Row>
          <NumberField
            label={t('props.radius')}
            value={label.cornerRadius}
            min={0}
            disabled={disabled}
            onCommit={(cornerRadius) => setLabel({ cornerRadius })}
          />
        </Section>
      )}
    </>
  );
}
