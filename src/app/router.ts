/**
 * Navigation minimale par fragment d'URL (#/…). Recharger la page rouvre le même écran,
 * y compris le plan en cours : c'est la base de la reprise après fermeture ou plantage.
 */
import { useSyncExternalStore } from 'react';

export type Route =
  { name: 'camps' } | { name: 'camp'; siteId: string } | { name: 'plan'; siteId: string; planId: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'camp' && parts[1]) {
    if (parts[2] === 'plan' && parts[3]) return { name: 'plan', siteId: parts[1], planId: parts[3] };
    return { name: 'camp', siteId: parts[1] };
  }
  return { name: 'camps' };
}

export function routeHref(route: Route): string {
  const e = encodeURIComponent;
  switch (route.name) {
    case 'camps':
      return '#/';
    case 'camp':
      return `#/camp/${e(route.siteId)}`;
    case 'plan':
      return `#/camp/${e(route.siteId)}/plan/${e(route.planId)}`;
  }
}

export function navigate(route: Route): void {
  window.location.hash = routeHref(route);
}

function subscribe(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}
