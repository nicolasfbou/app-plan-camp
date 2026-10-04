/**
 * Superposition des réseaux techniques : chaque réseau (eau potable, égout, électricité…) a ses
 * propres calques ; ces commandes les affichent, les masquent, les isolent ou les atténuent comme
 * des calques, sans toucher aux autres calques du plan. Une commande = une action d'historique.
 */
import { polylineLength } from '@/domain/model/measure.ts';
import { setLayerFlag } from '@/domain/model/operations.ts';
import { NETWORK_TIERS } from '@/domain/model/schema.ts';
import type { Layer, NetworkTier, PlanDocument } from '@/domain/model/types.ts';
import { isNetworkTier } from '@/domain/presets/networkPresets.ts';
import { createNetworkView } from '@/domain/print/views.ts';
import { t } from '@/i18n/index.ts';
import { useEditorStore } from '@/store/editorStore.ts';
import { planStore } from '@/store/planStore.ts';

export interface NetworkSummary {
  network: NetworkTier;
  layers: Layer[];
  /** Au moins un calque du réseau est affiché. */
  visible: boolean;
  /** Opacité du premier calque du réseau (1 si aucun). */
  opacity: number;
  /** Lignes du réseau (sur ses calques ou ailleurs) et longueur totale tracée, en pixels image. */
  lines: number;
  length: number;
  /** Équipements (pictogrammes) posés sur les calques du réseau. */
  equipment: number;
}

/** État de chaque réseau du plan, dans l'ordre des réseaux. */
export function networkSummaries(doc: PlanDocument): NetworkSummary[] {
  return NETWORK_TIERS.map((network) => {
    const layers = doc.layers.filter((l) => l.tier === network);
    const ids = new Set(layers.map((l) => l.id));
    let lines = 0;
    let length = 0;
    let equipment = 0;
    for (const o of Object.values(doc.objects)) {
      if (o.type === 'utility' && o.network === network) {
        lines++;
        length += polylineLength(o.geometry.points);
      } else if (o.type === 'icon' && ids.has(o.layerId)) equipment++;
    }
    return {
      network,
      layers,
      visible: layers.some((l) => l.visible),
      opacity: layers[0]?.opacity ?? 1,
      lines,
      length,
      equipment,
    };
  });
}

const update = (label: string, recipe: (d: PlanDocument) => void, mergeKey?: string) =>
  planStore.getState().update(label, recipe, mergeKey ? { mergeKey } : undefined);

const networkName = (network: NetworkTier) => t(`tier.${network}`);

export const networkActions = {
  /** Affiche ou masque tous les calques d'un réseau. */
  setVisible(network: NetworkTier, visible: boolean) {
    const name = networkName(network);
    update(t(visible ? 'networks.show' : 'networks.hide', { name }), (d) => {
      for (const l of d.layers) if (l.tier === network) setLayerFlag(d, l.id, 'visible', visible);
    });
  },

  /** N'affiche que ce réseau parmi les réseaux ; les autres calques du plan restent tels quels. */
  showOnly(network: NetworkTier) {
    update(t('networks.only', { name: networkName(network) }), (d) => {
      for (const l of d.layers)
        if (isNetworkTier(l.tier)) setLayerFlag(d, l.id, 'visible', l.tier === network);
    });
  },

  /** Affiche (ou masque) tous les réseaux à la fois. */
  setAllVisible(visible: boolean) {
    update(t(visible ? 'networks.showAll' : 'networks.hideAll'), (d) => {
      for (const l of d.layers) if (isNetworkTier(l.tier)) setLayerFlag(d, l.id, 'visible', visible);
    });
  },

  /** Opacité des calques d'un réseau (curseur : un glissement = une action). */
  setOpacity(network: NetworkTier, opacity: number) {
    update(
      t('networks.opacityOf', { name: networkName(network) }),
      (d) => {
        const now = new Date().toISOString();
        for (const l of d.layers)
          if (l.tier === network && l.opacity !== opacity) {
            l.opacity = opacity;
            d.plan.updatedAt = now;
          }
      },
      `network-opacity:${network}`,
    );
  },

  /**
   * Vue imprimable de ce seul réseau (photo, zones, bâtiments, textes et le réseau) : « un plan
   * par réseau », sans copier aucun objet. Retourne le nom de la vue créée.
   */
  createView(network: NetworkTier): string {
    const name = t('networks.viewName', { name: networkName(network) });
    const doc = planStore.getState().doc;
    if (!doc) return name;
    // Calculée hors du brouillon Immer (la vue copie les réglages d'impression avec structuredClone).
    const view = createNetworkView(
      doc,
      network,
      name,
      t('networks.viewNote', { name: networkName(network) }),
    );
    update(name, (d) => {
      d.plan.views.push(view);
      d.plan.updatedAt = new Date().toISOString();
    });
    useEditorStore.getState().notify(t('networks.viewCreated', { name }));
    return name;
  },
};
