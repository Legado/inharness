'use strict';

const { clean } = require('../status');
const SCREENS = ['resumen', 'agentes', 'plan', 'registro', 'dependencias'];
// Un color por estado (antes running/done eran el mismo verde y quota/waiting/stale el mismo amarillo).
// Amarillo queda SOLO para «sin cupo», que es lo único que necesita decisión.
const SIGNS = { running: ['●', '*', 36], done: ['✓', '+', 32], failed: ['✗', 'x', 31],
  quota: ['⏸', '!', 33], waiting: ['◌', 'o', 34], stale: ['?', '?', 35], pending: ['○', 'o', 90] };
const LABELS = { running: 'en marcha', done: 'hecha', failed: 'fallida', quota: 'sin cupo',
  waiting: 'esperando', stale: 'sin señal', pending: 'pendiente' };
const MEANING = { running: 'trabajando ahora', done: 'terminada', failed: 'acabó con error',
  quota: 'el CLI agotó su límite de uso: hay que relevarla o esperar', waiting: 'espera a otra fila',
  stale: 'figura en marcha pero no hay proceso vivo', pending: 'aún no ha empezado' };
function duration(value) {
  if (value == null) return '-';
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m`;
}
function render(model, options = {}) {
  const width = Math.max(80, Number(options.columns) || 80);
  const height = Math.max(24, Number(options.rows) || 24);
  const ascii = Boolean(options.ascii);
  const color = Boolean(options.color) && !process.env.NO_COLOR;
  const screen = SCREENS.includes(options.screen) ? options.screen : 'resumen';
  const glyph = (wide, narrow) => ascii ? narrow : wide;
  const plain = (s) => {
    const value = clean(s);
    return ascii ? value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?') : value;
  };
  const clip = (s, n) => {
    const value = plain(s);
    if (value.length <= n) return value;
    const end = Math.max(0, n - (ascii ? 3 : 1));
    let cut = value.slice(0, end);
    const space = cut.lastIndexOf(' ');
    if (space > end * 0.6) cut = cut.slice(0, space);
    return cut + glyph('…', '...');
  };
  const pad = (s, n) => clip(s, n).padEnd(n);
  const tint = (s, state) => color && state ? `\x1b[${(SIGNS[state] || SIGNS.pending)[2]}m${s}\x1b[0m` : s;
  const mark = (state) => `${(SIGNS[state] || SIGNS.pending)[ascii ? 1 : 0]} ${LABELS[state] || state}`;
  const box = (title, items, n) => {
    const h = glyph('─', '-'); const v = glyph('│', '|');
    const name = clip(` ${title} `, n - 4);
    return [`${glyph('┌', '+')}${h}${name}${h.repeat(n - 4 - name.length)}${h}${glyph('┐', '+')}`,
      ...items.map((item) => {
        const entry = typeof item === 'string' ? { text: item } : item;
        return tint(`${v} ${pad(entry.text, n - 4)} ${v}`, entry.state);
      }), `${glyph('└', '+')}${h.repeat(n - 2)}${glyph('┘', '+')}`];
  };
  const out = [];
  const put = (s, state) => out.push(tint(pad(s, width), state));
  const add = (title, items) => out.push(...box(title, items, width));
  put(`INHARNESS BOARD  ${model.project}  ${screen.toUpperCase()}  ${model.generatedAt}`);
  const doneCells = model.total ? Math.round(20 * model.completed / model.total) : 0;
  put(`[${glyph('█', '#').repeat(doneCells)}${glyph('░', '.').repeat(20 - doneCells)}] ${model.completed}/${model.total}  desde inicio ${duration(model.elapsedSeconds)}`);
  // Leyenda: símbolo + nombre + cuántas, cada estado en su color; debajo, qué significa lo que no es obvio.
  const legendStates = ['running', 'done', 'failed', 'quota', 'waiting', 'stale', 'pending'];
  out.push(legendStates.filter((st) => st === 'running' || st === 'done' || model.counts[st])
    .map((st) => tint(`${SIGNS[st][ascii ? 1 : 0]} ${LABELS[st]} ${model.counts[st] || 0}`, st)).join('   '));
  const hints = legendStates.filter((st) => ['quota', 'waiting', 'stale', 'failed'].includes(st) && model.counts[st])
    .map((st) => `${LABELS[st]} = ${MEANING[st]}`);
  for (const hint of hints) put(hint);
  if (options.help) add('AYUDA', ['1-5: pantalla (5 = dependencias); Tab: siguiente; p: pausa; r: refrescar',
    'd: completadas en AGENTES y DEPENDENCIAS; t: periodo en PLAN', 'j/k o flechas: elegir en REGISTRO; Enter: abrir; Esc: volver',
    '?: ayuda; q o Ctrl+C: salir']);
  else if (screen === 'resumen') {
    const isOld = (a) => a.state === 'stale' && (a.elapsedSeconds || 0) > 86400;
    const oldStale = model.agents.filter(isOld);
    const active = model.agents.filter((a) => ['running', 'waiting', 'quota', 'stale'].includes(a.state) && !isOld(a));
    const now = model.now.text.split('\n').filter(Boolean);
    const working = active.length || oldStale.length ? [...active.map((a) => ({ text: `${mark(a.state)} ${a.id} ${a.cli || '-'}/${a.model || '-'} ${duration(a.elapsedSeconds)} ${a.note || a.role || ''}`, state: a.state })), ...(oldStale.length ? [`+${oldStale.length} filas de hace más de 24 h marcadas en marcha sin proceso vivo (casi seguro terminaron sin avisar); ocultas`] : [])] : ['(ninguno)'];
    const providers = model.providers.map((p) => {
      const cells = p.total ? Math.round(8 * p.done / p.total) : 0;
      return { text: `${p.cli} [${glyph('█', '#').repeat(cells)}${glyph('░', '.').repeat(8 - cells)}] ${p.done}/${p.total || 0} vivos:${p.active} filas:${(p.activeRows || []).join(',') || '-'}${p.quota ? ' cupo?' : ''}`,
        state: p.quota ? 'quota' : p.active ? 'running' : undefined };
    });
    const activity = [...model.events].sort((a, b) => b.at.localeCompare(a.at)).map((e) => `${e.at.slice(11, 19)} ${e.text}`);
    if (width >= 120) {
      const leftWidth = Math.floor((width - 2) / 2); const rightWidth = width - leftWidth - 2;
      const left = [...box(`AHORA (hace ${duration(model.now.ageSeconds)})`, now.slice(0, 10), leftWidth),
        ...box(`EN MARCHA (${active.length})`, working.slice(0, Math.max(1, height - 18)), leftWidth)];
      const right = [...box('PROVEEDORES', providers, rightWidth), ...box('ACTIVIDAD', activity.slice(0, 8), rightWidth)];
      for (let i = 0; i < Math.max(left.length, right.length); i += 1) out.push(`${left[i] || ' '.repeat(leftWidth)}  ${right[i] || ' '.repeat(rightWidth)}`);
    } else {
      add(`AHORA (hace ${duration(model.now.ageSeconds)})`, now.slice(0, 2));
      add(`EN MARCHA (${active.length})`, working.slice(0, 2));
      add('PROVEEDORES', providers);
      add('ACTIVIDAD', activity.slice(0, 5));
    }
  } else if (screen === 'agentes') {
    const live = model.agents.filter((a) => ['running', 'waiting', 'quota', 'failed', 'stale'].includes(a.state));
    const done = model.agents.filter((a) => a.state === 'done').sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''));
    const pending = model.agents.filter((a) => a.state === 'pending');
    const byId = new Map(model.agents.map((a) => [a.id, a]));
    const item = (a) => {
      const ancestors = []; let parent = a.parent;
      while (parent && byId.has(parent) && !ancestors.includes(parent) && ancestors.length < 8) {
        ancestors.unshift(parent); parent = byId.get(parent).parent;
      }
      return { text: `${mark(a.state)} ${[...ancestors, a.id].join(' > ')} [${a.kind}] ${a.cli || '-'} / ${a.model || '-'} ${duration(a.elapsedSeconds)} ${a.note || a.role || ''}`, state: a.state };
    };
    const maxLive = Math.max(2, height - (pending.length ? 20 : 17));
    add(`VIVO (${live.length})`, live.length ? [...live.slice(0, maxLive).map(item),
      ...(live.length > maxLive ? [`+${live.length - maxLive} mas vivos`] : [])] : ['(ninguno)']);
    const maxDone = options.showDone ? Math.max(0, height - out.length - (pending.length ? 14 : 8)) : 0;
    add('COMPLETADAS', [`${done.length} completadas (ultimas: ${done.slice(0, 3).map((a) => a.id).join(', ') || '-'})`,
      ...(options.showDone ? done.slice(0, maxDone).map(item) : []),
      ...(options.showDone && done.length > maxDone ? [`+${done.length - maxDone} mas completadas`] : [])]);
    if (pending.length) add(`PENDIENTES (${pending.length})`, [...pending.slice(0, 3).map(item), ...(pending.length > 3 ? [`+${pending.length - 3} mas`] : [])]);
    const loose = model.processes.filter((p) => !p.registered);
    const processRoom = Math.max(0, height - out.length - 4);
    add(`PROCESOS CLI SIN FILA (${loose.length})`, loose.length ? [...loose.slice(0, processRoom).map((p) => `${p.pid} ${p.cli} ${duration(p.elapsedSeconds)} ${p.command}`),
      ...(loose.length > processRoom ? [`+${loose.length - processRoom} mas procesos`] : [])] : ['(ninguno)']);
  } else if (screen === 'plan') {
    const end = Date.parse(model.generatedAt);
    const period = ['1h', '12h', 'todo'].includes(options.period) ? options.period : '12h';
    const starts = model.rows.map((r) => Date.parse(r.startedAt || r.logAt)).filter(Number.isFinite);
    const origin = period === 'todo' ? Math.min(end, ...starts) : end - (period === '1h' ? 3600000 : 12 * 3600000);
    const barWidth = Math.max(12, Math.min(42, width - 43));
    const scale = (time) => Math.max(0, Math.min(barWidth - 1, Math.floor((time - origin) / Math.max(1, end - origin) * (barWidth - 1))));
    const finish = (r) => Date.parse(r.finishedAt || (['done', 'failed'].includes(r.state) ? r.logAt : null)) || end;
    const timed = model.rows.filter((r) => Number.isFinite(Date.parse(r.startedAt || r.logAt))
      && Date.parse(r.startedAt || r.logAt) <= end && finish(r) >= origin && r.state !== 'pending');
    const bar = (r) => {
      const cells = Array(barWidth).fill(glyph('·', '.'));
      for (let i = scale(Date.parse(r.startedAt || r.logAt)); i <= scale(finish(r)); i += 1) cells[i] = glyph('█', '#');
      return { text: `${pad(r.id, 10)} ${cells.join('')} ${mark(r.state)} ${duration(r.elapsedSeconds)}`, state: r.state };
    };
    add(`LINEA DE TIEMPO ${period} ${new Date(origin).toISOString().slice(11, 16)} .. ${model.generatedAt.slice(11, 16)}`,
      [`${' '.repeat(11)}${pad(new Date(origin).toISOString().slice(11, 16), barWidth - 5)}${model.generatedAt.slice(11, 16)}`]);
    const live = timed.filter((r) => !['done', 'failed'].includes(r.state));
    if (live.length) {
      const maxLive = Math.max(2, Math.floor((height - 12) * 0.55));
      add(`EN CURSO (${live.length})`, [...live.sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || '')).slice(0, maxLive).map(bar),
        ...(live.length > maxLive ? [`+${live.length - maxLive} mas en curso`] : [])]);
    }
    const hasDeps = model.rows.filter((r) => r.dependencies.length).length >= Math.max(2, Math.ceil(model.rows.length / 4));
    const groups = new Map();
    for (const r of timed.filter((a) => ['done', 'failed'].includes(a.state))) {
      const key = hasDeps ? `ola ${r.wave === null ? 'CICLO' : r.wave}` : `${(r.finishedAt || r.logAt || r.startedAt).slice(0, 13)}h`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const pending = model.rows.filter((r) => r.state === 'pending' && !r.startedAt);
    for (const [key, group] of [...groups].sort((a, b) => b[0].localeCompare(a[0]))) {
      if (out.length + 5 + (pending.length ? 5 : 0) >= height) break;
      group.sort((a, b) => (b.finishedAt || b.logAt || '').localeCompare(a.finishedAt || a.logAt || ''));
      add(`HECHAS ${key} (${group.length})`, [...group.slice(0, 3).map(bar),
        ...(group.length > 3 ? [`+${group.length - 3} mas: ${group.slice(3, 6).map((r) => r.id).join(', ')}`] : [])]);
    }
    if (pending.length) add(`PLANIFICADO (${pending.length})`, [...pending.slice(0, 4).map((r) => `${r.id} espera: ${r.dependencies.join(', ') || 'sin dependencias'}`),
      ...(pending.length > 4 ? [`+${pending.length - 4} mas pendientes`] : [])]);
    if (!timed.length && !pending.length) add('PLAN', ['(sin filas en este periodo)']);
  } else if (screen === 'dependencias') {
    const byId = new Map(model.rows.map((r) => [r.id, r]));
    const unlocks = new Map();
    for (const r of model.rows) for (const d of r.dependencies.filter((x) => byId.has(x))) { if (!unlocks.has(d)) unlocks.set(d, []); unlocks.get(d).push(r.id); }
    const sym = (id) => { const r = byId.get(id); return r ? `${id}${(SIGNS[r.state] || SIGNS.pending)[ascii ? 1 : 0]}` : `${id}?`; };
    const rowDeps = (r) => r.dependencies.filter((d) => byId.has(d));
    const externalDeps = (r) => r.dependencies.filter((d) => !byId.has(d));
    const oldStale = (r) => r.state === 'stale' && (r.elapsedSeconds || 0) > 86400;
    const hasOpenChild = (r) => (unlocks.get(r.id) || []).some((id) => byId.get(id) && byId.get(id).state !== 'done');
    const visible = model.rows.filter((r) => options.showDone || (r.state !== 'done' && !oldStale(r)) || hasOpenChild(r));
    const hiddenDone = model.rows.length - visible.length;
    const waves = new Map();
    for (const r of visible) { const key = r.cycle || r.wave === null ? 'ciclo' : r.wave; if (!waves.has(key)) waves.set(key, []); waves.get(key).push(r); }
    add('CÓMO LEER ESTO', ['Cada fila muestra de quién depende (←) y a quién desbloquea (→). El símbolo junto al id es su estado.',
      'Una fila pendiente está LISTA si todo lo que espera ya está hecho, o BLOQUEADA si no.']);
    const keys = [...waves.keys()].sort((a, b) => (a === 'ciclo') - (b === 'ciclo') || a - b);
    for (const key of keys) {
      const title = key === 'ciclo' ? 'DEPENDENCIA CIRCULAR (revisar assignment.md)' : key === 0 ? 'OLA 0 · no esperan a nadie' : `OLA ${key} · esperan a la ola ${key - 1}`;
      const items = [];
      for (const r of waves.get(key)) {
        const pendingDeps = rowDeps(r).filter((d) => byId.get(d).state !== 'done');
        let verdict = '';
        if (['pending', 'waiting'].includes(r.state)) verdict = pendingDeps.length ? `  BLOQUEADA por ${pendingDeps.join(', ')}` : '  LISTA para arrancar';
        items.push({ text: `${mark(r.state)}  ${r.id}  ${r.role || ''}${verdict}`, state: r.state });
        const ext = externalDeps(r).length ? ` · requiere: ${externalDeps(r).join(' ')}` : '';
        const left = (rowDeps(r).length ? `← espera a: ${rowDeps(r).map(sym).join(' ')}` : '← no depende de otras filas') + ext;
        const right = (unlocks.get(r.id) || []).length ? `→ desbloquea: ${unlocks.get(r.id).map(sym).join(' ')}` : '→ no bloquea a nadie';
        items.push({ text: `     ${left}   ${right}${r.cli ? `   [${r.cli}]` : ''}`, state: r.state === 'done' ? 'pending' : r.state });
      }
      add(title, items);
    }
    if (!visible.length) add('DEPENDENCIAS', ['(todo está hecho; pulsa d para ver el historial)']);
    if (hiddenDone > 0 && !options.showDone) out.push(pad(`${hiddenDone} filas hechas o antiguas sin señal ocultas · d: verlas`, width));
  } else {
    const selected = Math.max(0, Number(options.selected) || 0);
    if (options.openLog) {
      const row = model.rows[selected];
      add('REGISTRO', [row ? `${row.id} / ${row.cli || '-'} ${mark(row.state)}` : '(sin fila)', ...(row ? row.logLines.slice(-30) : [])]);
    } else add('REGISTRO', model.rows.map((row, index) => ({ text: `${index === selected ? '>' : ' '} ${row.id} ${mark(row.state)} ${row.cli || '-'} ${row.lastOutput}`, state: row.state })));
  }
  if (out.length >= height) out.length = height - 1;
  while (out.length < height - 1) out.push(' '.repeat(width));
  const footer = screen === 'registro' ? '1-5 pantalla  Tab siguiente  j/k elegir  Enter abrir  Esc volver  p pausa  r refresca  ? ayuda  q salir'
    : '1-5 pantalla (5 = dependencias)  Tab siguiente  d completadas  t periodo  p pausa  r refresca  ? ayuda  q salir';
  out.push(pad(footer, width));
  return out.join('\n') + '\n';
}
module.exports = { render, SCREENS, duration };
