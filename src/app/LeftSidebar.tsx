import {
  Circle,
  FolderInput,
  Footprints,
  Hand,
  type LucideIcon,
  MousePointer2,
  Pentagon,
  Route,
  SignpostBig,
  Slash,
  Spline,
  Square,
  Squircle,
  Tag,
  TentTree,
  Type,
} from 'lucide-react';
import { useRef } from 'react';
import { FLOW_PRESETS } from '@/domain/presets/flowPresets.ts';
import {
  BUILDING_PRESETS,
  type PresetGroup,
  ZONE_PRESETS,
  type ZonePreset,
} from '@/domain/presets/zonePresets.ts';
import { assetSymbolId, SYMBOL_CATEGORIES, SYMBOLS, symbolDataUrl } from '@/domain/symbols/catalog.ts';
import { importSymbolFile } from '@/editor/symbolActions.ts';
import { symbolImage, useSymbolImagesVersion } from '@/editor/objects/symbolImages.ts';
import { usePlanStore } from '@/store/planStore.ts';
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
  { tool: 'flow', icon: Route, hint: 'tools.hint.flow' },
  { tool: 'corridor', icon: Footprints, hint: 'tools.hint.corridor' },
  { tool: 'symbol', icon: SignpostBig, hint: 'tools.hint.symbol' },
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
      {tool === 'flow' ? <FlowCategories /> : tool === 'symbol' ? <SymbolLibrary /> : <PresetList />}
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
              data-preset={preset.id}
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
      {group(t('tools.presets.parking'), byGroup('parking'))}
      {group(t('tools.presets.deliveries'), byGroup('deliveries'))}
      {group(t('tools.presets.safety'), byGroup('safety'))}
      <button
        type="button"
        onClick={() => {
          useEditorStore.getState().setFlowCategory('emergency');
          useEditorStore.getState().setTool('flow');
        }}
        className="mt-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm text-slate-300 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
      >
        <Route size={16} className="shrink-0 text-red-400" aria-hidden /> {t('tools.presets.emergencyLane')}
      </button>
      {group(t('tools.presets.zones'), byGroup('zones'))}
      {group(t('tools.presets.buildings'), BUILDING_PRESETS)}
    </section>
  );
}

const NO_ASSETS: Readonly<Record<string, never>> = {};

const byGroup = (g: PresetGroup) => ZONE_PRESETS.filter((p) => p.group === g);

const sectionTitle = 'px-1 text-xs font-semibold tracking-wide text-slate-400 uppercase';
const itemClass = (on: boolean) =>
  `flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-white ${
    on ? 'bg-white/15 text-white' : 'text-slate-300 hover:bg-white/10'
  }`;

/** Catégories de trajets (outil Circulation véhicules). */
function FlowCategories() {
  const category = useEditorStore((s) => s.flowCategory);
  return (
    <section className="border-t border-white/10 px-3 py-3">
      <h2 className={sectionTitle}>{t('tools.flowCategory')}</h2>
      <ul role="radiogroup" aria-label={t('tools.flowCategory')} className="mt-2 space-y-0.5">
        {FLOW_PRESETS.map((preset) => (
          <li key={preset.category}>
            <button
              type="button"
              role="radio"
              data-flow-category={preset.category}
              aria-checked={category === preset.category}
              onClick={() => useEditorStore.getState().setFlowCategory(preset.category)}
              className={itemClass(category === preset.category)}
            >
              <span
                aria-hidden
                className="h-1 w-6 shrink-0 rounded"
                style={{
                  background: preset.style.stroke ?? undefined,
                  height: Math.max(3, preset.style.strokeWidth - 1),
                  opacity: preset.style.dash === 'solid' ? 1 : 0.6,
                }}
              />
              {preset.name}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Bibliothèque de pictogrammes par catégorie, et pictogrammes importés. */
function SymbolLibrary() {
  const symbolId = useEditorStore((s) => s.symbolId);
  const assets = usePlanStore((s) => s.doc?.assets ?? NO_ASSETS);
  useSymbolImagesVersion();
  const input = useRef<HTMLInputElement>(null);
  const pick = (id: string) => useEditorStore.getState().pickSymbol(id);
  const cell = (id: string, name: string, src: string | null) => (
    <li key={id}>
      <button
        type="button"
        role="radio"
        aria-checked={symbolId === id}
        aria-label={name}
        title={name}
        data-symbol={id}
        onClick={() => pick(id)}
        className={`flex h-11 w-11 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-white ${
          symbolId === id ? 'bg-accent ring-2 ring-white' : 'hover:bg-white/10'
        }`}
      >
        {src ? (
          <img src={src} alt="" width={32} height={32} draggable={false} />
        ) : (
          <SignpostBig size={20} aria-hidden />
        )}
      </button>
    </li>
  );
  const custom = Object.values(assets);
  return (
    <section className="border-t border-white/10 px-3 py-3" aria-label={t('tools.symbols')}>
      <h2 className={sectionTitle}>{t('tools.symbols')}</h2>
      {SYMBOL_CATEGORIES.map((category) => (
        <div key={category.id} className="mt-2">
          <h3 className="px-1 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
            {category.name}
          </h3>
          <ul role="radiogroup" aria-label={category.name} className="mt-1 grid grid-cols-4 gap-1">
            {SYMBOLS.filter((symbol) => symbol.category === category.id).map((symbol) =>
              cell(symbol.id, symbol.name, symbolDataUrl(symbol.id)),
            )}
          </ul>
        </div>
      ))}
      <div className="mt-3">
        <h3 className="px-1 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
          {t('tools.symbols.custom')}
        </h3>
        {custom.length > 0 && (
          <ul
            role="radiogroup"
            aria-label={t('tools.symbols.custom')}
            className="mt-1 grid grid-cols-4 gap-1"
          >
            {custom.map((asset) =>
              cell(
                assetSymbolId(asset.id),
                asset.name,
                symbolImage(assetSymbolId(asset.id), null, assets)?.src ?? null,
              ),
            )}
          </ul>
        )}
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="mt-2 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-slate-200 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
        >
          <FolderInput size={16} aria-hidden /> {t('tools.symbols.import')}
        </button>
        <input
          ref={input}
          type="file"
          accept=".png,.svg,image/png,image/svg+xml"
          className="hidden"
          data-testid="symbol-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void importSymbolFile(file);
          }}
        />
      </div>
    </section>
  );
}
