import { beforeEach, describe, expect, it } from 'vitest';
import type { TelemetryConfig } from './config';
import {
  currentUserHash,
  identifyUser,
  resetTelemetryContext,
  setTelemetryContext,
  telemetryContext,
  userHashReady,
} from './context';
import { prepareBrowserEvent } from './sentry-browser';

const USER = '9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a';
const OFF: TelemetryConfig = {
  sentryDsn: null,
  sentryEnvironment: 'production',
  posthogKey: null,
  posthogHost: 'https://ph.example',
  release: 'dev',
};
const ON: TelemetryConfig = { ...OFF, posthogKey: 'phc_x' };

beforeEach(() => {
  resetTelemetryContext();
});

describe('identifyUser', () => {
  it('does nothing while telemetry is off', async () => {
    identifyUser(USER, OFF);
    expect(await userHashReady(50)).toBeNull();
    expect(currentUserHash()).toBeNull();
  });

  it('keeps only the hash of the user id', async () => {
    identifyUser(USER, ON);
    const hash = await userHashReady();
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).not.toContain(USER.slice(0, 8));
    expect(currentUserHash()).toBe(hash);
  });

  it('error reports carry the hash, except under Do Not Track / GPC', async () => {
    identifyUser(USER, ON);
    const hash = await userHashReady();
    expect(prepareBrowserEvent({ type: undefined }, '/play', false)?.user).toEqual({ id: hash });
    expect(prepareBrowserEvent({ type: undefined }, '/play', true)?.user).toBeUndefined();
  });
});

describe('setTelemetryContext', () => {
  it('accepts only UUIDs as room and battle ids', () => {
    setTelemetryContext({ roomId: 'K7QXM', battleId: 'not-a-uuid', phase: 'voting' });
    expect(telemetryContext()).toMatchObject({ roomId: null, battleId: null, phase: 'voting' });
    setTelemetryContext({ roomId: USER });
    expect(telemetryContext().roomId).toBe(USER);
  });
});
