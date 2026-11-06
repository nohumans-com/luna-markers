// Markers: DOM wiring. Connects to LUNA, follows the focused session, and renders what logic.js
// computes: a marker list for the session. Every listener
// returned by onChange is kept and released when the session changes.

const $ = (id) => document.getElementById(id);
const DEMO = new URLSearchParams(location.search).has('demo'); // ?demo runs on an in-page mock session
const PREFS_KEY = 'com.nohumans.markers.prefs';
// A counter as HTML, with the | separators set apart so bar|beat|tick reads clearly.
const counter = (t) => esc(t).replace(/\|/g, '<i class="sep">|</i>');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const prefs = { time: 'bbt', sort: 'time', click: true, follow: true };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')); } catch { /* private window */ }
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private window */ } };

let luna;
let session;
let gen = 0;
let releases = [];
let markerReleases = [];
const keep = (u) => releases.push(u);

let rows = []; // what the list shows now
let selected = new Set(); // marker ids
let anchor; // last plainly clicked id, for shift-click
let filter = '';
let editing = false; // an inline input is open: do not rebuild the list under it
let dirty = false;
let lastCur;
let lastTick;
let nudgeUnit = 'beat';
const NUDGE = { bar: () => Luna.WHOLE_NOTE, beat: () => Luna.QUARTER_NOTE, sixteenth: () => Luna.SIXTEENTH_NOTE, tick: () => Luna.TICKS_PER_DISPLAY_TICK };

// ---- small UI helpers -------------------------------------------------------------------------

let toastTimer;
function toast(text, err) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = text;
  el.classList.toggle('err', !!err);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), err ? 4500 : 2200);
}

/** Run an action; turn a failure into a toast instead of an unhandled rejection. */
async function run(fn) {
  try { return await fn(); } catch (e) { toast(e?.message ?? String(e), true); return undefined; }
}

function sheet({ title, text, body, actions }) {
  const veil = document.createElement('div');
  veil.className = 'veil';
  veil.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h4>${esc(title)}</h4>${text ? `<p>${esc(text)}</p>` : ''}<div class="slot"></div><div class="btns"></div></div>`;
  const close = () => { veil.remove(); $('list')?.focus({ preventScroll: true }); };
  if (body) veil.querySelector('.slot').appendChild(body);
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `pill ${a.kind ?? ''}`;
    b.textContent = a.label;
    b.onclick = async () => { if ((await a.run?.(close)) !== false && !a.keepOpen) close(); };
    veil.querySelector('.btns').appendChild(b);
  }
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  veil.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.appendChild(veil);
  (veil.querySelector('textarea, input, .btns button:last-child')).focus();
  return close;
}

function menu(anchorEl, items) {
  document.querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.setAttribute('role', it.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (it.checked !== undefined) b.setAttribute('aria-checked', String(it.checked));
    b.innerHTML = `<span class="ck">${it.checked ? '\u2713' : ''}</span>${esc(it.label)}`;
    b.disabled = !!it.disabled;
    b.onclick = () => { m.remove(); it.run(); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = anchorEl.getBoundingClientRect();
  m.style.top = `${Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 6)}px`;
  m.style.left = `${Math.max(6, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 6))}px`;
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off, true); } };
  document.addEventListener('mousedown', off, true);
  m.querySelector('button:not(:disabled)')?.focus();
  m.addEventListener('keydown', (e) => { if (e.key === 'Escape') m.remove(); });
}

// ---- rendering --------------------------------------------------------------------------------

let raf = 0;
function schedule() {
  if (editing) { dirty = true; return; }
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (editing) { dirty = true; return; } // an edit opened after this render was queued
    render();
  });
}

// A ghost row at the end of the list: shown while hovering empty list space with the playhead not on a
// marker, so one click drops a marker at the playhead.
const GHOST = '<div class="row ghost" aria-hidden="true"><span class="num">+</span><span class="dot"></span><span class="nm">New marker</span><span class="loc r"></span><span class="len"></span></div>';

const selectedMarkers = () => [...selected].map((id) => session.markers.byId(id)).filter(Boolean);

function render() {
  if (!session) return;
  rows = MarkerLogic.rows(session, { filter, sort: prefs.sort });
  // Drop selections for markers that are gone.
  const live = new Set(session.markers.items.map((m) => m.id));
  for (const id of [...selected]) if (!live.has(id)) selected.delete(id);

  const all = session.markers.items.length;
  $('count').textContent = all ? `(${filter ? `${rows.length} of ${all}` : all})` : '';
  const list = $('list');
  const keepTop = list.scrollTop;
  if (!rows.length) {
    list.innerHTML = (all ? `<div class="empty"><b>No match</b>Nothing named &ldquo;${esc(filter)}&rdquo;.</div>` : '') + GHOST;
  } else {
    list.innerHTML = rows.map((r) => {
      const loc = prefs.time === 'time' ? r.time : r.bbt;
      const len = r.lengthSeconds === undefined ? '' : Luna.formatMinSec(r.lengthSeconds, { fraction: 1 });
      const cls = ['row', selected.has(r.id) ? 'sel' : '', r.current ? 'current' : '', r.atPlayhead ? 'atplayhead' : ''].filter(Boolean).join(' ');
      return `<div class="${cls}" role="option" data-id="${esc(r.id)}" aria-selected="${selected.has(r.id)}">`
        + `<span class="num">${r.number}</span>`
        + `<span class="dot ${r.css ? 'has' : ''}" style="${r.css ? `background:${r.css}` : ''}"></span>`
        + `<span class="nm" data-cell="nm" title="${esc(r.comments || r.name)}">${esc(r.name)}${r.comments ? `<small>${esc(r.comments)}</small>` : ''}</span>`
        + `<span class="loc r" data-cell="loc">${counter(loc)}</span>`
        + `<span class="len r">${counter(len)}</span></div>`;
    }).join('') + GHOST;
    // The skin paints .row[aria-selected="true"] steel blue.
  }
  list.scrollTop = keepTop;
  $('sum').textContent = '';
  $('prev').disabled = $('next').disabled = !all;
  renderInspector();
  paintTransport(true);
  paintBar();
}

function renderInspector() {
  const sel = selectedMarkers();
  const box = $('inspect');
  box.hidden = sel.length === 0;
  if (!sel.length) return;
  const body = $('insp-body');
  // Keep typing intact: if the user is in one of the inspector fields, leave it alone.
  if (body.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && body.dataset.for === [...selected].join(',')) return;
  body.dataset.for = [...selected].join(',');
  const one = sel.length === 1 ? sel[0] : undefined;
  const r = one && rows.find((x) => x.id === one.id) || (one && MarkerLogic.rows(session).find((x) => x.id === one.id));
  $('insp-title').textContent = one ? `Marker ${r?.number ?? ''}` : `${sel.length} markers`;
  const rgbNow = one ? MarkerLogic.colorToRgb(one.color.value) : undefined;
  const sw = (p) => `<button class="sw ${p.rgb ? '' : 'none'}" data-rgb="${p.rgb}" style="${p.rgb ? `background:${MarkerLogic.colorToCss(p.rgb)}` : ''}" title="${p.name}" aria-label="${p.name}" aria-pressed="${one ? rgbNow === p.rgb : false}"></button>`;
  // LUNA's own marker colors only (the same 16 as its color picker).
  const swatches = `<div class="swatches">${MarkerLogic.LUNA_PALETTE.map(sw).join('')}</div>`;
  const nudge = `<div class="f"><span class="lab">Nudge</span><div class="nudge"><button class="iconbtn" data-act="nudge-" title="Earlier" aria-label="Nudge earlier">&minus;</button><select id="unit" aria-label="Nudge amount">${[['bar', 'Bar'], ['beat', 'Beat'], ['sixteenth', '1/16'], ['tick', 'Tick']].map(([v, l]) => `<option value="${v}" ${v === nudgeUnit ? 'selected' : ''}>${l}</option>`).join('')}</select><button class="iconbtn" data-act="nudge+" title="Later" aria-label="Nudge later">+</button></div></div>`;
  if (one) {
    body.innerHTML = `
      <div class="f"><label for="f-name">Name</label><input type="text" id="f-name" value="${esc(one.name.value ?? '')}" autocomplete="off" spellcheck="false"></div>
      <div class="f"><label for="f-loc">${prefs.time === 'time' ? 'Time' : 'Location'}</label><input type="text" id="f-loc" value="${esc(prefs.time === 'time' ? r?.time : r?.bbt)}" autocomplete="off" spellcheck="false" title="Type bar|beat|tick (5|3|240) or min:sec (1:30.5)"></div>
      <div class="f"><label for="f-com">Comments</label><textarea id="f-com" spellcheck="false">${esc(one.comments.value ?? '')}</textarea></div>
      <div class="f"><span class="lab">Color</span><div class="palette">${swatches}</div></div>
      ${nudge}
      <div class="f"><span class="lab">Actions</span><div class="btns">
        <button class="pill" data-act="recall" title="Move the playhead here (Enter)">Recall</button>
        <button class="pill" data-act="toplayhead" title="Move this marker to the playhead">Set to playhead</button>
        <button class="pill" data-act="between" title="Select from this marker to the next, on every track">Select between</button>
        <button class="pill" data-act="loop" title="Loop from this marker to the next">Loop</button>
        <button class="pill" data-act="dup" title="Duplicate a bar later (Ctrl/Cmd+D)">Duplicate</button>
        <button class="pill danger" data-act="delete" title="Delete (Delete)">Delete</button>
      </div></div>`;
  } else {
    body.innerHTML = `
      <div class="multi">Edits apply to all ${sel.length} selected markers as one undo step.</div>
      <div class="f"><span class="lab">Color</span><div class="palette">${swatches}</div></div>
      ${nudge}
      <div class="f"><span class="lab">Actions</span><div class="btns"><button class="pill" data-act="dup">Duplicate</button><button class="pill danger" data-act="delete">Delete ${sel.length}</button></div></div>`;
  }
}

function paintTransport(force) {
  if (!session) return;
  const t = session.transport;
  const tick = MarkerLogic.playhead(session);
  const tl = session.musical.timeline;
  $('clock').innerHTML = counter(prefs.time === 'time' ? Luna.formatMinSec(tl.seconds(tick), { fraction: 2 }) : tl.formatBarBeat(tick));
  paintGhost(tick);
  const cur = session.markers.at(tick);
  const curId = cur?.id;
  const moved = curId !== lastCur || (!t.playing.value && tick !== lastTick);
  const changedCur = curId !== lastCur;
  lastCur = curId;
  lastTick = tick;
  if (force) return;
  if (moved) {
    schedule();
    if (changedCur && prefs.follow && t.playing.value && curId) {
      requestAnimationFrame(() => $('list').querySelector(`.row[data-id="${CSS.escape(curId)}"]`)?.scrollIntoView({ block: 'nearest' }));
    }
  }
}

function paintGhost(tick) {
  const list = $('list');
  const loc = list.querySelector('.ghost .loc');
  if (!loc) return;
  const tl = session.musical.timeline;
  loc.innerHTML = counter(prefs.time === 'time' ? Luna.formatMinSec(tl.seconds(tick), { fraction: 2 }) : tl.formatBarBeat(tick));
  list.classList.toggle('on-marker', session.markers.items.some((m) => m.location.value === tick));
}

// ---- scrollbar --------------------------------------------------------------------------------
// Drawn here (see index.html): present whenever the list is longer than its window, in a right-hand gutter.

function paintBar() {
  const list = $('list');
  const bar = $('vbar');
  const over = list.scrollHeight > list.clientHeight + 1;
  bar.hidden = !over;
  list.closest('.sect').classList.toggle('has-bar', over);
  if (!over) return;
  const track = bar.clientHeight;
  const thumbH = Math.max(44, Math.round(track * list.clientHeight / list.scrollHeight));
  const room = Math.max(1, list.scrollHeight - list.clientHeight);
  $('thumb').style.height = `${thumbH}px`;
  $('thumb').style.top = `${Math.round((list.scrollTop / room) * (track - thumbH))}px`;
}
$('list').addEventListener('scroll', paintBar, { passive: true });
new ResizeObserver(paintBar).observe($('list'));
$('thumb').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const list = $('list');
  const startY = e.clientY;
  const startTop = list.scrollTop;
  const room = list.scrollHeight - list.clientHeight;
  const span = Math.max(1, $('vbar').clientHeight - $('thumb').offsetHeight);
  $('vbar').classList.add('drag');
  $('thumb').setPointerCapture(e.pointerId);
  const move = (ev) => { list.scrollTop = startTop + ((ev.clientY - startY) / span) * room; };
  const up = () => { $('vbar').classList.remove('drag'); $('thumb').removeEventListener('pointermove', move); $('thumb').removeEventListener('pointerup', up); $('thumb').removeEventListener('pointercancel', up); };
  $('thumb').addEventListener('pointermove', move);
  $('thumb').addEventListener('pointerup', up);
  $('thumb').addEventListener('pointercancel', up);
});
$('vbar').addEventListener('pointerdown', (e) => {
  if (e.target !== $('vbar')) return; // a click on the track pages up or down
  const list = $('list');
  const above = e.clientY < $('thumb').getBoundingClientRect().top;
  list.scrollBy({ top: (above ? -1 : 1) * list.clientHeight * 0.9 });
});

// ---- selection --------------------------------------------------------------------------------

function select(ids, { recall = false } = {}) {
  selected = new Set(ids);
  render();
  if (recall && prefs.click && selected.size === 1) {
    const m = session.markers.byId([...selected][0]);
    if (m) run(() => MarkerLogic.recall(session, m));
  }
}

$('list').addEventListener('mousedown', (e) => {
  const rowEl = e.target.closest('.row');
  if (!rowEl || e.target.closest('input')) return;
  const id = rowEl.dataset.id;
  if (e.shiftKey && anchor) {
    const ids = rows.map((r) => r.id);
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) { select(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
  }
  if (e.metaKey || e.ctrlKey) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    anchor = id;
    select(next);
    return;
  }
  anchor = id;
  select([id], { recall: true });
});

$('list').addEventListener('mousemove', (e) => $('list').classList.toggle('hover-empty', e.target === $('list')));
$('list').addEventListener('mouseleave', () => $('list').classList.remove('hover-empty'));
$('list').addEventListener('click', (e) => {
  // Empty list space, playhead not parked on a marker: the ghost row is showing, so add one.
  if (e.target === $('list') && !$('list').classList.contains('on-marker')) addAtPlayhead();
});

$('list').addEventListener('dblclick', (e) => {
  const cell = e.target.closest('[data-cell]');
  const rowEl = e.target.closest('.row');
  if (!cell || !rowEl) return;
  startEdit(rowEl.dataset.id, cell.dataset.cell);
});

function startEdit(id, which) {
  const rowEl = $('list').querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  const m = session?.markers.byId(id);
  const r = rows.find((x) => x.id === id);
  if (!rowEl || !m || !r) return;
  const cell = rowEl.querySelector(`[data-cell="${which}"]`);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'edit';
  input.value = which === 'nm' ? r.name : prefs.time === 'time' ? r.time : r.bbt;
  input.setAttribute('aria-label', which === 'nm' ? 'Marker name' : 'Marker location');
  cell.replaceChildren(input);
  editing = true;
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    editing = false;
    const v = input.value;
    if (commit) {
      if (which === 'nm') { if (v !== r.name) await run(() => m.rename(v)); }
      else if (!(await run(() => MarkerLogic.setLocation(session, m, v))) && v.trim() !== (prefs.time === 'time' ? r.time : r.bbt)) toast('Not a position. Try 5|3|240 or 1:30.5', true);
    }
    dirty = false;
    render();
    $('list').focus({ preventScroll: true });
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
}

// ---- inspector actions ------------------------------------------------------------------------

$('insp-close').onclick = () => { select([]); $('list').focus({ preventScroll: true }); }; // the X on the details panel
$('insp-body').addEventListener('click', (e) => {
  const sw = e.target.closest('button.sw');
  if (sw) { run(() => MarkerLogic.recolor(session, selectedMarkers(), Number(sw.dataset.rgb))); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act) doAct(act);
});
$('insp-body').addEventListener('change', (e) => {
  const sel = selectedMarkers();
  const one = sel.length === 1 ? sel[0] : undefined;
  if (e.target.id === 'unit') nudgeUnit = e.target.value;
  else if (e.target.id === 'f-name' && one) run(() => one.name.value === e.target.value || one.rename(e.target.value));
  else if (e.target.id === 'f-com' && one) run(() => one.comments.value === e.target.value || one.setComments(e.target.value));
  else if (e.target.id === 'f-loc' && one) {
    run(async () => {
      if (!(await MarkerLogic.setLocation(session, one, e.target.value))) toast('Not a position. Try 5|3|240 or 1:30.5', true);
      renderInspector();
    });
  }
});
$('insp-body').addEventListener('keydown', (e) => {
  e.stopPropagation(); // typing in a field is not a list shortcut
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.target.blur();
  if (e.key === 'Escape') { e.target.blur(); $('list').focus({ preventScroll: true }); }
});

function doAct(act) {
  const sel = selectedMarkers();
  if (!sel.length) return;
  const one = sel.length === 1 ? sel[0] : undefined;
  const step = NUDGE[nudgeUnit]();
  return run(async () => {
    switch (act) {
      case 'recall': return one && MarkerLogic.recall(session, one);
      case 'toplayhead': return one && MarkerLogic.moveToPlayhead(session, one);
      case 'between': return one && ((await MarkerLogic.selectBetween(session, one)) || toast('This is the last marker: nothing after it to select to.'));
      case 'loop': return one && ((await MarkerLogic.loopBetween(session, one)) || toast('This is the last marker: nothing after it to loop to.'));
      case 'nudge-': return MarkerLogic.shift(session, sel, -step);
      case 'nudge+': return MarkerLogic.shift(session, sel, step);
      case 'dup':
        for (const m of sel) await MarkerLogic.duplicate(session, m);
        return undefined;
      case 'delete': {
        const ids = rows.map((r) => r.id);
        const firstIdx = Math.min(...sel.map((m) => ids.indexOf(m.id)).filter((i) => i >= 0));
        await MarkerLogic.remove(session, sel);
        const next = MarkerLogic.rows(session, { filter, sort: prefs.sort });
        selected = new Set(next.length ? [next[Math.min(firstIdx, next.length - 1)].id] : []);
        return render();
      }
      default: return undefined;
    }
  });
}

// ---- toolbar ----------------------------------------------------------------------------------

async function addAtPlayhead() {
  if (!session) return;
  await run(async () => {
    const m = await MarkerLogic.addAtPlayhead(session);
    if (!m) return;
    anchor = m.id;
    selected = new Set([m.id]);
    filter = '';
    $('q').value = '';
    render();
    startEdit(m.id, 'nm'); // name it straight away
  });
}
$('add').onclick = addAtPlayhead;
$('prev').onclick = () => session && run(() => MarkerLogic.step(session, -1));
$('next').onclick = () => session && run(() => MarkerLogic.step(session, 1));
$('q').oninput = (e) => { filter = e.target.value; render(); };
$('q').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.target.value = ''; filter = ''; render(); $('list').focus(); } };

function paintSegments() {
  for (const [id, key] of [['seg-time', 'time'], ['seg-sort', 'sort']]) {
    for (const b of $(id).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === prefs[key]));
  }
}
for (const id of ['seg-time', 'seg-sort']) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    prefs[id === 'seg-time' ? 'time' : 'sort'] = b.dataset.v;
    savePrefs(); paintSegments();
    if (session) { render(); body_resetInspector(); }
  });
}
function body_resetInspector() { $('insp-body').dataset.for = ''; renderInspector(); }
$('open-keys').onclick = () => $('keys').classList.toggle('show');

$('more').onclick = (e) => {
  const has = session?.markers.items.length > 0;
  menu(e.currentTarget, [
    { label: 'Click to locate', checked: prefs.click, run: () => { prefs.click = !prefs.click; savePrefs(); } },
    { label: 'Follow playhead', checked: prefs.follow, run: () => { prefs.follow = !prefs.follow; savePrefs(); } },
    '-',
    { label: 'Add at selection start', run: () => run(async () => { const m = await MarkerLogic.addAtSelection(session); if (!m) toast('Nothing is selected on the timeline.'); else select([m.id]); }) },
    '-',
    { label: 'Renumber auto-named markers', disabled: !has, run: () => run(async () => { const n = await MarkerLogic.renumber(session); toast(n ? `Renumbered ${n} marker${n === 1 ? '' : 's'}` : 'Already in order'); }) },
    { label: 'Select all', disabled: !has, run: () => select(rows.map((r) => r.id)) },
    '-',
    { label: 'Clear all markers…', disabled: !has, run: confirmClear },
  ]);
};

function confirmClear() {
  const n = session.markers.items.length;
  sheet({
    title: 'Clear all markers?',
    text: `This removes all ${n} marker${n === 1 ? '' : 's'} from the session. You can undo it in one step.`,
    actions: [
      { label: 'Cancel' },
      { label: 'Clear all', kind: 'danger', run: () => run(async () => { await MarkerLogic.clearAll(session); selected = new Set(); render(); toast('Cleared'); }) },
    ],
  });
}

// ---- keyboard ---------------------------------------------------------------------------------

// Numeric recall: ". 1 2 ." jumps to marker 12.
const entry = { active: false, digits: '', timer: 0 };
function entryStop() { entry.active = false; entry.digits = ''; clearTimeout(entry.timer); paintTransport(true); }
function entryShow() {
  toast(`Go to marker ${entry.digits || '…'}`);
  clearTimeout(entry.timer);
  entry.timer = setTimeout(entryStop, 3000);
}

function move(delta) {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const at = ids.indexOf([...selected].pop());
  const next = ids[Math.max(0, Math.min(ids.length - 1, at < 0 ? (delta > 0 ? 0 : ids.length - 1) : at + delta))];
  anchor = next;
  select([next], { recall: true });
  $('list').querySelector(`.row[data-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if (!session || editing || e.defaultPrevented) return;
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.closest('.sheet, .menu')) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;
  if (entry.active) {
    if (/^\d$/.test(k)) { entry.digits += k; entryShow(); e.preventDefault(); return; }
    if (k === '.') {
      const n = Number(entry.digits);
      entryStop();
      if (n) run(async () => { if (await MarkerLogic.recallNumber(session, n)) select([session.markers.sorted[n - 1].id]); else toast(`No marker ${n}`, true); });
      e.preventDefault();
      return;
    }
    if (k === 'Escape' || k === 'Backspace') { entryStop(); e.preventDefault(); return; }
    entryStop();
  }
  if (!mod && k === '.') { entry.active = true; entry.digits = ''; entryShow(); e.preventDefault(); return; }
  if (!mod && !e.altKey && (k === 'm' || k === 'M')) { addAtPlayhead(); e.preventDefault(); return; }
  if (!mod && k === '[') { $('prev').click(); e.preventDefault(); return; }
  if (!mod && k === ']') { $('next').click(); e.preventDefault(); return; }
  if (!mod && k === 'ArrowDown') { move(1); e.preventDefault(); return; }
  if (!mod && k === 'ArrowUp') { move(-1); e.preventDefault(); return; }
  if (!mod && k === 'Enter' && selected.size === 1) { doAct('recall'); e.preventDefault(); return; }
  if (!mod && (k === 'Delete' || k === 'Backspace') && selected.size) { doAct('delete'); e.preventDefault(); return; }
  if (mod && (k === 'd' || k === 'D') && selected.size) { doAct('dup'); e.preventDefault(); return; }
  if (mod && (k === 'a' || k === 'A')) { select(rows.map((r) => r.id)); e.preventDefault(); return; }
  if (k === 'Escape' && selected.size) { select([]); }
});

// ---- session ----------------------------------------------------------------------------------

function release() {
  for (const u of releases) u();
  for (const u of markerReleases) u();
  releases = [];
  markerReleases = [];
}

function watchMarkers() {
  for (const u of markerReleases) u();
  markerReleases = [];
  for (const m of session.markers.items) {
    for (const p of [m.name, m.location, m.color, m.comments]) markerReleases.push(p.onChange(schedule));
  }
}

let retryTimer;
let attempts = 0;
function bindSessionSoon(ms = 250) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(bindSession, ms);
}

async function bindSession() {
  clearTimeout(retryTimer);
  const mine = ++gen;
  release();
  entryStop();
  session = luna.sessions.current();
  $('app').hidden = !session;
  $('empty').hidden = !!session;
  selected = new Set();
  if (!session) {
    attempts = 0;
    $('empty').textContent = 'Open a LUNA session to see its markers.';
    $('status').textContent = 'No session open';
    return;
  }
  // Never leave the panel blank while LUNA is still opening the session.
  $('status').textContent = 'Loading session\u2026';
  $('inspect').hidden = true;
  $('list').innerHTML = '<div class="empty"><b>Loading markers\u2026</b></div>';
  try {
    await session.ready();
  } catch (e) {
    // LUNA can time a read out while it is still opening a session (a dev build, a big session).
    if (mine !== gen) return;
    attempts += 1;
    $('status').textContent = attempts < 6 ? 'Loading session\u2026' : `Could not load the session (${e?.message ?? e}). Retrying\u2026`;
    bindSessionSoon(Math.min(1000 * attempts, 8000));
    return;
  }
  if (mine !== gen) return; // the focused session changed while we waited
  attempts = 0;
  $('status').textContent = session.name.value ?? session.uid;
  keep(session.name.onChange(() => { $('status').textContent = session.name.value ?? session.uid; }));
  keep(session.markers.onChange(() => { watchMarkers(); schedule(); }));
  keep(session.musical.timeline.onChange(schedule));
  keep(session.transport.location.onChange(() => paintTransport()));
  keep(session.transport.playing.onChange(() => paintTransport()));
  keep(session.transport.playStart.onChange(() => paintTransport()));
  keep(session.transport.maxTick.onChange(schedule));
  watchMarkers();
  lastCur = undefined;
  lastTick = undefined;
  render();
}

function paintLink() {
  const s = luna?.status.value;
  const dot = $('link');
  dot.className = `ldot ${s === 'connected' ? 'ok' : s === 'disconnected' ? 'off' : 'wait'}`;
  dot.title = s === 'connected' ? 'Connected to LUNA' : s === 'disconnected' ? 'Reconnecting to LUNA' : 'Connecting to LUNA';
}

async function seedDemo(s) {
  const bar = Luna.WHOLE_NOTE;
  const P = MarkerLogic.LUNA_PALETTE;
  const enc = (i) => MarkerLogic.encodeColor(s.session ?? session, P[i].rgb);
  const list = [['Intro', 0, enc(10), ''], ['Verse 1', bar * 4, 0, 'Piano and vocal only'], ['Pre-Chorus', bar * 12, enc(6), ''], ['Chorus', bar * 16, enc(1), 'Full band, doubles in'], ['Verse 2', bar * 24, 0, ''], ['Chorus 2', bar * 32, enc(1), ''], ['Bridge', bar * 40, enc(0), 'Half-time feel'], ['Outro', bar * 48, enc(14), 'Fade']];
  for (const [name, tick, color, comments] of list) await s.addMarker(tick, name, { color: color || undefined, comments: comments || undefined });
}

async function connect() {
  for (;;) {
    try {
      // Inside LUNA the page URL carries ?port=; in a browser this falls back to LUNA on localhost.
      luna = DEMO
        ? await Luna.connect({ engine: 'mock', setup: (e) => e.addSession('demo', { name: 'Demo Session', tracks: ['Vocal', 'Piano', 'Bass', 'Drums'] }) })
        : await Luna.connect();
      break;
    } catch (e) {
      $('status').textContent = e instanceof Luna.NotRunning ? 'Waiting for LUNA…' : e.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  // LUNA's standard undo, redo, play and record keys, for any key this page does not handle.
  Luna.bindShortcuts(luna);
  luna.status.onChange(paintLink);
  luna.status.onChange(() => luna.status.value === 'connected' && session && bindSessionSoon(500)); // LUNA came back: rebind
  paintLink();
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  if (DEMO) {
    const s = luna.sessions.current();
    await s.ready();
    await seedDemo(s);
    await s.transport.seek({ bar: 14 });
  }
  await bindSession();
}

paintSegments();
// For `ua-builder probe` and the console: the live objects, read-only.
globalThis.markersAddOn = { get luna() { return luna; }, get session() { return session; }, get rows() { return rows; } };
connect();
