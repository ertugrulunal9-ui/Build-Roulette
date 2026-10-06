import { describe, expect, it } from 'vitest';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  battleTopic,
  isRoomCode,
  normalizeRoomCode,
  roomMaxPlayers,
  roomTopic,
} from './rooms';

describe('room codes', () => {
  it('the alphabet has 32 characters without I, O, 0 and 1', () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(32);
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[IO01]/);
    expect(ROOM_CODE_LENGTH).toBe(5);
  });

  it('isRoomCode accepts only canonical codes', () => {
    expect(isRoomCode('K7QXM')).toBe(true);
    expect(isRoomCode('k7qxm')).toBe(false);
    expect(isRoomCode('K7QX')).toBe(false);
    expect(isRoomCode('K7QXO')).toBe(false); // O is not in the alphabet
    expect(isRoomCode(42)).toBe(false);
  });

  it('normalizeRoomCode trims, upper-cases and reads invite links', () => {
    expect(normalizeRoomCode('  k7qxm ')).toBe('K7QXM');
    expect(normalizeRoomCode('K7Q-XM')).toBe('K7QXM');
    expect(normalizeRoomCode('https://buildroulette.app/r/k7qxm?x=1')).toBe('K7QXM');
    expect(normalizeRoomCode('/r/K7QXM')).toBe('K7QXM');
    expect(normalizeRoomCode('K7QX0')).toBeNull();
    expect(normalizeRoomCode('')).toBeNull();
    expect(normalizeRoomCode('K7QXMM')).toBeNull();
  });
});

describe('roomMaxPlayers', () => {
  it('clamps like private.room_max_players', () => {
    expect(roomMaxPlayers({ max_players: 5 })).toBe(5);
    expect(roomMaxPlayers({ max_players: 1 })).toBe(2);
    expect(roomMaxPlayers({ max_players: 99 })).toBe(8);
    expect(roomMaxPlayers({})).toBe(8);
    expect(roomMaxPlayers(null)).toBe(8);
    expect(roomMaxPlayers({ max_players: '4' })).toBe(8);
  });
});

describe('topics', () => {
  it('names the private Realtime topics', () => {
    expect(roomTopic('r1')).toBe('room:r1');
    expect(battleTopic('b1')).toBe('battle:b1');
  });
});
