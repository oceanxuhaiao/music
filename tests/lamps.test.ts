import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MusicWorld } from '../src/world.ts';
import { defaults } from '../src/config.ts';
import type { Snapshot, Track } from '../src/state.ts';
import type { CommentProvider, CommentReference } from '../src/comments.ts';
import type { WorldHost } from 'cortico/core/types.ts';

const track: Track = { title: 'A', artist: 'artist', album: '', app: 'test', method: 'smtc', status: 'playing' };
const host = { pushDeferred() {}, pushEvent: async (e: unknown) => e } as unknown as WorldHost;
function harness(comments: CommentProvider = { get: async () => ({ status: 'ok', excerpts: [] }) }) {
  let observe!: (s: Snapshot) => void;
  const cfg = { ...defaults(), settleSeconds: 2 };
  const world = new MusicWorld(cfg, () => {}, { start: cb => { observe = cb; }, stop: async () => {} }, comments);
  const lamps = () => world.webUi().lamps!;
  const query = () => world.tools().find(t => t.name === 'music_song_comments')!.handler({}, {} as never);
  return { world, cfg, lamps, query, observe: (s: Snapshot) => observe(s) };
}

test('reader lamp reports startup, absence, fresh paused/unknown state, failure and stop', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const h = harness(); assert.equal(h.lamps()[0].state, 'offline');
  await h.world.start(host);
  try {
    assert.equal(h.lamps()[0].state, 'loading');
    h.observe({ track: null }); assert.equal(h.lamps()[0].state, 'offline');
    h.observe({ track: { ...track, status: 'paused' } });
    assert.equal(h.lamps()[0].state, 'online'); assert.match(h.lamps()[0].hint!, /暂停/);
    h.observe({ track: { ...track, status: 'unknown', method: 'window-title' } });
    assert.equal(h.lamps()[0].state, 'online'); assert.match(h.lamps()[0].hint!, /无法确认/);
    now += 11000; assert.equal(h.lamps()[0].state, 'loading');
    h.observe({ track: null, error: '读取进程退出' }); assert.equal(h.lamps()[0].state, 'error');
    h.observe({ track }); assert.equal(h.lamps()[0].state, 'online');
  } finally { await h.world.stop(); }
  assert.deepEqual(h.lamps().map(l => l.state), ['offline', 'offline']);
});

test('comment lamp changes only from actual queries and ignores obsolete results', async () => {
  let finish!: (r: CommentReference) => void, calls = 0;
  const h = harness({ get: () => { calls++; return new Promise(r => { finish = r; }); } });
  await h.world.start(host);
  try {
    h.observe({ track }); h.lamps(); h.lamps(); assert.equal(calls, 0);
    assert.equal(h.lamps()[1].state, 'offline');
    const query = h.query(); assert.equal(h.lamps()[1].state, 'loading');
    finish({ status: 'ok', excerpts: [] }); await query;
    assert.equal(h.lamps()[1].state, 'online'); assert.match(h.lamps()[1].hint!, /最近一次.*缓存/);
    h.observe({ track: { ...track, title: 'B' } }); assert.equal(h.lamps()[1].state, 'offline');
    const old = h.query(); h.observe({ track }); finish({ status: 'ok' }); await old;
    assert.equal(h.lamps()[1].state, 'offline');
    const disabled = h.query(); h.cfg.commentReference = false;
    assert.equal(h.lamps()[1].state, 'offline'); finish({ status: 'ok' }); await disabled;
    h.cfg.commentReference = true; assert.equal(h.lamps()[1].state, 'offline');
  } finally { await h.world.stop(); }
});

test('scheduled query failure reports comment error without marking the reader failed', async () => {
  for (const get of [async () => ({ status: 'unavailable' as const }), async (): Promise<CommentReference> => { throw new Error('offline'); }]) {
    const h = harness({ get }); await h.world.start(host);
    try {
      h.observe({ track }); await h.world.tick(Date.now() + 2500);
      assert.deepEqual(h.lamps().map(l => l.state), ['online', 'error']);
      assert.match(h.lamps()[1].hint!, /普通陪听/);
    } finally { await h.world.stop(); }
  }
});
