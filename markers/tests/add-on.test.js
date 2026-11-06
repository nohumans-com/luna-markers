// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const L = globalThis.MarkerLogic;
const BAR = Luna.TICKS_PER_BEAT * 4;

async function connected(markers = []) {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Vocal'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  for (const [name, tick] of markers) await session.addMarker(tick, name);
  return { engine, luna, session };
}

const names = (s) => L.rows(s).map((r) => r.name);

describe('Markers', () => {
  it('lists markers in timeline order with number, bar|beat and length to the next', async () => {
    const { session } = await connected([['Chorus', BAR * 8], ['Intro', 0], ['Verse', BAR * 4]]);
    const rows = L.rows(session);
    expect(rows.map((r) => [r.number, r.name, r.bbt])).toEqual([[1, 'Intro', '1|1|000'], [2, 'Verse', '5|1|000'], [3, 'Chorus', '9|1|000']]);
    expect(rows[0].lengthSeconds).toBeCloseTo(8, 3); // 4 bars at 120 BPM 4/4
    expect(rows[2].lengthSeconds).toBeUndefined();
  });

  it('filters by name, comment and number, and sorts by name', async () => {
    const { session } = await connected([['Verse', BAR], ['Chorus', BAR * 2], ['Bridge', BAR * 3]]);
    expect(L.rows(session, { filter: 'ch' }).map((r) => r.name)).toEqual(['Chorus']);
    expect(L.rows(session, { filter: '3' }).map((r) => r.name)).toEqual(['Bridge']);
    expect(L.rows(session, { sort: 'name' }).map((r) => r.name)).toEqual(['Bridge', 'Chorus', 'Verse']);
  });

  it('flags the marker the playhead is in', async () => {
    const { session } = await connected([['A', 0], ['B', BAR * 4]]);
    await session.transport.seek({ bar: 6 });
    await Luna.settle(() => session.transport.tick === BAR * 5, 'seek');
    expect(L.rows(session).map((r) => r.current)).toEqual([false, true]);
  });

  it('adds a marker at the playhead, once per position', async () => {
    const { session } = await connected();
    await session.transport.seek({ bar: 3 });
    await Luna.settle(() => session.transport.tick === BAR * 2, 'seek');
    const m = await L.addAtPlayhead(session);
    expect(m.location.value).toBe(BAR * 2);
    expect(m.name.value).toBe('Marker 1');
    expect(await L.addAtPlayhead(session)).toBe(m);
    expect(session.markers.items.length).toBe(1);
  });

  it('recalls a marker by id and by number, and steps to neighbours', async () => {
    const { session } = await connected([['A', 0], ['B', BAR * 2], ['C', BAR * 4]]);
    expect(await L.recallNumber(session, 2)).toBe(true);
    await Luna.settle(() => session.transport.tick === BAR * 2, 'recall');
    expect((await L.step(session, 1)).name.value).toBe('C');
    await Luna.settle(() => session.transport.tick === BAR * 4, 'next');
    expect((await L.step(session, -1)).name.value).toBe('B');
    expect(await L.recallNumber(session, 9)).toBe(false);
  });

  it('parses typed bar|beat and min:sec positions', async () => {
    const { session } = await connected();
    expect(L.parseTime(session, '5')).toBe(BAR * 4);
    expect(L.parseTime(session, '5|3')).toBe(BAR * 4 + Luna.TICKS_PER_BEAT * 2);
    expect(L.parseTime(session, '5.3.240')).toBe(BAR * 4 + Luna.TICKS_PER_BEAT * 2 + 240 * Luna.TICKS_PER_DISPLAY_TICK);
    expect(L.parseTime(session, '0:08')).toBe(BAR * 4); // 8 s at 120 BPM = 4 bars
    expect(L.parseTime(session, 'nope')).toBeUndefined();
    expect(L.parseTime(session, '0|1')).toBeUndefined();
  });

  it('edits location from typed text and nudges, clamping at zero', async () => {
    const { session } = await connected([['A', BAR]]);
    const m = session.markers.items[0];
    expect(await L.setLocation(session, m, '3|1')).toBe(true);
    expect(m.location.value).toBe(BAR * 2);
    expect(await L.setLocation(session, m, 'x')).toBe(false);
    await L.nudge(m, -BAR * 10);
    expect(m.location.value).toBe(0);
  });

  it('recolors, shifts and deletes many markers as one undo step each', async () => {
    const { engine, session } = await connected([['A', 0], ['B', BAR], ['C', BAR * 2]]);
    const all = session.markers.sorted;
    engine.transactions.length = 0;
    await L.recolor(session, all, 0xffd9534f);
    expect(all.map((m) => m.color.value)).toEqual([0xffd9534f, 0xffd9534f, 0xffd9534f]);
    expect(engine.transactions).toEqual(['begin', 'commit']);
    await L.shift(session, all, BAR);
    expect(all.map((m) => m.location.value)).toEqual([BAR, BAR * 2, BAR * 3]);
    engine.transactions.length = 0;
    await L.remove(session, all.slice(0, 2));
    expect(names(session)).toEqual(['C']);
    expect(engine.transactions).toEqual(['begin', 'commit']);
  });

  it('renumbers auto-named markers and leaves named ones', async () => {
    const { session } = await connected([['Marker 7', BAR * 3], ['Intro', 0], ['Marker 2', BAR]]);
    expect(await L.renumber(session)).toBe(2);
    expect(names(session)).toEqual(['Intro', 'Marker 1', 'Marker 2']);
  });

  it('selects and loops between a marker and the next', async () => {
    const { engine, session } = await connected([['A', BAR], ['B', BAR * 3]]);
    const a = session.markers.sorted[0];
    expect(L.span(session, a)).toEqual({ startTick: BAR, stopTick: BAR * 3 });
    expect(await L.loopBetween(session, a)).toBe(true);
    await engine.settled();
    expect(session.transport.loopStart.value).toBe(BAR);
    expect(session.transport.loopStop.value).toBe(BAR * 3);
    expect(session.transport.looping.value).toBe(true);
  });

  it('reads colors stored as ARGB or plain RGB, and writes in the format already in use', async () => {
    expect(L.colorToCss(0xffd9534f)).toBe('#d9534f');
    expect(L.colorToCss(0xd9534f)).toBe('#d9534f');
    expect(L.colorToCss(0)).toBe('');
    expect(L.cssToRgb('#d9534f')).toBe(0xd9534f);
    expect(L.cssToRgb('bad')).toBe(0);
    const argb = await connected([['A', 0]]);
    expect(L.colorFormat(argb.session)).toBe('argb'); // default
    expect(L.encodeColor(argb.session, 0xd9534f)).toBe(0xffd9534f);
    await L.recolor(argb.session, argb.session.markers.items, 0xd9534f);
    expect(argb.session.markers.items[0].color.value).toBe(0xffd9534f);
    const plain = await connected([['A', 0]]);
    await plain.session.markers.items[0].setColor(0x3b6fd9); // LUNA-style RGB marker
    expect(L.colorFormat(plain.session)).toBe('rgb');
    await L.recolor(plain.session, plain.session.markers.items, 0xd9534f);
    expect(plain.session.markers.items[0].color.value).toBe(0xd9534f);
    expect(L.rows(plain.session)[0].css).toBe('#d9534f');
  });

  it("uses LUNA's 16 wheel colors and cycles them for new markers like LUNA does", async () => {
    expect(L.LUNA_PALETTE.map((p) => p.rgb.toString(16).padStart(6, '0'))).toEqual([
      '51275a', '6b2474', '622341', '6a1c38', '5f1817', '633b1b', '634d15', '594f16',
      '3e4310', '293e16', '183e14', '063820', '133837', '143d4e', '1c3f62', '222755']);
    const { session } = await connected();
    expect(L.nextColor(session)).toBe(0xff51275a); // first color when there are no markers
    await L.addAt(session, 0, 'A');
    await L.addAt(session, BAR, 'B');
    await L.addAt(session, BAR * 2, 'C');
    expect(session.markers.sorted.map((m) => m.color.value)).toEqual([0xff51275a, 0xff6b2474, 0xff622341]);
    await L.addAt(session, BAR * 3, 'D', { color: 0xff222755 }); // explicit color wins
    expect(L.nextColor(session)).toBe(0xff51275a); // wraps after the last wheel color
  });
});
