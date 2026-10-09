// Writes every README code block preceded by a `> Create at: \`path\`` marker
// to .snippets/<path>, so the README's code can be type-checked and tested.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.snippets');
const lines = readFileSync(join(root, 'README.md'), 'utf8').split('\n');

rmSync(outDir, { recursive: true, force: true });

const written = [];
for (let i = 0; i < lines.length; i++) {
  const marker = lines[i].match(/^> Create at: `([^`]+)`/);
  if (!marker) continue;

  const start = lines.findIndex((l, j) => j > i && /^```tsx?\s*$/.test(l));
  const end = lines.findIndex((l, j) => j > start && /^```\s*$/.test(l));
  if (start === -1 || end === -1) {
    throw new Error(`No code block found after marker on README line ${i + 1}`);
  }

  const target = join(outDir, marker[1]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, lines.slice(start + 1, end).join('\n') + '\n');
  written.push(marker[1]);
  i = end;
}

if (written.length === 0) throw new Error('No `> Create at:` snippets found in README.md');
console.log(`Extracted ${written.length} snippets to .snippets/:\n  ${written.join('\n  ')}`);
