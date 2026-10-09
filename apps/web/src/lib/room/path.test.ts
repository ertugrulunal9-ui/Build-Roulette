import { describe, expect, it } from 'vitest';
import { roomCodeFromPath } from './path';

describe('roomCodeFromPath', () => {
  it('reads the code of /r/{code} as typed (the room normalises it)', () => {
    expect(roomCodeFromPath('/r/K7QXM')).toBe('K7QXM');
    expect(roomCodeFromPath('/r/k7qxm/')).toBe('k7qxm');
    expect(roomCodeFromPath('/r/K7%20QXM')).toBe('K7 QXM');
  });

  it('no code: the bare page, other paths, extra segments, a broken escape', () => {
    expect(roomCodeFromPath('/r')).toBe('');
    expect(roomCodeFromPath('/r/')).toBe('');
    expect(roomCodeFromPath('/play')).toBe('');
    expect(roomCodeFromPath('/r/K7QXM/extra')).toBe('');
    expect(roomCodeFromPath('/r/%E0%A4%A')).toBe('');
  });
});
