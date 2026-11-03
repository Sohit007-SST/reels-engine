/** Browser-side text measurer backed by @remotion/layout-utils (real loaded fonts). */
import { measureText } from '@remotion/layout-utils';
import type { Measurer } from './layout';

export const layoutUtilsMeasurer: Measurer = (text, style, fontSize) => {
  const d = measureText({
    text,
    fontFamily: style.fontFamily,
    fontSize,
    fontWeight: style.fontWeight,
    letterSpacing: style.letterSpacing,
    // Fonts are awaited in calculateMetadata before measuring; fail loudly if one is missing.
    validateFontIsLoaded: true,
  });
  return { width: d.width, height: fontSize * style.lineHeight };
};
