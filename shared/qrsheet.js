// QR Codes das provas em lote — regras PURAS (sem DOM/Node), usadas pela página de impressão do admin (js/qrcodes.js),
// pelo gerador do servidor local (npm run gerar-qrcodes) e pelo painel /status.
//
// ATENÇÃO: o hash de cada QR depende de (requisito, variante, PONTOS) e do QR_SECRET. Trocar requisito, variante ou pontos
// DEPOIS de imprimir invalida o QR impresso — imprima só depois de cadastrar os requisitos reais.

export const QR_PER_PAGE = 6;              // 2 colunas × 3 linhas em A4
export const QR_MIN_CM = 6;                // lado mínimo do QR impresso
export const QR_PRINT_WARNING = 'Imprima os QR Codes só depois de cadastrar os requisitos REAIS: trocar requisito, variante ou pontos depois invalida o QR já impresso.';

// Todas as variantes de todas as provas ATIVAS que têm QR (inativas não pontuam: o servidor recusa — REQUIREMENT_INACTIVE).
export function collectQrJobs(requirements = []) {
  const jobs = [];
  const reqs = [...requirements].filter(r => r && r.active !== false && Array.isArray(r.qrVariants) && r.qrVariants.length)
    .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || String(a.name).localeCompare(String(b.name), 'pt'));
  for (const r of reqs) {
    for (const v of r.qrVariants) {
      if (!v || !v.id || !Number.isFinite(Number(v.points))) continue;
      jobs.push({ requirementId: r.id, requirementName: String(r.name ?? r.id), variantId: v.id, variantLabel: String(v.label ?? v.id), points: Number(v.points) });
    }
  }
  return jobs;
}

// Mesmo formato lido pelo app do conselheiro (js/fiscal.js monta exatamente isto)
export const qrPayloadString = ({ requisitoId, varianteId, pontos, hash }) => JSON.stringify({ requisitoId, varianteId, pontos, hash });

export const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// "Prova de Nós" → "Prova-de-Nos" (sem acentos nem caracteres inválidos em nomes de arquivo do Windows)
export const slug = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

// <prova>__<variante>__<pontos>pts.png — nomes repetidos (duas provas com o mesmo nome) ganham -2, -3…
export function qrFileNames(jobs) {
  const seen = new Map();
  return jobs.map(j => {
    const pts = String(j.points).replace('.', ',');
    const base = `${slug(j.requirementName)}__${slug(j.variantLabel)}__${pts}pts`;
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    return `${n === 1 ? base : `${base}-${n}`}.png`;
  });
}

// Impressão digital do conjunto (id/variante/pontos/nome): detecta que algo mudou DEPOIS de gerar/imprimir (cyrb53)
export function qrFingerprint(jobs) {
  const s = jobs.map(j => `${j.requirementId}|${j.variantId}|${j.points}|${j.requirementName}|${j.variantLabel}`).sort().join('\n');
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}
