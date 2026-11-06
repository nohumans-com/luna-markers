// Markers: logic that does not touch the DOM, so tests can exercise it against Luna.MockEngine.
//
// A marker list window for LUNA: list, edit, recall and organize the session's markers. Everything
// here takes a Luna.Session and returns plain data or performs an engine action.
//
// Bulk edits write set_marker / delete_marker through the raw client inside one
// session.transaction(), so a rename-all, recolor or delete-many is ONE undo step. (The typed
// marker.rename()/delete() wait for the list to show the edit, and inside a batch transaction the
// list only catches up at the commit, so they are for single edits only.)

const MarkerLogic = {
  /**
   * Colors as 0xRRGGBB. LUNA_PALETTE is LUNA's own marker color picker (fill it from the app so
   * the two match exactly); EXTRA_PALETTE is ours, for fun (not shown in the UI for now). `rgb: 0` means "no color".
   */
  // From LUNA's source (hbsystem/shared/source/deck/UAColorUtils.cpp GetMarkerColors, which mirrors
  // color_wheel_marker.svg): the wheel's 16 colors in order. Stored as ARGB 0xFFRRGGBB.
  LUNA_PALETTE: [
    { name: 'Plum', rgb: 0x51275a }, { name: 'Violet', rgb: 0x6b2474 }, { name: 'Mulberry', rgb: 0x622341 }, { name: 'Raspberry', rgb: 0x6a1c38 },
    { name: 'Brick', rgb: 0x5f1817 }, { name: 'Rust', rgb: 0x633b1b }, { name: 'Ochre', rgb: 0x634d15 }, { name: 'Olive gold', rgb: 0x594f16 },
    { name: 'Olive', rgb: 0x3e4310 }, { name: 'Moss', rgb: 0x293e16 }, { name: 'Fir', rgb: 0x183e14 }, { name: 'Emerald', rgb: 0x063820 },
    { name: 'Pine teal', rgb: 0x133837 }, { name: 'Petrol', rgb: 0x143d4e }, { name: 'Steel blue', rgb: 0x1c3f62 }, { name: 'Indigo', rgb: 0x222755 },
  ],
  EXTRA_PALETTE: [
    { name: 'Red', rgb: 0xd9534f }, { name: 'Crimson', rgb: 0xc0243a }, { name: 'Coral', rgb: 0xff7f6e }, { name: 'Orange', rgb: 0xe8863a },
    { name: 'Amber', rgb: 0xe9b23c }, { name: 'Gold', rgb: 0xf2d04a }, { name: 'Lime', rgb: 0xa6d64a }, { name: 'Green', rgb: 0x5fbf6a },
    { name: 'Forest', rgb: 0x2f8f57 }, { name: 'Mint', rgb: 0x6fe0b0 }, { name: 'Teal', rgb: 0x3fb6c8 }, { name: 'Sky', rgb: 0x6cb8ff },
    { name: 'Blue', rgb: 0x3b6fd9 }, { name: 'Navy', rgb: 0x2a3f8f }, { name: 'Indigo', rgb: 0x5b4bd6 }, { name: 'Purple', rgb: 0xb04fd0 },
    { name: 'Magenta', rgb: 0xd63fb0 }, { name: 'Pink', rgb: 0xe5699a }, { name: 'Brown', rgb: 0x8a5a3c }, { name: 'Sand', rgb: 0xc9b08a },
    { name: 'Slate', rgb: 0x6b7280 }, { name: 'Silver', rgb: 0xc4c7cc }, { name: 'White', rgb: 0xf4f5f7 }, { name: 'Black', rgb: 0x111214 },
  ],

  /** A stored marker color (ARGB or plain RGB, whichever LUNA holds) -> '#rrggbb', or '' for none. */
  colorToCss(value) {
    const n = (value ?? 0) >>> 0;
    return n ? '#' + (n & 0xffffff).toString(16).padStart(6, '0') : '';
  },

  /** A stored color -> 0xRRGGBB (0 for none). */
  colorToRgb(value) {
    return ((value ?? 0) >>> 0) & 0xffffff;
  },

  /** '#rrggbb' -> 0xRRGGBB, or 0. */
  cssToRgb(css) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(css ?? '').trim());
    return m ? parseInt(m[1], 16) : 0;
  },

  /**
   * How this session stores marker colors. The SDK documents ARGB; LUNA's own tools describe
   * packed RGB. Follow the markers already there (any non-zero alpha byte means ARGB; colors
   * that all have a zero alpha byte mean RGB), and default to ARGB.
   */
  colorFormat(session) {
    const vals = session.markers.items.map((m) => (m.color.value ?? 0) >>> 0).filter((v) => v !== 0);
    if (vals.length && vals.every((v) => v >>> 24 === 0)) return 'rgb';
    return 'argb';
  },

  /** 0xRRGGBB -> the value to write, in the session's format. 0 stays 0 (none). */
  encodeColor(session, rgb) {
    if (!rgb) return 0;
    return MarkerLogic.colorFormat(session) === 'rgb' ? rgb >>> 0 : (0xff000000 | rgb) >>> 0;
  },

  /**
   * The color LUNA gives a new marker: the one after the most recently added marker's color on
   * its wheel (DkClnt_Markers::GetNextColor), or the first color when there are no markers or the
   * last one's color is not on the wheel. Returned as a stored value.
   */
  nextColor(session) {
    const wheel = MarkerLogic.LUNA_PALETTE.map((p) => p.rgb);
    const items = session.markers.items;
    const last = items.reduce((a, m) => (!a || (m.rowid.value ?? 0) > (a.rowid.value ?? 0) ? m : a), undefined);
    const at = last ? wheel.indexOf(MarkerLogic.colorToRgb(last.color.value)) : -1;
    return MarkerLogic.encodeColor(session, wheel[at >= 0 ? (at + 1) % wheel.length : 0]);
  },

  /** The session's playhead in ticks (live while playing, else the play start). */
  playhead(session) {
    return Math.max(0, Math.round(session.transport.tick ?? 0));
  },

  /**
   * One row per marker, in timeline order (or by name), with these columns:
   * number, name, location in both time scales, length to the next marker, color, comments.
   * `current` is the marker the playhead is in (the last one at or before it).
   */
  rows(session, { filter = '', sort = 'time' } = {}) {
    const tl = session.musical.timeline;
    const sorted = session.markers.sorted;
    const tick = MarkerLogic.playhead(session);
    const current = session.markers.at(tick);
    const stop = session.transport.maxTick.value;
    const all = sorted.map((m, i) => {
      const t = m.location.value ?? 0;
      const next = sorted[i + 1];
      const endTick = next ? (next.location.value ?? t) : undefined;
      return {
        id: m.id,
        rowid: m.rowid.value ?? Number(m.id),
        number: i + 1,
        name: m.name.value ?? '',
        tick: t,
        bbt: tl.formatBarBeat(t),
        seconds: tl.seconds(t),
        time: Luna.formatMinSec(tl.seconds(t), { fraction: 2 }),
        lengthSeconds: endTick === undefined ? undefined : tl.seconds(endTick) - tl.seconds(t),
        endTick,
        color: m.color.value ?? 0,
        css: MarkerLogic.colorToCss(m.color.value),
        rgb: MarkerLogic.colorToRgb(m.color.value),
        comments: m.comments.value ?? '',
        current: current !== undefined && current.id === m.id,
        atPlayhead: t === tick,
        _stop: stop,
      };
    });
    const q = String(filter).trim().toLowerCase();
    let out = q
      ? all.filter((r) => /^\d+$/.test(q)
        ? String(r.number) === q || r.name.toLowerCase().includes(q) // a bare number is a marker number
        : r.name.toLowerCase().includes(q) || r.comments.toLowerCase().includes(q) || (q.includes('|') && r.bbt.startsWith(q)))
      : all;
    if (sort === 'name') out = [...out].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return out;
  },

  /** Marker by list id. */
  find(session, id) {
    return session.markers.byId(id);
  },

  /** "Marker 4": the first "Marker N" name not already used. */
  nextName(session) {
    const used = new Set(session.markers.items.map((m) => m.name.value));
    let n = session.markers.items.length + 1;
    while (used.has(`Marker ${n}`)) n += 1;
    return `Marker ${n}`;
  },

  /** Add a marker at the playhead Re-uses one already there. */
  async addAtPlayhead(session, name) {
    const tick = MarkerLogic.playhead(session);
    const here = session.markers.items.find((m) => m.location.value === tick);
    if (here) return here;
    await session.addMarker(tick, name || MarkerLogic.nextName(session), { color: MarkerLogic.nextColor(session) });
    return session.markers.items.find((m) => m.location.value === tick);
  },

  /** Add a marker at the start of the edit selection, if any. */
  async addAtSelection(session) {
    const start = session.context.selectionStart.value;
    if (start === null || start === undefined) return undefined;
    await session.addMarker(Math.max(0, Math.round(start)), MarkerLogic.nextName(session), { color: MarkerLogic.nextColor(session) });
    return session.markers.items.find((m) => m.location.value === Math.round(start));
  },

  /** Add a marker at an exact tick. */
  async addAt(session, tick, name, options) {
    await session.addMarker(Math.max(0, Math.round(tick)), name || MarkerLogic.nextName(session), { color: MarkerLogic.nextColor(session), ...options });
  },

  /** Recall: move the playhead to the marker (click the row, or type its number). */
  recall(session, marker) {
    return session.transport.seek(marker.location.value ?? 0);
  },

  /** Recall marker number `n` (1-based, timeline order): the ". n ." numeric entry. */
  async recallNumber(session, n) {
    const m = session.markers.sorted[n - 1];
    if (!m) return false;
    await MarkerLogic.recall(session, m);
    return true;
  },

  /** The previous (dir < 0) or next (dir > 0) marker relative to the playhead. */
  neighbour(session, dir) {
    const tick = MarkerLogic.playhead(session);
    const sorted = session.markers.sorted;
    return dir < 0
      ? [...sorted].reverse().find((m) => (m.location.value ?? 0) < tick)
      : sorted.find((m) => (m.location.value ?? 0) > tick);
  },

  /** Jump to the previous/next marker. Resolves to the marker, or undefined at the ends. */
  async step(session, dir) {
    const m = MarkerLogic.neighbour(session, dir);
    if (m) await MarkerLogic.recall(session, m);
    return m;
  },

  /** The range from a marker to the next one (or to the end of the session). */
  span(session, marker) {
    const sorted = session.markers.sorted;
    const i = sorted.findIndex((m) => m.id === marker.id);
    const start = marker.location.value ?? 0;
    const next = sorted[i + 1];
    const stop = next ? next.location.value : session.transport.maxTick.value;
    return { startTick: start, stopTick: stop !== undefined && stop > start ? stop : undefined };
  },

  /** Select between this marker and the next, in every track. */
  async selectBetween(session, marker) {
    const { startTick, stopTick } = MarkerLogic.span(session, marker);
    if (stopTick === undefined) return false;
    await session.context.select({ startTick, stopTick });
    return true;
  },

  /** Set the loop range to this marker's span and turn looping on. */
  async loopBetween(session, marker) {
    const { startTick, stopTick } = MarkerLogic.span(session, marker);
    if (stopTick === undefined) return false;
    await session.transaction('Loop marker span', async () => {
      await session.transport.loopStart.set(startTick);
      await session.transport.loopStop.set(stopTick);
      await session.transport.looping.set(true);
    });
    return true;
  },

  /** Move a marker onto the playhead. */
  moveToPlayhead(session, marker) {
    return marker.moveTo(MarkerLogic.playhead(session));
  },

  /** Nudge a marker by a number of ticks (clamped at 0). */
  nudge(marker, ticks) {
    return marker.moveTo(Math.max(0, Math.round((marker.location.value ?? 0) + ticks)));
  },

  /** Duplicate a marker `ticks` later (default a bar of 4/4) with " copy" in the name. */
  async duplicate(session, marker, ticks = Luna.WHOLE_NOTE) {
    await session.addMarker(Math.round((marker.location.value ?? 0) + ticks), `${marker.name.value ?? 'Marker'} copy`, {
      color: marker.color.value || undefined,
      comments: marker.comments.value || undefined,
    });
  },

  /** Write a bulk set_marker for each marker, as one undo step. */
  async bulkSet(session, name, markers, fieldsFor) {
    if (!markers.length) return;
    const uid = session.uid ?? session.id;
    await session.transaction(name, async () => {
      for (const m of markers) {
        await session.client.raw.post(`/sessions/${uid}/set_marker`, { session_uid: uid, rowid: m.rowid.value ?? Number(m.id), ...fieldsFor(m) });
      }
    });
    await session.markers.reload();
  },

  /** Recolor markers with 0xRRGGBB (0 = none), one undo step. */
  recolor(session, markers, rgb) {
    const color = MarkerLogic.encodeColor(session, rgb);
    return MarkerLogic.bulkSet(session, 'Color markers', markers, () => ({ color }));
  },

  /** Shift markers by `ticks` (one undo step). Clamped at 0. */
  shift(session, markers, ticks) {
    return MarkerLogic.bulkSet(session, 'Move markers', markers, (m) => ({ location: Math.max(0, Math.round((m.location.value ?? 0) + ticks)) }));
  },

  /** Delete markers (one undo step). */
  async remove(session, markers) {
    if (!markers.length) return;
    const uid = session.uid ?? session.id;
    await session.transaction(markers.length === 1 ? 'Delete marker' : 'Delete markers', async () => {
      for (const m of markers) {
        await session.client.raw.post(`/sessions/${uid}/delete_marker`, { session_uid: uid, rowid: m.rowid.value ?? Number(m.id) });
      }
    });
    await session.markers.reload();
  },

  /**
   * Renumber: markers still carrying an auto name ("Marker 7") are renamed "Marker 1",
   * "Marker 2" ... in timeline order. Named markers are left alone. One undo step.
   */
  async renumber(session) {
    const auto = session.markers.sorted.filter((m) => /^Marker \d+$/.test(m.name.value ?? ''));
    const names = new Map(auto.map((m, i) => [m.id, `Marker ${i + 1}`]));
    const changed = auto.filter((m) => m.name.value !== names.get(m.id));
    await MarkerLogic.bulkSet(session, 'Renumber markers', changed, (m) => ({ name: names.get(m.id) }));
    return changed.length;
  },

  /** Clear every marker (one undo step). */
  clearAll(session) {
    return MarkerLogic.remove(session, [...session.markers.items]);
  },

  /**
   * Parse a typed location into a tick. Accepts bar|beat|tick ("5", "5|3", "5|3|240", with | . or
   * spaces; the tick is a display tick, 960 to the beat) or min:sec ("1:30", "01:30.50"). Returns
   * undefined when it is not a position.
   */
  parseTime(session, text) {
    const tl = session.musical.timeline;
    const s = String(text ?? '').trim();
    if (!s) return undefined;
    if (s.includes(':')) {
      const parts = s.split(':').map(Number);
      if (parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
      const seconds = parts.reduce((acc, n) => acc * 60 + n, 0);
      return Math.max(0, Math.round(tl.tickAtSeconds(seconds)));
    }
    const nums = s.split(/[|.\s]+/).filter(Boolean).map(Number);
    if (!nums.length || nums.length > 3 || nums.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
    const [bar, beat = 1, disp = 0] = nums;
    if (bar < 1 || beat < 1) return undefined;
    return Math.max(0, Math.round(tl.tickAt({ bar, beat, tick: disp * Luna.TICKS_PER_DISPLAY_TICK })));
  },

  /** Set a marker's location from typed text. Resolves to false when the text is not a position. */
  async setLocation(session, marker, text) {
    const tick = MarkerLogic.parseTime(session, text);
    if (tick === undefined) return false;
    await marker.moveTo(tick);
    return true;
  },
};

globalThis.MarkerLogic = MarkerLogic;
