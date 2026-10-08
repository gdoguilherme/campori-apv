// computeUnitBreakdown (portal do Conselheiro) x computeUnitScores (ranking): têm que dar SEMPRE o mesmo total.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeUnitBreakdown, computeUnitScores } from '../../shared/scoring.js';

const ts = s => ({ seconds: s, nanoseconds: 0 });
const U1 = { id: 'U1', name: 'Águias', regionId: 'R1' };
const units = [U1, { id: 'U2', name: 'Leões', regionId: 'R1' }, { id: 'U3', name: 'Lobos', regionId: 'R2' }];
const sub = (o) => ({ status: 'approved', submittedAt: ts(1000), ...o });

// Recorte que o servidor manda no bootstrap para a unidade U1 (a partir de TODAS as submissões/disciplinas)
const slice = (all, disc, unit) => ({
  unitSubmissions: all.filter(s => s.unitId === unit.id),
  regionSubmissions: all.filter(s => !s.unitId && s.regionId === unit.regionId),
  disciplinaryActions: disc.filter(d => (d.targetType === 'unit' && d.targetId === unit.id) || (d.targetType === 'region' && d.targetId === unit.regionId)),
});

test('cenário do pedido: 100 (unidade) + 50 (QR) + 30 (avaliação do fiscal na região) = 180, igual ao ranking', () => {
  const all = [
    sub({ id: 'a', unitId: 'U1', regionId: 'R1', requirementId: 'C1', requirementPoints: 100 }),
    sub({ id: 'b', unitId: 'U1', regionId: 'R1', requirementId: 'QR', requirementPoints: 50, source: 'qr' }),
    sub({ id: 'c', unitId: null, regionId: 'R1', requirementId: 'RG', requirementPoints: 30, source: 'judge', fiscalSuggestion: true }),
    sub({ id: 'd', unitId: 'U3', regionId: 'R2', requirementId: 'C1', requirementPoints: 999 }),     // outra região: não interfere
  ];
  const ranking = Object.fromEntries(computeUnitScores(all, units, []).map(s => [s.id, s.total]));
  assert.equal(ranking.U1, 180);
  const bd = computeUnitBreakdown({ unit: U1, ...slice(all, [], U1) });
  assert.deepEqual([bd.own, bd.region, bd.discipline, bd.total, bd.floored], [150, 30, 0, 180, false]);
  assert.equal(bd.total, ranking.U1, 'o card "pts confirmados" bate com o ranking');
  // a outra unidade da mesma região recebe só os 30 da região
  const u2 = computeUnitBreakdown({ unit: units[1], ...slice(all, [], units[1]) });
  assert.deepEqual([u2.own, u2.region, u2.total], [0, 30, 30]); assert.equal(u2.total, ranking.U2);
  // com disciplina: -5 só na unidade; -5 na região inteira (as duas unidades)
  const disc = [{ targetType: 'unit', targetId: 'U1', points: 5 }, { targetType: 'region', targetId: 'R1', points: 5 }];
  const r2 = Object.fromEntries(computeUnitScores(all, units, disc).map(s => [s.id, s.total]));
  const b1 = computeUnitBreakdown({ unit: U1, ...slice(all, disc, U1) });
  assert.deepEqual([b1.own, b1.region, b1.discipline, b1.total], [150, 30, 10, 170]); assert.equal(b1.total, r2.U1);
  assert.equal(computeUnitBreakdown({ unit: units[1], ...slice(all, disc, units[1]) }).total, r2.U2);   // 30 − 5 = 25
});

test('piso em 0 (como o ranking) e o aviso "mínimo 0"', () => {
  const all = [sub({ id: 'x', unitId: null, regionId: 'R1', requirementId: 'RG', requirementPoints: 5 })];
  const disc = Array.from({ length: 4 }, () => ({ targetType: 'unit', targetId: 'U1', points: 5 }));
  const bd = computeUnitBreakdown({ unit: U1, ...slice(all, disc, U1) });
  assert.deepEqual([bd.region, bd.discipline, bd.total, bd.floored], [5, 20, 0, true]);
  assert.equal(computeUnitScores(all, units, disc).find(s => s.id === 'U1').total, 0);
});

test('PROPRIEDADE: em milhares de cenários aleatórios o total do portal == total do ranking (e a composição fecha)', () => {
  let seed = 11; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let it = 0; it < 4000; it++) {
    const all = Array.from({ length: rnd(30) }, (_, i) => sub({
      id: `s${i}`, status: ['approved', 'approved', 'pending', 'rejected'][rnd(4)], regionId: 'R' + (1 + rnd(2)),
      unitId: rnd(2) ? units[rnd(3)].id : null, requirementId: 'q' + rnd(6), requirementPoints: rnd(40), submittedAt: ts(rnd(5000)),
    }));
    const disc = Array.from({ length: rnd(5) }, () => (rnd(2) ? { targetType: 'unit', targetId: units[rnd(3)].id, points: rnd(2) ? 5 : undefined } : { targetType: 'region', targetId: 'R' + (1 + rnd(2)) }));
    const ranking = Object.fromEntries(computeUnitScores(all, units, disc).map(s => [s.id, s.total]));
    for (const u of units) {
      const bd = computeUnitBreakdown({ unit: u, ...slice(all, disc, u) });
      assert.equal(bd.total, ranking[u.id], `iteração ${it}, unidade ${u.id}`);
      assert.equal(bd.total, Math.max(0, bd.own + bd.region - bd.discipline), 'composição: X + Y − Z (com piso em 0)');
      assert.equal(bd.floored, bd.own + bd.region - bd.discipline < 0);
    }
  }
});

test('dados em falta (snapshot antigo sem região/disciplina) não quebram: só a parte da unidade', () => {
  const bd = computeUnitBreakdown({ unit: U1, unitSubmissions: [sub({ id: 'a', unitId: 'U1', regionId: 'R1', requirementId: 'C1', requirementPoints: 7 })] });
  assert.deepEqual([bd.own, bd.region, bd.discipline, bd.total], [7, 0, 0, 7]);
});
