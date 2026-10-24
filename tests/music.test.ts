import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseExtensionManifest } from 'cortico/extensions/manifest.ts';
import { parsePageId } from 'cortico/web/shared/webui-protocol.ts';
import definition from '../src/index.ts';
import { defaults } from '../src/config.ts';
import { ListeningState, parseSnapshot, type Track, type Snapshot } from '../src/state.ts';
import { MusicWorld } from '../src/world.ts';
import type { Reader } from '../src/reader.ts';
import type { WorldHost } from 'cortico/core/types.ts';
const track = (title: string, status: Track['status'] = 'playing'): Track => ({ title, status, artist: 'artist', album: '', app: 'cloudmusic', method: 'smtc' });
test('manifest is accepted by actual Cortico API 6 parser', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(parseExtensionManifest(pkg).ok, true);
  assert.equal(definition.defaults().enabled, false);
  assert.ok(parsePageId(`world:${definition.id}`), 'World must have a valid sidebar page ID');
  assert.deepEqual(definition.describe?.tools.map(t => t.name), new MusicWorld(defaults(), () => {}).tools().map(t => t.name));
});
test('rapid skips settle on the last track, not an old comment backlog', () => {
  const s = new ListeningState(), cfg = defaults();
  s.update(track('A'), 0);
  s.update(track('B'), 6000);
  assert.equal(s.offer(cfg, 9000), null);
  s.update(track('B'), 14000);
  assert.equal(s.offer(cfg, 14000)?.title, 'B');
  s.commit(track('B'), s.revision, 14000);
  assert.equal(s.offer(cfg, 14000), null);
});
test('cooldown coalesces tracks and metadata must be fresh', () => {
  const s = new ListeningState(), cfg = defaults();
  s.update(track('A'), 0); s.update(track('A'), 8000);
  assert.ok(s.offer(cfg, 8000));
  s.commit(track('A'), s.revision, 8000);
  s.update(track('B'), 10000); s.update(track('B'), 20000);
  assert.equal(s.offer(cfg, 20000), null);
  s.update(track('C'), 120000); s.update(track('C'), 128000);
  assert.equal(s.offer(cfg, 128000)?.title, 'C');
  s.update(track('D'), 200000);
  assert.equal(s.offer(cfg, 300000), null);
});
test('pause, resume settling, quiet mode and missing player', () => {
  const s = new ListeningState(), cfg = defaults();
  s.update(track('A', 'paused'), 0); s.update(track('A', 'paused'), 10000);
  assert.equal(s.offer(cfg, 10000), null);
  s.update(track('A'), 12000);
  assert.equal(s.offer(cfg, 13000), null);
  s.update(track('A'), 20000); cfg.commentary = false;
  assert.equal(s.offer(cfg, 20000), null);
  cfg.commentary = true; assert.ok(s.offer(cfg, 20000));
  s.update(null, 21000); assert.equal(s.offer(cfg, 22000), null);
});
test('observed history is bounded and metadata is sanitized', () => {
  const s = new ListeningState();
  for (let i = 0; i < 30; i++) s.update(track(String(i)), i);
  assert.equal(s.history.length, 20);
  assert.equal(parseSnapshot({ track: { ...track('a\nb'), artist: 'x'.repeat(1000) } }).track?.title, 'a b');
  assert.equal(parseSnapshot({ track: { ...track('a'), artist: 'x'.repeat(1000) } }).track?.artist.length, 300);
  assert.throws(() => parseSnapshot({ track: {} }));
});
class FakeReader implements Reader {
  callback?: (s: Snapshot) => void;
  stopped = false;
  start(cb: (s: Snapshot) => void) { this.callback = cb; }
  async stop() { this.stopped = true; }
}
test('World routes external events, persists quiet mode, ignores late callbacks after stop', async () => {
  const cfg = defaults(), reader = new FakeReader();
  cfg.commentReference = false;
  const patches: unknown[] = [], events: unknown[] = [];
  const world = new MusicWorld(cfg, patch => patches.push(patch), reader);
  const host = { pushDeferred: (e: any) => { const text = e.render(); if (text !== null) events.push({ ...e, text }); }, pushEvent: async (e: unknown) => { events.push(e); return e; } } as unknown as WorldHost;
  await world.start(host);
  reader.callback!({ track: track('A') });
  const now = Date.now();
  // Keep the observation fresh while advancing the deterministic tick clock.
  await world.tick(now + 8500);
  assert.equal(events.length, 2);
  assert.equal((events[0] as { origin: string }).origin, 'external');
  assert.equal((events[1] as { origin: string }).origin, 'internal');
  assert.equal(JSON.stringify(events[1]).includes('"title"'), false, 'Internal cue must not promote external song/comment text');
  const quiet = world.tools().find(t => t.name === 'music_set_commentary')!;
  await quiet.handler({ enabled: false }, {} as never);
  assert.deepEqual(patches, [{ commentary: false }]);
  await world.stop();
  assert.equal(reader.stopped, true);
  reader.callback!({ track: track('late') });
  const info = await world.tools()[0].handler({}, {} as never);
  assert.equal(JSON.parse(info as string).track, null);
});
