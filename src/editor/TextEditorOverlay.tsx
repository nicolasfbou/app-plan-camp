import { useEffect, useRef, useState } from 'react';
import { removeObject, replaceObject } from '@/domain/model/operations.ts';
import type { PlanObject } from '@/domain/model/types.ts';
import { imageToScreen } from '@/domain/viewport/viewport.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore, usePlanStore } from '@/store/planStore.ts';
import { useViewportStore } from '@/store/viewportStore.ts';
import { measureText, rgba } from './objects/konvaStyle.ts';

type TextObject = Extract<PlanObject, { type: 'text' }>;

/**
 * Édition directe d'un texte ou d'une étiquette : un champ HTML est superposé exactement au texte
 * (position, taille et rotation calculées depuis les coordonnées image et le zoom courant).
 * Entrée valide, Maj+Entrée ajoute une ligne, Échap annule. Un texte vidé est supprimé.
 */
export function TextEditorOverlay() {
  const editingId = useEditorStore((s) => s.editingTextId);
  const object = usePlanStore((s) => (editingId ? s.doc?.objects[editingId] : undefined));
  if (!editingId || !object || object.type !== 'text') return null;
  return <TextField key={editingId} object={object} />;
}

function close() {
  useEditorStore.getState().setEditingText(null);
}

function TextField({ object }: { object: TextObject }) {
  const viewport = useViewportStore((s) => s.viewport);
  const [value, setValue] = useState(object.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const text = value.replace(/\s+$/, '');
    if (!text.trim()) {
      // Un texte vide n'a pas de sens : il est retiré.
      planStore.getState().update('Supprimer', (d) => removeObject(d, object.id));
      useEditorStore.getState().select(null);
    } else if (text !== object.text) {
      planStore.getState().update('Modifier le texte', (d) => replaceObject(d, { ...object, text }));
    }
    close();
  };

  const preview = measureText({ ...object, text: value || ' ' });
  const center = imageToScreen(viewport, object.geometry);
  const s = viewport.scale;
  const label = object.label;

  return (
    <textarea
      ref={ref}
      aria-label={t('text.editor')}
      data-testid="text-editor"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          done.current = true;
          close();
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit();
        }
      }}
      style={{
        position: 'absolute',
        left: center.x,
        top: center.y,
        width: Math.max(preview.width * s + 8, 40),
        height: preview.height * s + 4,
        transform: `translate(-50%, -50%) rotate(${object.rotation}deg)`,
        fontFamily: object.fontFamily,
        fontSize: object.fontSize * s,
        fontWeight: object.fontWeight,
        fontStyle: object.italic ? 'italic' : 'normal',
        lineHeight: 1.2,
        textAlign: object.align,
        color: rgba(object.style.fill ?? '#000000', object.style.fillOpacity),
        background: label ? rgba(label.background, label.backgroundOpacity) : 'rgba(255,255,255,0.6)',
        padding: label ? label.padding * s : 0,
        border: `${Math.max(1, (label?.borderWidth ?? 0) * s)}px solid ${label?.border ?? '#2563eb'}`,
        borderRadius: label ? label.cornerRadius * s : 2,
        outline: '2px solid #2563eb',
        outlineOffset: 2,
        resize: 'none',
        overflow: 'hidden',
        whiteSpace: 'pre',
        boxSizing: 'border-box',
        zIndex: 20,
      }}
    />
  );
}
