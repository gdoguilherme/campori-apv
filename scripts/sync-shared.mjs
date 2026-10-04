// Copia shared/*.js → server/shared/ (o Docker do Fly.io só enxerga a pasta server/).
// shared/ é a FONTE ÚNICA; server/shared/ é gerado — NÃO editar. Um teste do local-server
// garante que as duas pastas estão idênticas.   Uso: node scripts/sync-shared.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'shared'), dst = path.join(root, 'server', 'shared');
fs.mkdirSync(dst, { recursive: true });
fs.writeFileSync(path.join(dst, 'package.json'), '{ "type": "module", "private": true }\n'); // arquivos .js aqui são ESM
fs.writeFileSync(path.join(dst, 'README.md'), 'GERADO por scripts/sync-shared.mjs a partir de /shared — não edite aqui.\n');
for (const f of fs.readdirSync(src).filter(f => f.endsWith('.js'))) fs.copyFileSync(path.join(src, f), path.join(dst, f));
console.log('server/shared atualizado:', fs.readdirSync(dst).join(', '));
