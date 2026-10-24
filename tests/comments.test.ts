import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NeteaseComments, matchSong, parseComments, type CommentProvider, type CommentReference } from '../src/comments.ts';
import { defaults } from '../src/config.ts';
import { MusicWorld } from '../src/world.ts';
import type { Track, Snapshot } from '../src/state.ts';
import type { WorldHost } from 'cortico/core/types.ts';
const track: Track = { title: '当你 - 王心凌', artist: '', album: '', app: 'cloudmusic', method: 'window-title', status: 'unknown' };
const song = { id: 297805, title: '当你', artists: ['王心凌'], album: 'Cyndi Begin' };
test('matching excludes other artists and live versions; flags unknown recording', () => {
  assert.equal(matchSong(track, [{ ...song, artists: ['其他人'] }]), null);
  assert.equal(matchSong(track, [{ ...song, title: '当你 (Live)' }]), null);
  assert.equal(matchSong(track, [song])?.match, 'title-artist-version-unverified');
  assert.equal(matchSong({ ...track, title: '当你', artist: '王心凌', album: 'Cyndi Begin' }, [song])?.match, 'metadata');
  assert.equal(matchSong({ ...track, title: '当你', method: 'smtc' }, [song]), null);
});
test('comment sample is bounded, deduplicated and contains no user profile', () => {
  const result = parseComments({ hotComments: [{ content: 'x'.repeat(500), user: { nickname: 'private' } }, { content: 'repeat' }], comments: [{ content: 'repeat' }, { content: 'recent' }] });
  assert.equal(result[0].text.length, 240);
  assert.equal(result.filter(c => c.text === 'repeat').length, 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
test('provider caches results and reports API failures instead of fabricated comments', async () => {
  let requests = 0;
  const request = async (url: string) => {
    requests++;
    return new Response(JSON.stringify(url.includes('/search/')
      ? { code: 200, result: { songs: [{ id: song.id, name: song.title, artists: [{ name: '王心凌' }], album: { name: song.album } }] } }
      : { code: 200, comments: [{ content: 'a listener thought', likedCount: 1 }], hotComments: [] }));
  };
  const client = new NeteaseComments(request as typeof fetch);
  assert.equal((await client.get(track)).status, 'ok');
  await client.get(track);
  assert.equal(requests, 2);
  const failed = new NeteaseComments((async () => new Response('{}', { status: 503 })) as typeof fetch);
  assert.equal((await failed.get(track)).status, 'unavailable');
});
test('a track change during comment fetch discards the old event', async () => {
  let callback: (s: Snapshot) => void = () => {};
  let finish!: (r: CommentReference) => void;
  const comments: CommentProvider = { get: () => new Promise(resolve => { finish = resolve; }) };
  const world = new MusicWorld(defaults(), () => {}, { start: cb => { callback = cb; }, stop: async () => {} }, comments);
  const events: unknown[] = [];
  await world.start({ pushDeferred: (e: any) => { const text = e.render(); if (text !== null) events.push({ ...e, text }); }, pushEvent: async (e: unknown) => { events.push(e); } } as unknown as WorldHost);
  try {
    callback({ track });
    const pending = world.tick(Date.now() + 8500); await new Promise(r => setImmediate(r));
    callback({ track: { ...track, title: '另一首 - 王心凌' } });
    finish({ status: 'ok', excerpts: [] });
    await pending;
    assert.equal(events.length, 0);
  } finally { await world.stop(); }
});
