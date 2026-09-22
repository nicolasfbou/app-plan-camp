import {
  Circle,
  Hand,
  type LucideIcon,
  MousePointer2,
  Pentagon,
  Slash,
  Spline,
  Square,
  Squircle,
  Tag,
  TentTree,
  Type,
} from 'lucide-react';
import { BUILDING_PRESETS, ZONE_PRESETS, type ZonePreset } from '@/domain/presets/zonePresets.ts';
import { type MessageKey, t } from '@/i18n/index.ts';
import { AREA_TOOLS, type Tool, useEditorStore } from '@/store/editorStore.ts';
import { useUiStore } from '@/store/uiStore.ts';
import { TOOL_KEYS } from '@/editor/useEditorShortcuts.ts';
import { routeHref } from './router.ts';

const TOOLS: { tool: Tool; icon: LucideIcon; hint: MessageKey }[] = [
  { tool: 'select', icon: MousePointer2, hint: 'tools.hint.select' },
  { tool: 'hand', icon: Hand, hint: 'tools.hint.hand' },
  { tool: 'rect', icon: Square, hint: 'tools.hint.box' },
  { tool: 'roundedRect', icon: Squircle, hint: 'tools.hint.box' },
  { tool: 'ellipse', icon: Circle, hint: 'tools.hint.box' },
  { tool: 'polygon', icon: Pentagon, hint: 'tools.hint.polygon' },
  { tool: 'line', icon: Slash, hint: 'tools.hint.line' },
  { tool: 'polyline', icon: Spline, hint: 'tools.hint.polyline' },
  { tool: 'text', icon: Type, hint: 'tools.hint.text' },
  { tool: 'label', icon: Tag, hint: 'tools.hint.text' },
];

const keyOf = (tool: Tool) =>
  Object.entries(TOOL_KEYS)
    .find(([, v]) => v === tool)?.[0]
    ?.toUpperCase() ?? '';

/** Barre latérale foncée. Dans l'éditeur, elle contient les outils réellement disponibles. */
export function LeftSidebar({ showTools }: { showTools: boolean }) {
  const collapsed = useUiStore((s) => s.leftCollapsed);
  if (collapsed) return null;

  return (
    <aside
      className="flex h-full min-h-0 w-60 shrink-0 flex-col overflow-y-auto bg-sidebar text-slate-200"
      data-testid="left-sidebar"
    >
      <a
        href={routeHref({ name: 'camps' })}
        className="flex items-center gap-2 border-b border-white/10 px-4 py-3"
      >
        <TentTree size={22} className="text-white" aria-hidden />
        <div>
          <div className="text-base font-semibold text-white">{t('app.name')}</div>
          <div className="text-xs text-slate-400">{t('app.tagline')}</div>
        </div>
      </a>
      <nav className="px-2 py-2">
        <a
          href={routeHref({ name: 'camps' })}
          className="block rounded-md px-3 py-2 text-sm hover:bg-white/10"
        >
          {t('nav.camps')}
        </a>
      </nav>
      {showTools && <ToolPalette />}
    </aside>
  );
}

function ToolPalette() {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const active = TOOLS.find((entry) => entry.tool === tool);

  return (
    <>
      <section className="border-t border-white/10 px-3 py-3">
        <h2 className="px-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
          {t('tools.title')}
        </h2>
        <div role="toolbar" aria-label={t('tools.title')} className="mt-2 grid grid-cols-5 gap-1">
          {TOOLS.map(({ tool: id, icon: Icon }) => {
            const label = t(`tools.${id}`);
            return (
              <button
                key={id}
                type="button"
                aria-pressed={tool === id}
                aria-label={label}
                title={t('tools.shortcut', { name: label, key: keyOf(id) })}
                onClick={() => setTool(id)}
                className={`flex h-9 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-white ${
                  tool === id ? 'bg-accent text-white' : 'text-slate-300 hover:bg-white/10'
                }`}
              >
                <Icon size={18} aria-hidden />
              </button>
            );
          })}
        </div>
        {active && (
          <p className="mt-2 px-1 text-xs text-slate-300" data-testid="tool-hint">
            <strong className="text-white">{t(`tools.${active.tool}`)}</strong> · {t(active.hint)}
          </p>
        )}
        <p className="mt-2 px-1 text-xs text-slate-500">{t('tools.navigation')}</p>
      </section>
      <PresetList />
    </>
  );
}

function PresetList() {
  const presetId = useEditorStore((s) => s.presetId);
  const tool = useEditorStore((s) => s.tool);

  const choose = (preset: ZonePreset) => {
    const editor = useEditorStore.getState();
    editor.setPreset(preset.id);
    // Choisir un modèle sans outil de surface actif : on passe au rectangle, prêt à dessiner.
    if (!AREA_TOOLS.includes(tool)) editor.setTool('rect');
  };

  const group = (title: string, presets: readonly ZonePreset[]) => (
    <div className="mt-2">
      <h3 className="px-1 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">{title}</h3>
      <ul role="radiogroup" aria-label={title} className="mt-1 space-y-0.5">
        {presets.map((preset) => (
          <li key={preset.id}>
            <button
              type="button"
              role="radio"
              aria-checked={presetId === preset.id}
              onClick={() => choose(preset)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-white ${
                presetId === preset.id ? 'bg-white/15 text-white' : 'text-slate-300 hover:bg-white/10'
              }`}
            >
              <span
                aria-hidden
                className="h-3.5 w-5 shrink-0 rounded-sm border-2"
                style={{
                  borderColor: preset.style.stroke ?? undefined,
                  borderStyle: preset.style.dash === 'solid' ? 'solid' : 'dashed',
                  background: preset.style.fill ?? undefined,
                  opacity: 0.9,
                }}
              />
              {preset.name.fr}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <section className="border-t border-white/10 px-3 py-3" aria-label={t('tools.presets')}>
      <h2 className="px-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
        {t('tools.presets')}
      </h2>
      <p className="px-1 text-xs text-slate-500">{t('tools.presets.help')}</p>
      {group(t('tools.presets.zones'), ZONE_PRESETS)}
      {group(t('tools.presets.buildings'), BUILDING_PRESETS)}
    </section>
  );
}
