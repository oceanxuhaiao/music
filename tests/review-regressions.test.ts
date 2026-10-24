import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MusicWorld } from '../src/world.ts';
import { defaults } from '../src/config.ts';
import type { Snapshot, Track } from '../src/state.ts';
import type { WorldHost } from 'cortico/core/types.ts';

const track: Track = { title: 'A', artist: 'artist', album: '', app: 'test', method: 'smtc', status: 'playing' };
function harness(withdraws = true) {
  let observe!: (s: Snapshot) => void;
  const cfg = { ...defaults(), commentReference: false, settleSeconds: 2 };
  const cues: any[] = [], snapshots: any[] = [], withdrawn: number[] = [];
  const world = new MusicWorld(cfg, () => {}, { start: cb => { observe = cb; }, stop: async () => {} });
  const host = { pushDeferred: (e: any) => snapshots.push(e),
    pushEvent: async (e: any) => { const saved = { ...e, cursor: cues.length + 1 }; cues.push(saved); return saved; },
    withdrawPending: async (cursor: number) => { withdrawn.push(cursor); return withdraws; } } as unknown as WorldHost;
  return { world, cfg, cues, snapshots, withdrawn, host, observe: (t: Track) => observe({ track: t }) };
}

test('confirmed pending withdrawal permits retry after resume without repeating a consumed cue', async () => {
  for (const pending of [true, false]) {
    const h = harness(pending); await h.world.start(h.host);
    try {
      h.observe(track); await h.world.tick(Date.now() + 2500);
      h.observe({ ...track, status: 'paused' });
      assert.equal(h.snapshots[0].render(), null, 'Old snapshot must not survive pause');
      h.observe(track); await h.world.tick(Date.now() + 2500);
      assert.equal(h.cues.length, pending ? 2 : 1);
      await h.world.tick(Date.now() + 2500);
      assert.equal(h.cues.length, pending ? 2 : 1, 'No duplicate while the new cue is pending');
    } finally { await h.world.stop(); }
  }
});

test('UI quiet toggle invalidates deferred data and releases only withdrawn cue', async () => {
  const h = harness(); await h.world.start(h.host);
  try {
    h.observe(track); await h.world.tick(Date.now() + 2500);
    h.cfg.commentary = false; await h.world.tick();
    assert.deepEqual(h.withdrawn, [1]);
    h.cfg.commentary = true;
    assert.equal(h.snapshots[0].render(), null);
    await h.world.tick(Date.now() + 2500);
    assert.equal(h.cues.length, 2);
    assert.equal(JSON.parse(h.snapshots[1].render()).track.title, 'A');
  } finally { await h.world.stop(); }
});

test('deferred snapshot discards stale track and reads current reference setting', async () => {
  const h = harness(); await h.world.start(h.host);
  try {
    h.observe(track); await h.world.tick(Date.now() + 2500);
    assert.equal(JSON.parse(h.snapshots[0].render()).commentReference.status, 'disabled');
    h.observe({ ...track, title: 'B' });
    assert.equal(h.snapshots[0].render(), null);
  } finally { await h.world.stop(); }
});

test('comments tool rejects a response from a previous A→B→A revision', async () => {
  let observe!: (s: Snapshot) => void, finish!: (r: any) => void;
  const world = new MusicWorld(defaults(), () => {}, { start: cb => { observe = cb; }, stop: async () => {} },
    { get: () => new Promise(r => { finish = r; }) });
  await world.start({} as WorldHost);
  try {
    observe({ track });
    const result = world.tools().find(t => t.name === 'music_song_comments')!.handler({}, {} as never);
    observe({ track: { ...track, title: 'B' } }); observe({ track });
    finish({ status: 'ok', excerpts: [] });
    assert.equal(JSON.parse(await result as string).status, 'unavailable');
  } finally { await world.stop(); }
});
