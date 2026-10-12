// QR Codes em lote — entrega 1: regras compartilhadas (shared/qrsheet.js), gerador de PDF (shared/pdf.js) e a página de
// impressão do admin (botão só para admin, 6 por A4, QR ≥ 6 cm, progresso "N de M", nada em storage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { REPO_ROOT } from '../src/config.js';
import { collectQrJobs, qrFileNames, qrFingerprint, qrPayloadString, chunk, slug, QR_PER_PAGE, QR_MIN_CM, QR_PRINT_WARNING } from '../../shared/qrsheet.js';
import { buildQrPdf, QR_PDF_SIDE_PT } from '../../shared/pdf.js';
import { inspectPdf } from './pdf-check.js';

const read = f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
const REQS = [
  { id: 'b', name: 'Prova de Nós', order: 2, active: true, qrVariants: [{ id: 'v1', label: 'Básica', points: 50 }, { id: 'v2', label: 'Avançada / Difícil', points: 100 }] },
  { id: 'a', name: 'Orientação', order: 1, qrVariants: [{ id: 'u', label: 'Único', points: 30 }] },
  { id: 'c', name: 'Sem QR', order: 3, qrVariants: [] },
  { id: 'd', name: 'Inativa', order: 4, active: false, qrVariants: [{ id: 'x', label: 'x', points: 1 }] },
  { id: 'e', name: 'Sem variantes', order: 5 },
];

test('collectQrJobs: TODAS as variantes de TODAS as provas ativas com QR, na ordem do cadastro; inativas e sem QR ficam de fora', () => {
  const jobs = collectQrJobs(REQS);
  assert.deepEqual(jobs.map(j => `${j.requirementId}:${j.variantId}:${j.points}`), ['a:u:30', 'b:v1:50', 'b:v2:100']);
  assert.deepEqual(collectQrJobs([]), []);
  assert.equal(collectQrJobs([{ id: 'z', name: 'Z', qrVariants: [{ id: 'q', label: 'q', points: 'abc' }, { label: 'sem id', points: 5 }] }]).length, 0, 'variante sem id ou pontos inválidos não entra');
});

test('nomes de arquivo: <prova>__<variante>__<pontos>pts.png, sem acentos nem caracteres inválidos, sem colisão', () => {
  const names = qrFileNames(collectQrJobs(REQS));
  assert.deepEqual(names, ['Orientacao__Unico__30pts.png', 'Prova-de-Nos__Basica__50pts.png', 'Prova-de-Nos__Avancada-Dificil__100pts.png']);
  for (const n of names) assert.match(n, /^[A-Za-z0-9_,-]+__[A-Za-z0-9_,-]+__[0-9,]+pts\.png$/);
  const dup = qrFileNames([{ requirementName: 'A/B', variantLabel: 'x', points: 5 }, { requirementName: 'A?B', variantLabel: 'x', points: 5 }]);
  assert.deepEqual(dup, ['A-B__x__5pts.png', 'A-B__x__5pts-2.png']);
  assert.equal(slug('Ação "Ñandú" <?>:*|'), 'Acao-Nandu'); assert.equal(slug('???'), 'x');
  assert.equal(qrFileNames([{ requirementName: 'P', variantLabel: 'v', points: 2.5 }])[0], 'P__v__2,5pts.png');
});

test('payload do QR = o mesmo formato do portal do Fiscal; impressão digital muda quando requisito/variante/pontos mudam', () => {
  assert.equal(qrPayloadString({ requisitoId: 'r', varianteId: 'v', pontos: 5, hash: 'h', extra: 1 }), '{"requisitoId":"r","varianteId":"v","pontos":5,"hash":"h"}');
  assert.match(read('js/fiscal.js'), /JSON\.stringify\(\{ requisitoId, varianteId, pontos, hash \}\)/, 'mesmo formato do fiscal.js');
  const f0 = qrFingerprint(collectQrJobs(REQS));
  assert.equal(f0, qrFingerprint(collectQrJobs([...REQS].reverse())), 'independe da ordem');
  const changed = JSON.parse(JSON.stringify(REQS)); changed[0].qrVariants[0].points = 51;
  assert.notEqual(qrFingerprint(collectQrJobs(changed)), f0, 'pontos mudaram → QR impresso inválido');
  const renamed = JSON.parse(JSON.stringify(REQS)); renamed[0].qrVariants.pop();
  assert.notEqual(qrFingerprint(collectQrJobs(renamed)), f0, 'variante removida');
});

test('chunk: 6 por página (2×3)', () => {
  assert.equal(QR_PER_PAGE, 6);
  assert.deepEqual(chunk([1, 2, 3, 4, 5, 6, 7], 6).map(a => a.length), [6, 1]);
  assert.deepEqual(chunk([], 6), []);
});

const fakeImage = (w = 40) => ({ width: w, height: w, data: Uint8Array.from({ length: w * w }, (_, i) => ((i % 7) < 3 ? 0 : 255)) });
const cards = n => Array.from({ length: n }, (_, i) => ({ title: `Prova ${i} com um nome bem comprido que precisa quebrar em duas linhas (ação)`, subtitle: `Variante ${i}`, points: i + 0.5, image: fakeImage() }));

test('PDF: estrutura válida (xref), 6 cartões por página A4, uma imagem por cartão, pixels íntegros, QR ≥ 6 cm', async () => {
  for (const n of [1, 6, 7, 13]) {
    const pdf = await buildQrPdf({ cards: cards(n), deflate: async b => zlib.deflateSync(b) });
    const info = inspectPdf(pdf);
    assert.equal(info.pages, Math.ceil(n / 6), `${n} QR → ${Math.ceil(n / 6)} página(s)`); assert.equal(info.count, info.pages);
    assert.equal(info.images.length, n);
    assert.deepEqual([...info.images[0].pixels], [...fakeImage().data], 'pixels do QR chegam intactos ao PDF');
    assert.match(info.text, /\/MediaBox \[0 0 595\.28 841\.89\]/);
    assert.ok(info.text.includes(`(P\\341gina ${Math.ceil(n / 6)} de ${Math.ceil(n / 6)})`), 'rodapé "Página N de M" (á em WinAnsi octal)');
  }
  assert.ok(QR_PDF_SIDE_PT / 72 * 2.54 >= QR_MIN_CM, `${(QR_PDF_SIDE_PT / 72 * 2.54).toFixed(2)} cm`);
  const none = inspectPdf(await buildQrPdf({ cards: [] })); assert.equal(none.pages, 1, 'sem QR ainda gera um PDF válido');
});

test('PDF: textos com acento e parênteses saem corretos (WinAnsi), sem compressão também funciona', async () => {
  const pdf = await buildQrPdf({ cards: [{ title: 'Orientação (básica) \\ ñ 日本', subtitle: 'Variante é', points: 5, image: fakeImage() }] });
  const t = Buffer.from(pdf).toString('latin1');
  assert.ok(t.includes('Orienta\\347\\343o \\(b\\341sica\\) \\\\ \\361 ??'), 'ç ã á ñ em octal WinAnsi, ( ) \\ escapados, CJK → ?');
  assert.equal(inspectPdf(pdf).images.length, 1);
});

test('página de impressão: só admin, cartões 2×3 em A4, QR de 62 mm, quebra de página, progresso "N de M", aviso e sem storage', () => {
  const js = read('js/qrcodes.js'), html = read('pages/qrcodes.html'), admin = read('js/admin.js');
  assert.match(js, /guardPage\(\['superadmin', 'admin'\]\)/, 'conselheiro/fiscal/região são redirecionados');
  assert.match(js, /grid-template-columns:1fr 1fr;grid-template-rows:5mm repeat\(3,1fr\)/, 'cabeçalho da folha + 3 linhas de cartões (2×3)'); assert.match(js, /\.qr-box\{width:62mm;height:62mm/);
  assert.match(js, /@page\{size:A4;margin:8mm\}/); assert.match(js, /break-after:page/); assert.match(js, /\.no-print\{display:none/);
  assert.match(js, /\$\{S\.done\} de \$\{S\.total\}/); assert.match(js, /const BATCH = 6/);
  assert.match(js, /generateQrPayload\(j\.requirementId, j\.variantId, j\.points, getToken\(\)\)/, 'mesmo endpoint /qr/generate (via api.js: local ou nuvem)');
  assert.match(js, /🖨️ Imprimir/); assert.match(js, /📄 Baixar PDF/); assert.match(js, /QR_PRINT_WARNING/);
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(js), 'payloads só em memória');
  assert.match(html, /qrcodejs\/1\.0\.0\/qrcode\.min\.js/, 'mesma lib de QR do fiscal.html');
  assert.match(read('pages/fiscal.html'), /qrcodejs\/1\.0\.0\/qrcode\.min\.js/);
  assert.match(admin, /🔲 QR Codes \(todos\)/); assert.match(admin, /isAdmin\(\) \? `<a href="\/pages\/qrcodes\.html"/, 'botão só para admin');
  assert.match(admin, /Imprima os QR Codes só depois de cadastrar os requisitos reais/);
  assert.match(QR_PRINT_WARNING, /invalida o QR já impresso/);
  const sw = read('sw.js');
  for (const f of ['/pages/qrcodes.html', '/js/qrcodes.js', '/shared/qrsheet.js', '/shared/pdf.js']) assert.ok(sw.includes(`"${f}"`), `${f} no shell offline (rode node scripts/build-sw.mjs)`);
});

test('a nuvem não muda: o gerador usa as mesmas funções do api.js (sem importar api-local nem Firestore)', () => {
  const js = read('js/qrcodes.js');
  assert.ok(!/api-local|firebase/.test(js));
  assert.match(js, /from '\.\/api\.js'/);
});
