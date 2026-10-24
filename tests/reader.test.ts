import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { WindowsReader } from '../src/reader.ts';
import { defaults } from '../src/config.ts';
class Child extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); exitCode: number | null = null; killed = false;
  kill() { if (this.killed) return true; this.killed = true; this.exitCode = 0; queueMicrotask(() => this.emit('close', 0)); return true; }
}
const waitFor = async (predicate: () => boolean) => {
  const until = Date.now() + 1000;
  while (!predicate() && Date.now() < until) await new Promise(r => setTimeout(r, 5));
  assert.ok(predicate(), 'Expected reader supervisor transition within one second');
};

test('failed termination keeps ownership, blocks restart and recovers after late exit', async () => {
  const child = new Child();
  let launches = 0;
  const launch = (() => { launches++; return child; }) as unknown as typeof spawn;
  const reader = new WindowsReader(defaults(), launch);
  const kill = child.kill.bind(child);
  child.kill = () => false;
  reader.start(() => {}, () => {});
  await assert.rejects(reader.stop(), /未确认退出/);
  assert.throws(() => reader.start(() => {}, () => {}), /尚未退出/);
  assert.equal(launches, 1);
  child.kill = kill; child.kill();
  await new Promise(r => setImmediate(r));
  await reader.stop();
});

test('accepted kill without confirmed exit times out and still blocks duplicate spawn', async () => {
  const child = new Child();
  const originalKill = child.kill.bind(child);
  child.kill = () => true;
  const reader = new WindowsReader(defaults(), (() => child) as unknown as typeof spawn);
  reader.start(() => {}, () => {});
  try {
    await assert.rejects(reader.stop(), /未确认退出/);
    assert.throws(() => reader.start(() => {}, () => {}), /尚未退出/);
  } finally {
    originalKill(); await new Promise(r => setImmediate(r)); await reader.stop();
  }
});
test('reader start is idempotent, hung child recovers, and stop cancels restart', async () => {
  const children: Child[] = [], errors: string[] = [];
  const launch = (() => { const child = new Child(); children.push(child); return child; }) as unknown as typeof spawn;
  const reader = new WindowsReader(defaults(), launch, { heartbeatMs: 15, checkMs: 5, retryMs: 5 });
  try {
    reader.start(() => {}, m => errors.push(m)); reader.start(() => {}, () => {});
    assert.equal(children.length, 1);
    await waitFor(() => children.length >= 2);
    assert.ok(children[0].killed); assert.ok(errors.some(x => x.includes('超时')));
    await reader.stop();
    const count = children.length; await new Promise(r => setTimeout(r, 40)); assert.equal(children.length, count);
    reader.start(() => {}, () => {}); assert.equal(children.length, count + 1);
  } finally { await reader.stop(); }
});
test('reader rejects malformed and oversized output and accepts clean snapshots', async () => {
  const children: Child[] = [], errors: string[] = [], observations: unknown[] = [];
  const launch = (() => { const child = new Child(); children.push(child); return child; }) as unknown as typeof spawn;
  const reader = new WindowsReader(defaults(), launch);
  try {
    reader.start(s => observations.push(s), m => errors.push(m));
    children[0].stdout.write('invalid\n');
    children[0].stdout.write('{"track":null}\n');
    assert.equal(observations.length, 1); assert.ok(errors.length);
    children[0].stdout.write('x'.repeat(70_000));
    await waitFor(() => children[0].killed);
    assert.ok(errors.some(x => x.includes('过大')));
  } finally { await reader.stop(); }
});
