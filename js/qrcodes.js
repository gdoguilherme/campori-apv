// Página de impressão de TODOS os QR Codes das provas (só admin): uma grade de 6 cartões por A4 (2×3), QR com 6,2 cm.
// Usa o MESMO endpoint de geração (POST /qr/generate — servidor local ou nuvem) e a mesma lib de QR do portal do Fiscal.
// Gera em lotes pequenos com progresso "N de M". Nada é guardado em storage: os payloads vivem só na memória desta página.
import { guardPage, getToken, startExpiryWatcher, portalUrlForUser } from './auth.js';
import { subReqs, generateQrPayload, toast } from './api.js';
import { collectQrJobs, qrPayloadString, chunk, QR_PER_PAGE, QR_PRINT_WARNING } from '../shared/qrsheet.js';
import { buildQrPdf } from '../shared/pdf.js';

const BATCH = 6;                 // requisições em paralelo (não sobrecarrega o servidor/Wi-Fi)
const QR_PX = 340;               // resolução do QR na tela/PDF (6,2 cm ≈ 234 px a 96 dpi → sobra para imprimir nítido)
const S = { user: null, jobs: [], done: 0, failed: 0, running: false, finished: false, cards: [], total: 0, skippedInactive: 0 };

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function init() {
  const user = guardPage(['superadmin', 'admin']);
  if (!user) return;
  S.user = user;
  startExpiryWatcher();
  let first = true;
  const unsub = subReqs(reqs => {                      // só precisamos da lista uma vez
    if (!first) return; first = false;
    setTimeout(() => unsub?.(), 0);
    S.skippedInactive = reqs.filter(r => r.active === false && (r.qrVariants || []).length).length;
    S.jobs = collectQrJobs(reqs);
    S.total = S.jobs.length;
    render();
    if (S.total) generateAll();
  });
  render();
}

function render() {
  const el = document.getElementById('app');
  if (!el) return;
  const pct = S.total ? Math.round(((S.done + S.failed) / S.total) * 100) : 0;
  el.innerHTML = `
  <style>
    .qr-sheet{background:#fff;margin:0 auto 1rem;box-shadow:0 2px 10px rgba(0,0,0,.15);display:grid;grid-template-columns:1fr 1fr;grid-template-rows:5mm repeat(3,1fr);width:194mm;height:281mm;box-sizing:border-box}
    .qr-card{border:1px dashed #888;margin:1.2mm;padding:2mm;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;text-align:center;overflow:hidden;box-sizing:border-box;page-break-inside:avoid;break-inside:avoid}
    .qr-title{font-weight:800;font-size:11.5pt;line-height:1.12;max-height:2.25em;overflow:hidden;color:#000}
    .qr-var{font-size:10pt;color:#222;margin-top:.6mm}
    .qr-pts{font-weight:800;font-size:13pt;color:#000;margin:.4mm 0 1.4mm}
    .qr-box{width:62mm;height:62mm;display:flex;align-items:center;justify-content:center}
    .qr-box canvas,.qr-box img{width:62mm!important;height:62mm!important;image-rendering:pixelated}
    .qr-err{color:#b91c1c;font-size:9pt}
    .qr-head{font-size:7.5pt;color:#555;grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;padding:0 2mm;overflow:hidden}
    @page{size:A4;margin:8mm}
    @media print{
      body{background:#fff!important}
      .no-print{display:none!important}
      #app{background:#fff!important}
      .qr-sheet{box-shadow:none;margin:0;width:auto;height:281mm;break-after:page;page-break-after:always}
      .qr-sheet:last-child{break-after:auto;page-break-after:auto}
    }
    @media screen and (max-width:820px){
      .qr-sheet{width:100%;height:auto;grid-template-columns:1fr;grid-template-rows:auto}
      .qr-card{margin:1.5mm 0}
    }
  </style>
  <div class="no-print" style="background:linear-gradient(135deg,#0D2B6E,#123a8f);color:#fff;padding:1rem;">
    <a href="${portalUrlForUser(S.user)}" style="color:#bfdbfe;font-size:.85rem;text-decoration:none;">← Voltar ao painel</a>
    <h1 style="font-size:1.25rem;font-weight:800;margin:.35rem 0 .25rem;">🔲 QR Codes de todas as provas</h1>
    <p style="margin:0;font-size:.85rem;color:#dbeafe;">${S.total} QR Code(s) em ${Math.ceil(S.total / QR_PER_PAGE) || 0} página(s) A4 · ${QR_PER_PAGE} por folha · QR com 6,2 cm</p>
  </div>
  <div class="no-print" style="max-width:820px;margin:.75rem auto;padding:0 1rem;">
    <div style="background:#fef3c7;border:1.5px solid #f59e0b;color:#78350f;border-radius:.9rem;padding:.7rem .9rem;font-size:.85rem;font-weight:600;">⚠️ ${QR_PRINT_WARNING}</div>
    ${S.skippedInactive ? `<div style="margin-top:.5rem;font-size:.8rem;color:#64748b;">ℹ️ ${S.skippedInactive} prova(s) inativa(s) com QR foram ignoradas (provas inativas não pontuam).</div>` : ''}
    ${S.total === 0 ? `<div style="margin-top:1rem;background:#fff;border-radius:1rem;padding:1.5rem;text-align:center;color:#64748b;">Nenhuma prova ativa com variantes de QR Code cadastrada.<br>Cadastre em Requisitos → “Variantes de QR Code”.</div>` : `
    <div style="margin-top:.75rem;background:#fff;border-radius:1rem;padding:.9rem;border:1px solid #e2e8f0;">
      <div style="display:flex;justify-content:space-between;font-weight:700;color:#1e293b;font-size:.9rem;">
        <span>${S.finished ? (S.failed ? '⚠️ Terminou com falhas' : '✅ Pronto para imprimir') : '⏳ Gerando QR Codes…'}</span>
        <span id="qr-progress">${S.done} de ${S.total}${S.failed ? ` · ${S.failed} falha(s)` : ''}</span></div>
      <div style="background:#e2e8f0;border-radius:999px;height:.5rem;margin-top:.5rem;"><div style="background:${S.failed ? '#f59e0b' : '#16a34a'};border-radius:999px;height:.5rem;width:${pct}%;transition:width .2s;"></div></div>
      <div style="display:flex;gap:.6rem;margin-top:.8rem;flex-wrap:wrap;">
        <button onclick="W.print()" ${S.finished && !S.failed ? '' : 'disabled'} style="flex:1;min-width:9rem;background:#0D2B6E;color:#fff;border:none;padding:.8rem;border-radius:.8rem;font-weight:800;font-size:.95rem;cursor:pointer;opacity:${S.finished && !S.failed ? 1 : .5};">🖨️ Imprimir</button>
        <button onclick="W.pdf()" ${S.finished && !S.failed ? '' : 'disabled'} style="flex:1;min-width:9rem;background:#166534;color:#fff;border:none;padding:.8rem;border-radius:.8rem;font-weight:800;font-size:.95rem;cursor:pointer;opacity:${S.finished && !S.failed ? 1 : .5};">📄 Baixar PDF</button>
        ${S.failed ? `<button onclick="W.retry()" style="flex:1;min-width:9rem;background:#b45309;color:#fff;border:none;padding:.8rem;border-radius:.8rem;font-weight:800;font-size:.95rem;cursor:pointer;">🔁 Tentar de novo (${S.failed})</button>` : ''}
      </div>
      <div style="font-size:.74rem;color:#64748b;margin-top:.5rem;">Na janela de impressão: tamanho <b>A4</b>, escala <b>100%</b>, sem cabeçalhos/rodapés do navegador.</div>
    </div>`}
  </div>
  <div id="qr-sheets" style="padding:0 .5rem 2rem;">
    ${chunk(S.jobs.map((j, i) => i), QR_PER_PAGE).map((idxs, p, all) => `
      <div class="qr-sheet">
        <div class="qr-head"><span>ÍNTEGROS · III Campori de Líderes APV — QR Codes das provas</span><span>Página ${p + 1} de ${all.length}</span></div>
        ${idxs.map(i => cardHtml(S.jobs[i], i)).join('')}
      </div>`).join('')}
  </div>`;
  // redesenha os QR já gerados (a tela é refeita a cada atualização do progresso)
  S.cards.forEach((c, i) => { if (c?.canvas) paintQr(i); });
}

const cardHtml = (j, i) => `
  <div class="qr-card" id="card-${i}">
    <div class="qr-title">${esc(j.requirementName)}</div>
    <div class="qr-var">${esc(j.variantLabel)}</div>
    <div class="qr-pts">${esc(String(j.points).replace('.', ','))} pts</div>
    <div class="qr-box" id="qr-${i}">${S.cards[i]?.error ? `<span class="qr-err">⚠️ ${esc(S.cards[i].error)}</span>` : ''}</div>
  </div>`;

// desenha (de novo) o QR guardado na memória dentro do cartão
function paintQr(i) {
  const box = document.getElementById(`qr-${i}`);
  if (!box || !S.cards[i]?.canvas) return;
  box.innerHTML = '';
  box.appendChild(S.cards[i].canvas);
}

async function makeQr(i, payload) {
  const holder = document.createElement('div');
  new window.QRCode(holder, { text: payload, width: QR_PX, height: QR_PX, correctLevel: window.QRCode.CorrectLevel.M });
  // qrcodejs desenha num <canvas> (e depois o esconde para mostrar um <img>): copiamos o desenho para um canvas NOSSO, sempre visível
  const src = holder.querySelector('canvas');
  if (!src) throw new Error('não foi possível desenhar o QR');
  const canvas = document.createElement('canvas');
  canvas.width = src.width; canvas.height = src.height;
  canvas.getContext('2d').drawImage(src, 0, 0);
  S.cards[i] = { canvas, payload };
}

async function generateOne(i) {
  const j = S.jobs[i];
  try {
    const res = await generateQrPayload(j.requirementId, j.variantId, j.points, getToken());
    await makeQr(i, qrPayloadString(res));
    delete S.cards[i].error;
    S.done++;
  } catch (e) {
    S.cards[i] = { error: e.message || 'falha ao gerar' };
    S.failed++;
  }
}

async function generateAll(onlyFailed = false) {
  if (S.running) return;
  if (typeof window.QRCode === 'undefined') { toast('Biblioteca de QR Code não carregada. Recarregue a página.', 'error'); return; }
  S.running = true; S.finished = false;
  const todo = S.jobs.map((_, i) => i).filter(i => (onlyFailed ? S.cards[i]?.error : !S.cards[i]?.canvas));
  if (onlyFailed) S.failed = 0;
  render();
  for (const group of chunk(todo, BATCH)) {
    await Promise.all(group.map(generateOne));
    const el = document.getElementById('qr-progress');
    if (el) el.textContent = `${S.done} de ${S.total}${S.failed ? ` · ${S.failed} falha(s)` : ''}`;
    group.forEach(i => { const c = S.cards[i]; if (c?.canvas) paintQr(i); else if (c?.error) { const b = document.getElementById(`qr-${i}`); if (b) b.innerHTML = `<span class="qr-err">⚠️ ${esc(c.error)}</span>`; } });
    render();
  }
  S.running = false; S.finished = true;
  render();
}

// tons de cinza (1 byte/pixel) do canvas, para o PDF
function grayPixels(canvas) {
  const { width, height } = canvas;
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const g = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114) | 0;
  return { width, height, data: g };
}
async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

window.W = {
  print() { window.print(); },
  retry() { generateAll(true); },
  async pdf() {
    if (typeof CompressionStream === 'undefined') { toast('Este navegador não gera PDF aqui — use 🖨️ Imprimir e “Salvar como PDF”.', 'error'); return; }
    try {
      toast('Montando o PDF…', 'info');
      const cards = S.jobs.map((j, i) => ({ title: j.requirementName, subtitle: j.variantLabel, points: j.points, image: grayPixels(S.cards[i].canvas) }));
      const bytes = await buildQrPdf({ cards, deflate });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      a.download = `TODOS-OS-QRCODES-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { toast(`Falha ao montar o PDF: ${e.message}`, 'error'); }
  },
};
