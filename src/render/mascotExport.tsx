/** Export the original mascot (4 expressions) as static SVGs into assets/mascot/. Local only. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROJECT_ROOT } from '../config';
import { EXPRESSIONS, MascotSvg } from '../../remotion/components/MascotSvg';

export async function exportMascotSvgs(
  outDir = path.join(PROJECT_ROOT, 'assets', 'mascot'),
): Promise<string[]> {
  await fs.mkdir(outDir, { recursive: true });
  const files: string[] = [];
  for (const expression of EXPRESSIONS) {
    const markup = renderToStaticMarkup(
      React.createElement(MascotSvg, {
        expression,
        mouthLevel: 1,
        blink: 0,
        glow: 0.5,
        size: 512,
        idPrefix: expression,
      }),
    );
    const svg = markup.includes('xmlns=')
      ? markup
      : markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    const file = path.join(outDir, `mascot-${expression}.svg`);
    await fs.writeFile(file, `${svg}\n`);
    files.push(file);
  }
  return files;
}
