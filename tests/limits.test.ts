import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, commentLimits } from '../src/config.ts';
import { MusicWorld } from '../src/world.ts';
test('comment limits are bounded and older deployments get a safe default', () => {
  assert.deepEqual(commentLimits(defaults()), { maxChars: 80, intervalSeconds: 120 });
  assert.equal(commentLimits({ ...defaults(), maxCommentChars: undefined as never }).maxChars, 80);
  assert.equal(commentLimits({ ...defaults(), maxCommentChars: NaN }).maxChars, 80);
  assert.equal(commentLimits({ ...defaults(), maxCommentChars: 5 }).maxChars, 10);
  assert.equal(commentLimits({ ...defaults(), maxCommentChars: 999 }).maxChars, 500);
});
test('character limit changes are visible to the next model state read and prompt render', async () => {
  const cfg = defaults(), world = new MusicWorld(cfg, () => {});
  cfg.maxCommentChars = 35; cfg.cooldownSeconds = 300;
  assert.equal(world.envPromptVars()['music.maxChars'], '35');
  const result = JSON.parse(await world.tools()[0].handler({}, {} as never) as string);
  assert.deepEqual(result.commentLimits, { maxChars: 35, intervalSeconds: 300 });
});
