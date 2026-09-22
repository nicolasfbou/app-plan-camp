import { ChevronsDown, ChevronsUp, ArrowDown, ArrowUp, Copy, PenLine, Trash2 } from 'lucide-react';
import { isEditable, layerOf } from '@/domain/model/operations.ts';
import { geometryBox, moveGeometryTo, resizeGeometry, normalizeAngle } from '@/domain/model/shapes.ts';
import type { PlanDocument, PlanObject, Style } from '@/domain/model/types.ts';
import { editActions } from '@/editor/editActions.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { usePlanStore } from '@/store/planStore.ts';
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

type TextObject = Extract<PlanObject, { type: 'text' }>;

export function PropertiesPanel() {
  const selectedId = useEditorStore((s) => s.selectedId);
  const object = usePlanStore((s) => (selectedId ? s.doc?.objects[selectedId] : undefined));
  const doc = usePlanStore((s) => s.doc);
  if (!object || !doc) return <p className="text-sm text-slate-500">{t('props.empty')}</p>;
  return <ObjectProperties key={object.id} object={object} doc={doc} />;
}

function typeLabel(object: PlanObject): string {
  if (object.type === 'text') return t(object.label ? 'objectType.label' : 'objectType.text');
  return t(`objectType.${object.type}`);
}

function ObjectProperties({ object, doc }: { object: PlanObject; doc: PlanDocument }) {
  const vertexEditing = useEditorStore((s) => s.vertexEditing);
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
          options={[...doc.layers].reverse().map((l) => ({ value: l.id, label: l.name }))}
          onChange={(layerId) => set({ ...object, layerId }, 'Changer de calque')}
        />
      </Row>

      <Section title={t('props.position')}>
        <Row>
          <NumberField
            label={t('props.x')}
            value={isText ? object.geometry.x : box.x}
            disabled={disabled}
            onCommit={(x) =>
              set(
                {
                  ...object,
                  geometry: moveGeometryTo(object.geometry, x, isText ? object.geometry.y : box.y),
                } as PlanObject,
                'Déplacer',
              )
            }
          />
          <NumberField
            label={t('props.y')}
            value={isText ? (object.geometry as { y: number }).y : box.y}
            disabled={disabled}
            onCommit={(y) =>
              set(
                {
                  ...object,
                  geometry: moveGeometryTo(
                    object.geometry,
                    isText ? (object.geometry as { x: number }).x : box.x,
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

      {isArea && (
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

      {!isText && (
        <Section title={t('props.stroke')}>
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
