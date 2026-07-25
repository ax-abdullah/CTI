import { JsonLogger } from './json-logger';

describe('JsonLogger', () => {
  let lines: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    lines = [];
    spy = jest.spyOn(process.stdout, 'write').mockImplementation((s: any) => {
      lines.push(String(s));
      return true;
    });
  });
  afterEach(() => spy.mockRestore());

  const parse = () => JSON.parse(lines[0]);

  it('emits one JSON line per log with ts/level/context/msg', () => {
    new JsonLogger().log('hello', 'CtxA');
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(parse()).toMatchObject({ level: 'log', context: 'CtxA', msg: 'hello' });
    expect(typeof parse().ts).toBe('string');
  });

  it('merges structured object messages into the line', () => {
    new JsonLogger().warn({ msg: 'alert', kind: 'dead_letters', queue: 'zoho', failed: 3 }, 'Alerts');
    expect(parse()).toMatchObject({ level: 'warn', context: 'Alerts', kind: 'dead_letters', queue: 'zoho', failed: 3 });
  });

  it('records the stack trace on error', () => {
    new JsonLogger().error('boom', 'at foo()', 'CtxB');
    expect(parse()).toMatchObject({ level: 'error', context: 'CtxB', msg: 'boom', trace: 'at foo()' });
  });
});
