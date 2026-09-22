/**
 * Pyramide d'affichage : copies réduites de la photo (1/4, 1/8, 1/16…) utilisées UNIQUEMENT
 * pour dessiner à l'écran quand on est très dézoomé. Elles ne sont jamais enregistrées ni
 * exportées ; l'original reste la seule source. Dès que l'écran peut afficher plus de pixels
 * que la copie n'en contient, on dessine l'original.
 */

/** Facteurs de réduction disponibles, du plus fin au plus grossier (1 = original). */
export function pyramidFactors(width: number, height: number, minSide = 512): number[] {
  const factors = [1];
  for (let f = 1 / 4; Math.max(width, height) * f >= minSide; f /= 2) factors.push(f);
  return factors;
}

/**
 * Choisit la copie la plus légère qui contient au moins autant de pixels que l'écran en affiche.
 * @param devicePixelsPerImagePixel échelle du viewport × densité de l'écran
 */
export function chooseLevel(factors: readonly number[], devicePixelsPerImagePixel: number): number {
  let chosen = factors[0] ?? 1;
  for (const f of factors) if (f >= devicePixelsPerImagePixel) chosen = Math.min(chosen, f);
  return chosen;
}
