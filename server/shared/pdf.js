// Gerador mínimo de PDF (A4, 6 cartões de QR por página) — SEM dependências, puro JS: roda no navegador (página de impressão
// do admin) e no Node (npm run gerar-qrcodes). Texto em Helvetica (WinAnsi: acentos do português), imagens em tons de cinza 8 bits.
//
// buildQrPdf({ cards, deflate, perPage?, footer? }) → Uint8Array
//   cards:   [{ title, subtitle, points, image: { width, height, data: Uint8Array (cinza, 1 byte/pixel) } }]
//   deflate: async (Uint8Array) => Uint8Array (zlib). Navegador: CompressionStream('deflate'); Node: zlib.deflateSync. Sem ele, sem compressão.

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 24, HEADER = 22, COLS = 2, ROWS = 3;
export const QR_PDF_SIDE_PT = 176;   // 6,2 cm (≥ 6 cm)

const enc = new TextEncoder();
const num = n => (Math.round(n * 100) / 100).toString();

// texto → bytes WinAnsi (Latin-1 cobre á é ç ã…); o que não cabe vira "?"
function winAnsi(s) {
  const out = [];
  for (const ch of String(s ?? '')) { const c = ch.codePointAt(0); out.push(c < 256 ? c : 63); }
  return out;
}
const pdfText = s => `(${winAnsi(s).map(c => (c === 40 || c === 41 || c === 92 ? `\\${String.fromCharCode(c)}` : c < 32 || c > 126 ? `\\${c.toString(8).padStart(3, '0')}` : String.fromCharCode(c))).join('')})`;

// largura aproximada em Helvetica (média 0,5 em) para centralizar e quebrar linha
const approxWidth = (s, size, bold) => String(s).length * size * (bold ? 0.56 : 0.52);
function wrap(s, size, maxW, bold, maxLines = 2) {
  const words = String(s ?? '').split(/\s+/).filter(Boolean), lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (approxWidth(t, size, bold) <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { const keep = lines.slice(0, maxLines); keep[maxLines - 1] = keep[maxLines - 1].replace(/.{0,3}$/, '...'); return keep; }
  return lines;
}

export async function buildQrPdf({ cards, deflate = null, perPage = COLS * ROWS, footer = 'ÍNTEGROS · III Campori de Líderes APV' }) {
  const pages = [];
  for (let i = 0; i < cards.length; i += perPage) pages.push(cards.slice(i, i + perPage));
  if (!pages.length) pages.push([]);

  // objetos: 1 catálogo, 2 páginas, 3 Helvetica, 4 Helvetica-Bold; depois, por cartão: imagem; por página: conteúdo + página
  const objs = [];                       // cada item: Uint8Array (conteúdo completo "N 0 obj … endobj")
  const reserve = () => { objs.push(null); return objs.length; };
  const put = (id, parts) => { objs[id - 1] = concat([enc.encode(`${id} 0 obj\n`), ...parts, enc.encode('\nendobj\n')]); };
  const catalog = reserve(), pagesObj = reserve(), fReg = reserve(), fBold = reserve();
  put(fReg, [enc.encode('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')]);
  put(fBold, [enc.encode('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')]);

  const cellW = (A4.w - 2 * MARGIN) / COLS;
  const cellH = (A4.h - 2 * MARGIN - HEADER) / ROWS;
  const pageIds = [];
  let imgCounter = 0;

  for (let p = 0; p < pages.length; p++) {
    const xobjects = [];
    let ops = `BT /F2 9 Tf ${num(MARGIN)} ${num(A4.h - MARGIN - 6)} Td ${pdfText(footer)} Tj ET\n`;
    ops += `BT /F1 9 Tf ${num(A4.w - MARGIN - 70)} ${num(A4.h - MARGIN - 6)} Td ${pdfText(`Página ${p + 1} de ${pages.length}`)} Tj ET\n`;
    for (let i = 0; i < pages[p].length; i++) {
      const c = pages[p][i];
      const col = i % COLS, row = Math.floor(i / COLS);
      const x0 = MARGIN + col * cellW, yTop = A4.h - MARGIN - HEADER - row * cellH;
      // moldura tracejada (linha de corte)
      ops += `q 0.6 G 0.6 w [3 3] 0 d ${num(x0 + 4)} ${num(yTop - cellH + 4)} ${num(cellW - 8)} ${num(cellH - 8)} re S Q\n`;
      // título (até 2 linhas), variante e pontos — tudo acima do QR (que ocupa os últimos 176 pt + 14 pt de folga da base)
      let y = yTop - 17;
      for (const line of wrap(c.title, 11.5, cellW - 24, true)) { ops += `BT /F2 11.5 Tf ${num(x0 + (cellW - approxWidth(line, 11.5, true)) / 2)} ${num(y)} Td ${pdfText(line)} Tj ET\n`; y -= 13; }
      const sub = wrap(c.subtitle, 10, cellW - 24, false, 1)[0] || '';
      ops += `BT /F1 10 Tf ${num(x0 + (cellW - approxWidth(sub, 10, false)) / 2)} ${num(y)} Td ${pdfText(sub)} Tj ET\n`;
      const ptsTxt = `${String(c.points).replace('.', ',')} pts`;
      ops += `BT /F2 12.5 Tf ${num(x0 + (cellW - approxWidth(ptsTxt, 12.5, true)) / 2)} ${num(y - 14)} Td ${pdfText(ptsTxt)} Tj ET\n`;
      // QR
      const side = QR_PDF_SIDE_PT, qx = x0 + (cellW - side) / 2, qy = yTop - cellH + 14;
      const id = reserve(), name = `Im${++imgCounter}`;
      const raw = c.image.data;
      const data = deflate ? await deflate(raw) : raw;
      put(id, [enc.encode(`<< /Type /XObject /Subtype /Image /Width ${c.image.width} /Height ${c.image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Interpolate false${deflate ? ' /Filter /FlateDecode' : ''} /Length ${data.length} >>\nstream\n`), data, enc.encode('\nendstream')]);
      xobjects.push(`/${name} ${id} 0 R`);
      ops += `q ${num(side)} 0 0 ${num(side)} ${num(qx)} ${num(qy)} cm /${name} Do Q\n`;
    }
    const contentId = reserve(), pageId = reserve();
    const content = enc.encode(ops);
    put(contentId, [enc.encode(`<< /Length ${content.length} >>\nstream\n`), content, enc.encode('\nendstream')]);
    put(pageId, [enc.encode(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << /F1 ${fReg} 0 R /F2 ${fBold} 0 R >> /XObject << ${xobjects.join(' ')} >> >> /Contents ${contentId} 0 R >>`)]);
    pageIds.push(pageId);
  }
  put(pagesObj, [enc.encode(`<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)]);
  put(catalog, [enc.encode(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`)]);

  // arquivo: cabeçalho + objetos + tabela xref + trailer
  const header = new Uint8Array([...enc.encode('%PDF-1.4\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 10]);   // 2ª linha binária: avisa que o arquivo é binário
  const chunks = [header]; let offset = header.length; const offsets = [];
  for (const o of objs) { offsets.push(offset); chunks.push(o); offset += o.length; }
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(enc.encode(xref));
  return concat(chunks);
}

function concat(parts) {
  const len = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(len);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
