// Validador estrutural de PDF para os testes (sem programas externos): confere xref, páginas, imagens e o tamanho dos pixels.
import zlib from 'node:zlib';

export function inspectPdf(buf) {
  const text = Buffer.from(buf).toString('latin1');
  if (!text.startsWith('%PDF-1.')) throw new Error('sem cabeçalho %PDF');
  if (!text.trimEnd().endsWith('%%EOF')) throw new Error('sem %%EOF');
  const sx = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
  if (!(sx > 0) || !text.startsWith('xref\n', sx)) throw new Error('startxref não aponta para a tabela xref');
  const lines = text.slice(sx).split('\n');
  const size = Number(lines[1].split(' ')[1]);
  const entries = lines.slice(2, 2 + size);
  if (!entries[0].startsWith('0000000000 65535 f')) throw new Error('entrada 0 inválida');
  for (let n = 1; n < size; n++) {
    const off = Number(entries[n].slice(0, 10));
    if (!text.startsWith(`${n} 0 obj\n`, off)) throw new Error(`xref do objeto ${n} aponta para o lugar errado (${off})`);
  }
  const pages = (text.match(/\/Type \/Page /g) || []).length;
  const count = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)?.[1]);
  const images = [];
  const re = /<< \/Type \/XObject \/Subtype \/Image \/Width (\d+) \/Height (\d+) [^>]*?(\/Filter \/FlateDecode )?\/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length, len = Number(m[4]);
    const raw = Buffer.from(buf).subarray(start, start + len);
    if (text.substr(start + len, 10) !== '\nendstream') throw new Error('Length da imagem não confere');
    const px = m[3] ? zlib.inflateSync(raw) : raw;
    if (px.length !== Number(m[1]) * Number(m[2])) throw new Error('pixels da imagem não batem com largura×altura');
    images.push({ width: Number(m[1]), height: Number(m[2]), pixels: px });
  }
  return { pages, count, images, size, text };
}
