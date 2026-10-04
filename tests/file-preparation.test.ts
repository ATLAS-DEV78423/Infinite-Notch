import assert from 'node:assert/strict';
import test from 'node:test';
import { UploadSeq } from '../windows/src/upload/sequence.ts';

function clock(t: test.TestContext) {
  let now = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  t.after(() => { UploadSeq.deactivate(); Object.defineProperty(globalThis, 'performance', previous!); });
  return { advance(ms: number) { now += ms; } };
}

test('pending_sequence_never_checks', (t) => {
  const time = clock(t);
  UploadSeq.enterZone(520, 96); UploadSeq.performDrop();
  time.advance(10_000);
  const frame = UploadSeq.frame();
  assert.equal(frame.check, 0, 'ten seconds without a native result cannot draw completion');
  assert.equal(frame.progress, 0, 'unknown copy bytes cannot become a percentage');
  assert.equal(frame.chooseAlpha, 0, 'pending work cannot expose Ask/share');
  assert.equal(frame.flash, 0);
  assert.equal(frame.greenWash, 0);
  assert.equal(frame.d, 14, 'pending work stays in the indeterminate phase');
  assert.equal(Number.isFinite(frame.barAlpha), true);
  time.advance(500); assert.notEqual(UploadSeq.frame().x, frame.x, 'indeterminate indicator travels without claiming byte progress');
});

test('success_grows_once', (t) => {
  const time = clock(t);
  UploadSeq.enterZone(520, 96); UploadSeq.performDrop(); time.advance(10_000);
  UploadSeq.finishPreparation(true); time.advance(1000);
  assert.equal(UploadSeq.frame().check, 1);
  assert.equal(UploadSeq.frame().chooseAlpha, 1);
  const start = UploadSeq.frame().growStart;
  UploadSeq.finishPreparation(true); UploadSeq.finishPreparation(false);
  assert.equal(UploadSeq.frame().growStart, start, 'duplicate terminal callbacks cannot restart success');
  assert.equal(UploadSeq.frame().chooseAlpha, 1);
});

test('failure_and_early_success_never_skip_the_gulp', (t) => {
  const time = clock(t);
  UploadSeq.enterZone(520, 96); UploadSeq.performDrop(); UploadSeq.finishPreparation(false);
  time.advance(10_000);
  assert.equal(UploadSeq.frame().check, 0); assert.equal(UploadSeq.frame().chooseAlpha, 0);
  UploadSeq.enterZone(520, 96); UploadSeq.performDrop(); UploadSeq.finishPreparation(true);
  assert.equal(UploadSeq.frame().chooseAlpha, 0);
  time.advance(2000); assert.equal(UploadSeq.frame().chooseAlpha, 1);
});

test('late_copy_cannot_replace_new_drop', async () => {
  const { FilePreparation } = await import('../windows/src/core/file-preparation.ts');
  const owner = new FilePreparation();
  owner.begin('a', 'a.txt'); owner.begin('b', 'b.txt');
  assert.equal(owner.complete('a', { name: 'a.txt', path: '/synthetic/managed/a', size: 1 }), false);
  assert.equal(owner.fail('a', 'storage'), false);
  assert.deepEqual(owner.current, { id: 'b', name: 'b.txt', state: 'preparing' });
  assert.equal(owner.complete('b', { name: 'b.txt', path: '/synthetic/managed/b', size: 2 }), true);
  assert.equal(owner.current?.file?.path, '/synthetic/managed/b');
});

test('clear_and_pause_reject_completion', async () => {
  const { FilePreparation } = await import('../windows/src/core/file-preparation.ts');
  const owner = new FilePreparation(); owner.begin('a', 'a.txt'); owner.clear();
  assert.equal(owner.complete('a', { name: 'a.txt', path: '/synthetic/managed/a', size: 1 }), false);
  assert.equal(owner.fail('a', 'denied'), false); assert.equal(owner.current, null);
});

test('failure_leaves_no_prompt_path', async () => {
  const { FilePreparation } = await import('../windows/src/core/file-preparation.ts');
  const owner = new FilePreparation(); owner.begin('a', 'a.txt');
  assert.equal(owner.fail('a', 'storage'), true);
  assert.deepEqual(owner.current, { id: 'a', name: 'a.txt', state: 'failed', error: 'storage' });
  assert.equal(owner.complete('a', { name: 'a.txt', path: '/synthetic/managed/a', size: 1 }), false);
});

test('only_ready_file_can_be_asked_or_shared', async () => {
  const { FilePreparation } = await import('../windows/src/core/file-preparation.ts');
  const owner = new FilePreparation(); owner.begin('a', 'a.txt');
  assert.equal(owner.current?.file, undefined);
  assert.equal(owner.complete('a', { name: 'a.txt', path: '/synthetic/managed/a', size: 1 }), true);
  assert.equal(owner.current?.state, 'ready');
  assert.equal(owner.fail('a', 'invalid'), false, 'a duplicate failure cannot invalidate an already ready file');
  owner.begin('b', 'b.txt'); assert.equal(owner.current?.file, undefined);
});

test('bridge_uses_native_operation_receipts_and_cancellation_arguments', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: { command: string; args: unknown }[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke(command: string, args: unknown) {
      calls.push({ command, args });
      return Promise.resolve(command === 'prepare_file' ? { name: 'file.txt', path: '/synthetic/managed/file', size: 9 } : undefined);
    },
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  const { Bridge } = await import('../windows/src/core/bridge.ts');
  const file = await Bridge.ingestFile('/synthetic/selected/file', 'operation-1');
  await Bridge.cancelFileCopy('operation-1');
  assert.deepEqual(file, { name: 'file.txt', path: '/synthetic/managed/file', size: 9 });
  assert.deepEqual(calls, [
    { command: 'prepare_file', args: { path: '/synthetic/selected/file', operationId: 'operation-1' } },
    { command: 'cancel_file_copy', args: { operationId: 'operation-1' } },
  ]);
});

test('reduced_motion_uses_static_preparation_and_real_terminal_state', (t) => {
  const time = clock(t); UploadSeq.enterZone(520, 96); UploadSeq.performDrop();
  const first = UploadSeq.frame(true); time.advance(10_000); const pending = UploadSeq.frame(true);
  assert.equal(pending.x, first.x, 'reduced-motion pending work has no travelling decorative loop');
  assert.equal(first.barAlpha, 1); assert.equal(pending.check, 0); assert.equal(pending.chooseAlpha, 0);
  UploadSeq.finishPreparation(true);
  assert.equal(UploadSeq.frame(true).chooseAlpha, 1, 'real readiness is available without waiting on decoration');
});

test('long_clock_suspension_has_bounded_existing_catch_up_and_current_receipt_geometry', (t) => {
  const time = clock(t);
  // Count the real integrator's work, failing early if its existing cap regresses.
  // The production steps/geometry remain real; no test-only production API.
  const integrator = UploadSeq as unknown as { stepOnce(dt: number): void };
  const step = integrator.stepOnce;
  let steps = 0;
  integrator.stepOnce = function (dt) {
    assert.ok(++steps <= 481, 'resume must never simulate a historical UI-thread backlog');
    step.call(this, dt);
  };
  t.after(() => { integrator.stepOnce = step; });
  UploadSeq.enterZone(520, 96); time.advance(43_200_000);
  const dragging = UploadSeq.frame();
  assert.equal(dragging.t, 43_201.55);
  assert.ok(steps > 0 && steps <= 481);
  assert.ok(Math.abs(dragging.x - 520) < 1, 'normal cursor-follow settles at the current position');
  assert.equal(dragging.fileVisible, true); assert.equal(dragging.chooseAlpha, 0);
  UploadSeq.performDrop(); steps = 0; time.advance(43_200_000);
  const pending = UploadSeq.frame();
  assert.equal(pending.t, 43_201.95);
  assert.ok(steps > 0 && steps <= 481);
  assert.equal(pending.disposition, 'preparing'); assert.equal(pending.check, 0);
  assert.equal(pending.progress, 0); assert.equal(pending.chooseAlpha, 0);
  assert.ok(Number.isFinite(pending.x) && pending.x >= 46 && pending.x <= 520);
  UploadSeq.finishPreparation(true); steps = 0; time.advance(1000);
  const ready = UploadSeq.frame();
  assert.equal(ready.t, 43_202.95); assert.equal(ready.disposition, 'ready');
  assert.equal(ready.check, 1); assert.equal(ready.chooseAlpha, 1);
  assert.equal(ready.x, 60); assert.equal(ready.d, 62);
});
