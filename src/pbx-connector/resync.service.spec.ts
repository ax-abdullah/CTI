import { LiveChannel, reconcile } from './resync.service';

const chan = (linkedid: string, uniqueid: string, state = 'Up'): LiveChannel => ({
  linkedid,
  uniqueid,
  channel: `PJSIP/1001-${uniqueid}`,
  state,
  durationSec: 5,
});

describe('reconcile', () => {
  it('finalizes persisted calls the PBX no longer shows', () => {
    const plan = reconcile(['a', 'b'], [chan('a', 'a1')]);
    expect(plan.finalize).toEqual(['b']);
    expect(plan.keep).toEqual(['a']);
    expect(plan.synthesize).toEqual([]);
  });

  it('synthesizes live calls we never persisted', () => {
    const plan = reconcile([], [chan('x', 'x1'), chan('x', 'x2'), chan('y', 'y1')]);
    expect(plan.synthesize.sort()).toEqual(['x', 'y']);
    expect(plan.finalize).toEqual([]);
    expect(plan.keep).toEqual([]);
  });

  it('keeps calls present on both sides', () => {
    const plan = reconcile(['a'], [chan('a', 'a1')]);
    expect(plan.keep).toEqual(['a']);
    expect(plan.finalize).toEqual([]);
    expect(plan.synthesize).toEqual([]);
  });

  it('handles the empty case', () => {
    expect(reconcile([], [])).toEqual({ finalize: [], keep: [], synthesize: [] });
  });
});
