/**
 * Loads the brand fonts (OFL-licensed Google Fonts) inside the Remotion bundle.
 * Only weights/subsets we actually use are requested. Browser-only module.
 */
import { loadFont as loadAnton } from '@remotion/google-fonts/Anton';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadMontserrat } from '@remotion/google-fonts/Montserrat';

const anton = loadAnton('normal', { weights: ['400'], subsets: ['latin'] });
const inter = loadInter('normal', { weights: ['500', '600', '700', '800'], subsets: ['latin'] });
const montserrat = loadMontserrat('normal', { weights: ['800'], subsets: ['latin'] });

export const loadedFamilies = {
  heading: anton.fontFamily,
  body: inter.fontFamily,
  captions: montserrat.fontFamily,
};

/** Resolves when every brand font is ready (call before measuring text). */
export async function waitForFonts(): Promise<void> {
  await Promise.all([anton.waitUntilDone(), inter.waitUntilDone(), montserrat.waitUntilDone()]);
}
