import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ListeningState, parseSnapshot, type Track, type Snapshot } from '../src/state.ts';
import { defaults } from '../src/config.ts';
import { MusicWorld } from '../src/world.ts';
import { NeteaseComments, type CommentReference, type CommentProvider } from '../src/comments.ts';
import type { WorldHost } from 'cortico/core/types.ts';
const t = (title = 'A', status: Track['status'] = 'playing', positionSeconds?: number): Track =>
  ({ title, artist: 'artist', album: '', app: 'cloudmusic', method: 'smtc', status, positionSeconds });
test('absent player stays quiet and a later launch becomes eligible', () => {
  const s = new ListeningState(), cfg = defaults();
  s.update(null, 1000); assert.equal(s.offer(cfg, 9000), null);
  s.update(t(), 10000); assert.equal(s.offer(cfg, 12000), null);
  s.update(t(), 18000); assert.ok(s.offer(cfg, 18000));
});
test('seek waits for stability; progress alone and repeat loops do not create repeated comments', () => {
  const s = new ListeningState(), cfg = defaults();
  s.update(t('A', 'playing', 10), 1000);
  s.update(t('A', 'playing', 12), 3000);
  s.update(t('A', 'playing', 100), 5000);
  assert.equal(s.offer(cfg, 10000), null);
  s.update(t('A', 'playing', 108), 13000); assert.ok(s.offer(cfg, 13000));
  s.commit(t(), s.revision, 13000);
  s.update(t('A', 'playing', 0), 14000);
  s.update(t('A', 'playing', 8), 22000);
  assert.equal(s.offer(cfg, 22000), null);
});
test('sleep gaps and backwards clocks require fresh stable observations', () => {
  const s = new ListeningState(), cfg = defaults();
  s.update(t(), 1000); s.update(t(), 9000);
  s.update(t(), 100000); assert.equal(s.offer(cfg, 100000), null);
  s.update(t(), 108000); assert.ok(s.offer(cfg, 108000));
  s.update(t(), 500); assert.equal(s.offer(cfg, 501), null);
});
test('failed offers do not spend cooldown; revisiting a committed song is deduplicated', () => {
  const s = new ListeningState(), cfg = defaults();
  s.update(t(), 1000); s.update(t(), 9000);
  assert.ok(s.offer(cfg, 9000)); assert.ok(s.offer(cfg, 9001));
  s.commit(t(), s.revision, 9001);
  s.update(t('B'), 20000); s.update(t(), 140000);
  s.update(t(), 148000); assert.equal(s.offer(cfg, 148000), null);
  s.update(null, 200000); s.update(t(), 210000); s.update(t(), 218000);
  assert.equal(s.offer(cfg, 218000), null);
});
test('bad metadata and invalid timing configuration fail safely', () => {
  assert.throws(() => parseSnapshot(null));
  assert.throws(() => parseSnapshot({ track: { title: '', method: 'smtc' } }));
  assert.equal(parseSnapshot({ track: { ...t(), positionSeconds: -1 } }).track?.positionSeconds, undefined);
  const s = new ListeningState(), cfg = { ...defaults(), settleSeconds: NaN, cooldownSeconds: Infinity };
  s.update(t(), 1000); assert.equal(s.offer(cfg, 3000), null);
  s.update(t(), 9000); assert.ok(s.offer(cfg, 9000));
});
function harness(comments?: CommentProvider) {
  let cb: (s: Snapshot) => void = () => {};
  const events: any[] = [], withdrawn: number[] = [];
  const cfg = { ...defaults(), commentReference: !!comments, settleSeconds: 2 };
  const world = new MusicWorld(cfg, () => {}, { start: c => { cb = c; }, stop: async () => {} }, comments);
  const host = { pushDeferred: (e: any) => { const text = e.render(); if (text !== null) events.push({ ...e, text }); }, pushEvent: async (e: any) => { const event = { ...e, cursor: events.length + 1 }; events.push(event); return event; },
    withdrawPending: async (cursor: number) => { withdrawn.push(cursor); return true; } } as unknown as WorldHost;
  return { world, events, withdrawn, host, cfg, observe: (track: Track | null) => cb({ track }) };
}
test('A→B→A during retrieval cancels stale work without consuming the new opportunity', async () => {
  let resolve!: (r: CommentReference) => void;
  let count = 0;
  const h = harness({ get: async () => ++count === 1 ? await new Promise(r => { resolve = r; }) : { status: 'unavailable' } });
  await h.world.start(h.host);
  try {
    h.observe(t()); const request = h.world.tick(Date.now() + 2500); await new Promise(r => setImmediate(r));
    h.observe(t('B')); h.observe(t()); resolve({ status: 'ok', excerpts: [] });
    await request; assert.equal(h.events.length, 0);
    await h.world.tick(Date.now() + 2500); assert.equal(h.events.length, 2);
  } finally { await h.world.stop(); }
});
test('queued requests are withdrawn on pause, player close and quiet toggle', async () => {
  for (const action of ['pause', 'close', 'quiet']) {
    const h = harness(); await h.world.start(h.host);
    try {
      h.observe(t()); await h.world.tick(Date.now() + 2500); assert.equal(h.events.length, 2);
      if (action === 'quiet') await h.world.tools().find(x => x.name === 'music_set_commentary')!.handler({ enabled: false }, {} as never);
      else h.observe(action === 'close' ? null : t('A', 'paused'));
      await new Promise(r => setImmediate(r));
      assert.deepEqual(h.withdrawn, [2]);
    } finally { await h.world.stop(); }
  }
});
test('provider exception falls back to ordinary commentary, not silence', async () => {
  const h = harness({ get: async () => { throw new Error('offline'); } }); await h.world.start(h.host);
  try { h.observe(t()); await h.world.tick(Date.now() + 2500); assert.equal(h.events.length, 2);
    assert.equal(JSON.parse(h.events[0].text).commentReference.status, 'unavailable');
  } finally { await h.world.stop(); }
});
test('stop during retrieval prevents any late event or restart contamination', async () => {
  let resolve!: (r: CommentReference) => void;
  const h = harness({ get: () => new Promise(r => { resolve = r; }) }); await h.world.start(h.host);
  h.observe(t()); const pending = h.world.tick(Date.now() + 2500);
  await h.world.stop(); resolve({ status: 'ok' }); await pending;
  assert.equal(h.events.length, 0);
});
test('rate limits use service backoff and cancelled calls do not use cached data', async () => {
  let count = 0;
  const service = new NeteaseComments((async () => { ++count; return new Response('{}', { status: 429 }); }) as typeof fetch);
  assert.equal((await service.get(t())).status, 'unavailable');
  assert.equal((await service.get(t('B'))).status, 'unavailable'); assert.equal(count, 1);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(service.get(t(), abort.signal));
});
