'use strict';

const { clean } = require('../status');
const SCREENS = ['resumen', 'agentes', 'plan', 'registro'];
const SIGNS = { running: ['●', '*', 32], done: ['✓', '+', 32], failed: ['✗', 'x', 31],
  quota: ['⏸', '!', 33], waiting: ['◌', 'o', 33], stale: ['?', '?', 33], pending: ['○', 'o', 90] };
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
  const mark = (state) => `${(SIGNS[state] || SIGNS.pending)[ascii ? 1 : 0]} ${state}`;
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
  put(['running', 'done', 'failed', 'quota', 'waiting', 'stale', 'pending'].map((s) => `${s}:${model.counts[s] || 0}`).join('  '));
  if (options.help) add('AYUDA', ['1-4: pantalla; Tab: siguiente; p: pausa; r: refrescar',
    'd: completadas en AGENTES; t: periodo en PLAN', 'j/k o flechas: elegir en REGISTRO; Enter: abrir; Esc: volver',
    '?: ayuda; q o Ctrl+C: salir']);
  else if (screen === 'resumen') {
    const active = model.agents.filter((a) => ['running', 'waiting', 'quota', 'stale'].includes(a.state));
    const now = model.now.text.split('\n').filter(Boolean);
    const working = active.length ? active.map((a) => ({ text: `${mark(a.state)} ${a.id} ${a.cli || '-'} ${duration(a.elapsedSeconds)} ${a.note || a.role || ''}`, state: a.state })) : ['(ninguno)'];
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
  } else {
    const selected = Math.max(0, Number(options.selected) || 0);
    if (options.openLog) {
      const row = model.rows[selected];
      add('REGISTRO', [row ? `${row.id} / ${row.cli || '-'} ${mark(row.state)}` : '(sin fila)', ...(row ? row.logLines.slice(-30) : [])]);
    } else add('REGISTRO', model.rows.map((row, index) => ({ text: `${index === selected ? '>' : ' '} ${row.id} ${mark(row.state)} ${row.cli || '-'} ${row.lastOutput}`, state: row.state })));
  }
  if (out.length >= height) out.length = height - 1;
  while (out.length < height - 1) out.push(' '.repeat(width));
  const footer = screen === 'registro' ? '1-4 pantalla  Tab siguiente  j/k elegir  Enter abrir  Esc volver  p pausa  r refresca  ? ayuda  q salir'
    : '1-4 pantalla  Tab siguiente  d completadas  t periodo  p pausa  r refresca  ? ayuda  q salir';
  out.push(pad(footer, width));
  return out.join('\n') + '\n';
}
module.exports = { render, SCREENS, duration };
