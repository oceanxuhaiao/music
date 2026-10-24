import type { Track } from './state.ts';

export interface Song { id: number; title: string; artists: string[]; album: string }
export interface CommentReference {
  status: 'ok' | 'unavailable' | 'disabled';
  reason?: string;
  song?: Song;
  url?: string;
  match?: 'metadata' | 'title-artist-version-unverified';
  fetchedAt?: string;
  excerpts?: Array<{ text: string; kind: 'hot' | 'recent'; likes: number }>;
}
export interface CommentProvider { get(track: Track, signal?: AbortSignal): Promise<CommentReference> }
const clean = (v: unknown, max = 240) => typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';
const norm = (s: string) => s.normalize('NFKC').replace(/[–—]/g, '-').replace(/\s+/g, '').toLowerCase();
export const trackKey = (t: Track) => JSON.stringify([t.title, t.artist, t.album]);

export function parseSongs(raw: any): Song[] {
  if (!Array.isArray(raw?.result?.songs)) throw new Error('搜索接口返回格式不可用');
  return raw.result.songs.slice(0, 30).flatMap((s: any) => {
    const artists = (Array.isArray(s.artists ?? s.ar) ? (s.artists ?? s.ar) : []).map((a: any) => clean(a?.name)).filter(Boolean);
    return Number.isSafeInteger(s.id) && s.id > 0 && clean(s.name) && artists.length
      ? [{ id: s.id, title: clean(s.name), artists, album: clean((s.album ?? s.al)?.name) }] : [];
  });
}
export function matchSong(track: Track, songs: Song[]): { song: Song; match: NonNullable<CommentReference['match']> } | null {
  const matches = songs.filter(s => {
    if (track.artist) return norm(s.title) === norm(track.title) &&
      [s.artists.join('/'), s.artists.join('&'), s.artists.join('、'), s.artists.join(',')].some(a => norm(a) === norm(track.artist));
    if (track.method !== 'window-title') return false;
    return [s.artists.join('/'), s.artists.join('&'), s.artists.join('、'), s.artists.join(',')].some(a =>
      [s.title + ' - ' + a, a + ' - ' + s.title].some(label => norm(label) === norm(track.title)));
  });
  const filtered = track.album ? matches.filter(s => norm(s.album) === norm(track.album)) : matches;
  if (!filtered.length) return null;
  // Search rank is only a best-effort choice when no recording ID/album is available.
  return { song: filtered[0], match: track.album && filtered.length === 1 ? 'metadata' : 'title-artist-version-unverified' };
}
export function parseComments(raw: any): NonNullable<CommentReference['excerpts']> {
  if (!Array.isArray(raw?.comments) && !Array.isArray(raw?.hotComments)) throw new Error('评论接口返回格式不可用');
  const seen = new Set<string>();
  const out: NonNullable<CommentReference['excerpts']> = [];
  for (const [kind, values, max] of [['hot', raw.hotComments, 3], ['recent', raw.comments, 2]] as const) {
    let count = 0;
    for (const c of Array.isArray(values) ? values : []) {
      const text = clean(c?.content);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push({ text, kind, likes: Number.isFinite(c.likedCount) ? Math.max(0, c.likedCount) : 0 });
      if (++count >= max) break;
    }
  }
  return out;
}

export class NeteaseComments implements CommentProvider {
  private cache = new Map<string, { until: number; result: CommentReference }>();
  private blockedUntil = 0;
  constructor(private request: typeof fetch = fetch) {}
  private async json(path: string, signal?: AbortSignal): Promise<any> {
    const r = await this.request('https://music.163.com' + path, {
      headers: { Referer: 'https://music.163.com/', Accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      if (r.status === 429 || r.status === 403 || r.status >= 500) this.blockedUntil = Date.now() + 60_000;
      await r.body?.cancel().catch(() => {});
      throw new Error(`网易云接口 HTTP ${r.status}`);
    }
    const reader = r.body?.getReader();
    if (!reader) throw new Error('网易云接口没有正文');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1_000_000) throw new Error('网易云接口正文过大');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data.code !== 200) throw new Error(`网易云接口未成功（${String(data.code).slice(0, 20)}）`);
    return data;
  }
  async get(track: Track, signal?: AbortSignal): Promise<CommentReference> {
    const key = trackKey(track), cached = this.cache.get(key);
    signal?.throwIfAborted();
    if (cached && cached.until > Date.now()) return cached.result;
    if (Date.now() < this.blockedUntil) return { status: 'unavailable', reason: '评论服务正在冷却，暂时普通陪听' };
    let result: CommentReference;
    try {
      const query = new URLSearchParams({ s: [track.title, track.artist].filter(Boolean).join(' '), type: '1', limit: '20', offset: '0' });
      const found = matchSong(track, parseSongs(await this.json('/api/search/get?' + query, signal)));
      if (!found) throw new Error('没有歌名、歌手及可用专辑信息相符的歌曲');
      const excerpts = parseComments(await this.json(`/api/v1/resource/comments/R_SO_4_${found.song.id}?limit=5&offset=0`, signal));
      result = { status: 'ok', ...found, url: `https://music.163.com/song?id=${found.song.id}`,
        fetchedAt: new Date().toISOString(), excerpts };
    } catch (e) {
      if (signal?.aborted) throw e;
      result = { status: 'unavailable', reason: e instanceof Error ? e.message : '评论读取失败' };
    }
    this.cache.delete(key);
    this.cache.set(key, { until: Date.now() + (result.status === 'ok' ? 30 * 60_000 : 5 * 60_000), result });
    while (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }
}
