// Tela do Extrato de pontos (modal) — usada pelo admin (clique na unidade do ranking), pela região e pelo conselheiro.
// Autônoma: desenha num overlay fora do #app e traz as exportações (CSV da unidade, Excel, Imprimir/PDF).
// Os números vêm de shared/extrato.js (mesma seleção do ranking); este arquivo só mostra e exporta.
import {
  filterLines, statementCsv, workbookData, statementPrintHtml, ORIGEM_FILTROS, CATEGORIA_LABEL
} from '../shared/extrato.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDT = ms => new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const fmtD = ms => (ms ? new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const slugFile = s => String(s ?? 'unidade').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unidade';

let X = null;   // estado do extrato aberto

// opções: { unitId?, loadUnit(id) → statement, loadAll?() → statements[], allLabel?, title? }
//   loadAll presente → mostra a lista de unidades (região/admin) e o botão de Excel de várias unidades
export async function openExtrato(opts) {
  close();
  X = { opts, stmt: null, list: null, filter: '', loading: true, error: '', pend: false };
  paint();
  try {
    if (opts.unitId) X.stmt = await opts.loadUnit(opts.unitId);
    else if (opts.loadAll) { X.list = await opts.loadAll(); if (X.list.length === 1) X.stmt = X.list[0]; }
  } catch (e) { X.error = e.message || 'Não foi possível carregar o extrato.'; }
  if (X) { X.loading = false; paint(); }
}

function close() { document.getElementById('extrato-overlay')?.remove(); X = null; }

function chips(st) {
  return Object.entries(st.subtotais).filter(([k, v]) => v !== 0 || k !== 'piso').map(([k, v]) =>
    `<span style="background:${v < 0 ? '#fee2e2' : '#f1f5f9'};color:${v < 0 ? '#991b1b' : '#334155'};font-size:.74rem;font-weight:700;padding:.25rem .6rem;border-radius:999px;">${esc(CATEGORIA_LABEL[k])}: ${v}</span>`).join('');
}

function paint() {
  let el = document.getElementById('extrato-overlay');
  if (!X) return;
  if (!el) { el = document.createElement('div'); el.id = 'extrato-overlay'; el.className = 'modal-overlay'; el.style.zIndex = '80'; document.body.appendChild(el); el.addEventListener('click', ev => { if (ev.target === el) close(); }); }
  const { stmt, list, loading, error, filter, opts } = X;
  let body;
  if (loading) body = '<p style="text-align:center;color:#64748b;padding:2rem;">Carregando extrato…</p>';
  else if (error) body = `<p style="text-align:center;color:#dc2626;padding:2rem;">${esc(error)}</p>`;
  else if (!stmt && list) body = listView(list);
  else if (!stmt) body = '<p style="text-align:center;color:#64748b;padding:2rem;">Nenhuma unidade disponível.</p>';
  else body = statementView(stmt, filter);
  el.innerHTML = `<div class="modal-content" style="max-width:46rem;width:100%;max-height:92dvh;overflow:auto;">
    <div style="width:2.5rem;height:.25rem;background:#e2e8f0;border-radius:999px;margin:0 auto .75rem;"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;margin-bottom:.5rem;">
      <h2 style="font-size:1.1rem;font-weight:800;color:#1e293b;margin:0;">📄 ${esc(opts.title || 'Extrato de pontos')}</h2>
      <button onclick="EX.close()" aria-label="Fechar" style="border:none;background:#f1f5f9;border-radius:.6rem;padding:.4rem .7rem;cursor:pointer;font-weight:700;">✕</button>
    </div>${body}</div>`;
}

function listView(list) {
  return `<p style="font-size:.8rem;color:#64748b;margin:.2rem 0 .7rem;">Toque numa unidade para ver o extrato.</p>
    <div style="display:flex;flex-direction:column;gap:.45rem;">${list.map((s, i) => `
      <button onclick="EX.pick(${i})" style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;text-align:left;padding:.8rem .9rem;border:1.5px solid #e2e8f0;border-radius:.85rem;background:#fff;cursor:pointer;">
        <span><b style="color:#1e293b;">${esc(s.unidade.nome)}</b><br><span style="font-size:.72rem;color:#94a3b8;">${esc(s.unidade.regiao)}${s.possiveis ? ` · +${s.possiveis} possíveis` : ''}</span></span>
        <b style="color:#0D2B6E;font-size:1.05rem;">${s.total} pts</b></button>`).join('')}</div>
    <div style="margin-top:.9rem;display:flex;gap:.5rem;flex-wrap:wrap;">
      <button onclick="EX.excelAll()" style="${btn('#166534')}">📥 ${esc(X.opts.allLabel || 'Excel de todas as unidades')}</button></div>`;
}
const btn = bg => `background:${bg};color:#fff;border:none;padding:.6rem .95rem;border-radius:.75rem;font-size:.82rem;font-weight:700;cursor:pointer;`;

function statementView(st, filter) {
  const lines = filterLines(st, filter);
  const back = X.list && X.list.length > 1 ? `<button onclick="EX.back()" style="background:none;border:none;color:#64748b;cursor:pointer;font-size:.82rem;padding:0;margin-bottom:.4rem;">← Todas as unidades</button>` : '';
  return `${back}
    <div style="font-weight:800;color:#1e293b;font-size:1.05rem;">${esc(st.unidade.nome)} <span style="font-weight:600;color:#94a3b8;font-size:.78rem;">· ${esc(st.unidade.regiao)}</span></div>
    <div style="display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap;margin:.2rem 0 .5rem;">
      <span style="font-size:1.9rem;font-weight:800;color:#0D2B6E;">${st.total} pts</span>
      ${st.possiveis ? `<span style="font-size:.8rem;color:#92400e;background:#fffbeb;padding:.2rem .6rem;border-radius:999px;">+ ${st.possiveis} possíveis (aguardando aprovação — não entram no total)</span>` : ''}
      ${st.confere ? '' : '<span style="font-size:.75rem;color:#b91c1c;">⚠️ divergência com o ranking — avise o administrador</span>'}
    </div>
    <div style="display:flex;gap:.35rem;flex-wrap:wrap;margin-bottom:.7rem;">${chips(st)}</div>
    <div style="display:flex;gap:.45rem;flex-wrap:wrap;align-items:center;margin-bottom:.7rem;">
      <select onchange="EX.filter(this.value)" aria-label="Filtrar por origem" style="border:1.5px solid #e2e8f0;border-radius:.65rem;padding:.45rem .6rem;font-size:.82rem;background:#fff;">
        ${ORIGEM_FILTROS.map(([v, l]) => `<option value="${v}" ${filter === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <button onclick="EX.csv()" style="${btn('#0D2B6E')}">📥 CSV da unidade</button>
      <button onclick="EX.excel()" style="${btn('#166534')}">📥 ${esc(X.opts.loadAll ? (X.opts.allLabel || 'Excel de todas as unidades') : 'Excel da unidade')}</button>
      <button onclick="EX.print()" style="${btn('#6b21a8')}">🖨️ Imprimir/PDF</button>
    </div>
    <div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:.8rem;">
      <table style="width:100%;border-collapse:collapse;font-size:.8rem;min-width:30rem;">
        <thead><tr style="background:#f8fafc;color:#64748b;text-align:left;"><th style="padding:.5rem;">Data</th><th style="padding:.5rem;">Origem</th><th style="padding:.5rem;">Prova / motivo</th><th style="padding:.5rem;text-align:right;">Pontos</th><th style="padding:.5rem;text-align:right;">Saldo</th></tr></thead>
        <tbody>${lines.length ? lines.map(l => `<tr style="border-top:1px solid #eef2f7;">
          <td style="padding:.45rem .5rem;white-space:nowrap;color:#64748b;">${fmtD(l.data)}</td><td style="padding:.45rem .5rem;">${esc(l.origemLabel)}</td><td style="padding:.45rem .5rem;">${esc(l.descricao)}</td>
          <td style="padding:.45rem .5rem;text-align:right;font-weight:800;color:${l.pontos < 0 ? '#dc2626' : '#166534'};">${l.pontos > 0 ? '+' : ''}${l.pontos}</td>
          <td style="padding:.45rem .5rem;text-align:right;font-weight:700;">${l.saldo}</td></tr>`).join('') : '<tr><td colspan="5" style="padding:1.2rem;text-align:center;color:#94a3b8;">Nenhuma pontuação nesta origem.</td></tr>'}</tbody></table></div>
    ${st.pendentes.length ? `<button onclick="EX.togglePend()" style="margin-top:.7rem;background:none;border:none;color:#92400e;font-weight:700;font-size:.8rem;cursor:pointer;padding:0;">${X.pend ? '▾' : '▸'} Aguardando aprovação (${st.pendentes.length}) — não contam no total</button>
      ${X.pend ? `<div style="margin-top:.4rem;font-size:.78rem;color:#475569;">${st.pendentes.map(p => `<div style="padding:.3rem 0;border-top:1px dashed #e2e8f0;">${esc(p.descricao)} · ${esc(p.origemLabel)} · <b>+${p.pontos}</b></div>`).join('')}</div>` : ''}` : ''}
    ${st.ignorados.length ? `<p style="font-size:.72rem;color:#1e40af;margin-top:.6rem;">ℹ️ ${st.ignorados.length} lançamento(s) de disciplina repetido(s) no servidor local e na nuvem foram contados uma vez só.</p>` : ''}`;
}

// ── exportações ───────────────────────────────────────────────────────────────────────────
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const stamp = () => new Date().toISOString().slice(0, 10);

function writeWorkbook(statements, fileName) {
  if (typeof window.XLSX === 'undefined') { alert('Biblioteca de Excel não carregada. Recarregue a página e tente de novo.'); return; }
  const wb = window.XLSX.utils.book_new();
  const data = workbookData(statements, { fmtDateTime: fmtDT });
  window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(data.resumo), 'Resumo');
  for (const a of data.abas) window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(a.linhas), a.nome);
  window.XLSX.writeFile(wb, fileName);
}

function printHtml(html) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(f);
  const d = f.contentWindow.document;
  d.open(); d.write(html); d.close();
  f.onload = null;
  setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } finally { setTimeout(() => f.remove(), 2000); } }, 250);
}

window.EX = {
  close,
  filter(v) { if (X) { X.filter = v; paint(); } },
  pick(i) { if (X?.list) { X.stmt = X.list[i]; X.filter = ''; paint(); } },
  back() { if (X) { X.stmt = null; paint(); } },
  togglePend() { if (X) { X.pend = !X.pend; paint(); } },
  csv() { if (X?.stmt) download(`extrato-${slugFile(X.stmt.unidade.nome)}-${stamp()}.csv`, new Blob([statementCsv(X.stmt, { fmtDateTime: fmtDT, categoria: X.filter })], { type: 'text/csv;charset=utf-8' })); },
  excel() {
    if (!X?.stmt) return;
    if (X.opts.loadAll) return EX.excelAll();
    writeWorkbook([X.stmt], `extrato-${slugFile(X.stmt.unidade.nome)}-${stamp()}.xlsx`);
  },
  async excelAll() {
    if (!X) return;
    try { const all = X.list || await X.opts.loadAll(); writeWorkbook(all, `extrato-${slugFile(X.opts.allFile || 'unidades')}-${stamp()}.xlsx`); }
    catch (e) { alert(e.message || 'Não foi possível gerar o Excel.'); }
  },
  print() { if (X?.stmt) printHtml(statementPrintHtml(X.stmt, { fmtDateTime: fmtDT, categoria: X.filter })); },
};
