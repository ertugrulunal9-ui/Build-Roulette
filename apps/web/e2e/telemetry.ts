/**
 * Shared by the telemetry e2e (T-030): the fake ingest's fixed port (the "on" build points its
 * DSN and PostHog host here, see `build:telemetry` in package.json), and small helpers.
 */
import { expect, type Page } from '@playwright/test';

export const INGEST_PORT = 4399;

export interface SentryEvent {
  message?: string;
  level?: string;
  release?: string;
  environment?: string;
  user?: { id?: string };
  tags?: Record<string, unknown>;
  request?: { url?: string; method?: string; headers?: Record<string, string> };
  exception?: { values?: { type?: string; value?: string }[] };
  breadcrumbs?: unknown;
  extra?: unknown;
}

export interface PosthogEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Waits for the Sentry chunk to be loaded and started on the page (it loads when idle). */
export async function sentryLoaded(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => '__SENTRY__' in window), { timeout: 15_000 })
    .toBe(true);
}

/** Throws from the page's own code (a task of this window, like an app bug would). */
export async function throwInPage(page: Page, message: string): Promise<void> {
  await page.evaluate((m) => {
    setTimeout(() => {
      throw new Error(m);
    }, 0);
  }, message);
}

/** Creates a room from the landing page as `name`; returns the room code. */
export async function createRoomAs(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('create-room').click();
  await page.getByTestId('host-name').fill(name);
  await page.getByTestId('create-room-submit').click();
  await expect(page).toHaveURL(/\/r\/[A-HJ-NP-Z2-9]{5}$/);
  await expect(page.getByTestId('lobby')).toBeVisible();
  return new URL(page.url()).pathname.split('/')[2] ?? '';
}

/** The tab's anonymous Supabase user id (the session in localStorage `br-auth`). */
export async function sessionUserId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('br-auth');
    const parsed = raw ? (JSON.parse(raw) as { user?: { id?: string } }) : null;
    return parsed?.user?.id ?? '';
  });
}
