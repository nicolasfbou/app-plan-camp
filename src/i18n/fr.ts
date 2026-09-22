/** Textes de l'interface en français (langue de référence : toutes les clés sont définies ici). */
export const fr = {
  'app.name': 'CampPlanner',
  'app.tagline': 'Plans de camp sur photo aérienne',

  'topbar.noPlan': 'Aucun plan ouvert',
  'topbar.undo': 'Annuler (Ctrl+Z)',
  'topbar.redo': 'Rétablir (Ctrl+Y)',
  'topbar.toggleLeft': 'Afficher ou masquer le panneau des outils',
  'topbar.toggleRight': 'Afficher ou masquer le panneau des propriétés',

  'save.saved': 'Enregistré',
  'save.dirty': 'Modifications non enregistrées',

  'tools.title': 'Outils',
  'tools.empty': 'Les outils de dessin seront ajoutés à la phase 2.',

  'panel.properties': 'Propriétés',
  'panel.layers': 'Calques',
  'panel.properties.empty': 'Aucun objet sélectionné.',
  'panel.layers.empty': 'Les calques apparaîtront ici quand un plan sera ouvert.',

  'canvas.empty.title': 'Aucun plan ouvert',
  'canvas.empty.body':
    "La création de camps et de plans ainsi que l'import de photo aérienne arrivent à la phase 1.",
  'canvas.label': 'Zone de travail du plan',

  'pwa.updateAvailable': 'Une nouvelle version de CampPlanner est disponible.',
  'pwa.reload': 'Recharger',
  'pwa.dismiss': 'Plus tard',
  'pwa.close': 'Fermer',
  'pwa.offlineReady': 'CampPlanner est prêt à fonctionner hors ligne.',

  'layer.default.zones': 'Zones',
  'layer.default.buildings': 'Bâtiments',
  'layer.default.circulation': 'Circulation véhicules',
  'layer.default.pedestrians': 'Piétons',
  'layer.default.signage': 'Signalisation',
  'layer.default.texts': 'Textes',
} as const;

export type MessageKey = keyof typeof fr;
export type Messages = Record<MessageKey, string>;
