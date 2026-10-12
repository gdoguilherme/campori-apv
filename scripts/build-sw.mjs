// Gera a lista do app shell e a VERSION (hash do conteúdo) dentro do sw.js.
// Rodar ANTES de cada deploy:  node scripts/build-sw.mjs
// (a VERSION muda sozinha quando qualquer arquivo do shell muda → navegadores atualizam o cache)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir, filter) => fs.existsSync(path.join(root, dir))
  ? fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e => {
      const rel = `${dir}/${e.name}`;
      return e.isDirectory() ? walk(rel, filter) : (filter(rel) ? [rel] : []);
    })
  : [];

// ícones PWA e originais ficam de fora: o navegador busca os ícones na instalação, e
// originais/ nem é referenciado pelo app
const skip = f => f.startsWith('assets/originais/') || f.startsWith('assets/pwa/icon-') || f === 'assets/favicon/favicon-512.png';
const files = [
  ...walk('pages', f => f.endsWith('.html')),
  ...walk('css', f => f.endsWith('.css')),
  ...walk('js', f => f.endsWith('.js')),
  ...walk('shared', f => f.endsWith('.js')),
  ...walk('assets', f => !skip(f) && /\.(png|jpe?g|svg|webp|ico)$/.test(f)),
  'manifest.json',
].sort();

const hash = crypto.createHash('sha1');
for (const f of files) hash.update(f).update(fs.readFileSync(path.join(root, f)));
const swPath = path.join(root, 'sw.js');
const sw = fs.readFileSync(swPath, 'utf8');
hash.update(sw.replace(/\/\* BUILD:START \*\/[\s\S]*?\/\* BUILD:END \*\//, '')); // mudança na lógica do SW também gera nova versão
const version = hash.digest('hex').slice(0, 10);

const block = `/* BUILD:START */\nconst VERSION = '${version}';\nconst SHELL = ${JSON.stringify(files.map(f => '/' + f), null, 2)};\n/* BUILD:END */`;
const out = sw.replace(/\/\* BUILD:START \*\/[\s\S]*?\/\* BUILD:END \*\//, block);
fs.writeFileSync(swPath, out);
console.log(`sw.js atualizado: versão ${version}, ${files.length} arquivos no shell`);
