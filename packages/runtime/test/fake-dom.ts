/**
 * Minimal fakes for PreviewHandle unit tests: a window/document pair, iframe elements with
 * their own content windows, a container, and a synchronous MessageChannel.
 */
import { PROTOCOL_VERSION } from '@br/protocol';
import type { PreviewHandle, PreviewOptions } from '../src/preview/preview-handle';

type Handler = (event: unknown) => void;

class FakeEventTarget {
  private readonly handlers = new Map<string, Set<Handler>>();
  addEventListener(type: string, fn: Handler): void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: Handler): void {
    this.handlers.get(type)?.delete(fn);
  }
  dispatch(type: string, event: unknown): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn(event);
  }
  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

export class FakePort {
  other!: FakePort;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  /** Messages delivered to this port. */
  readonly received: unknown[] = [];
  postMessage(data: unknown): void {
    if (this.closed) return;
    this.other.deliver(data);
  }
  deliver(data: unknown): void {
    if (this.closed) return;
    this.received.push(structuredClone(data));
    this.onmessage?.({ data });
  }
  close(): void {
    this.closed = true;
  }
}

export class FakeMessageChannel {
  readonly port1 = new FakePort();
  readonly port2 = new FakePort();
  constructor() {
    this.port1.other = this.port2;
    this.port2.other = this.port1;
  }
}

export interface PostedMessage {
  data: unknown;
  targetOrigin: string;
  transfer: unknown[];
}

/** The iframe's `contentWindow` (one per element, like a WindowProxy). */
export class FakeContentWindow {
  readonly posted: PostedMessage[] = [];
  postMessage(data: unknown, targetOrigin: string, transfer: unknown[] = []): void {
    this.posted.push({ data, targetOrigin, transfer });
  }
  /** Ports received with `connect`, newest last. */
  connectPorts(): { nonce: string; port: FakePort }[] {
    return this.posted
      .filter((m) => (m.data as { type?: string }).type === 'connect')
      .map((m) => ({
        nonce: (m.data as { nonce: string }).nonce,
        port: m.transfer[0] as FakePort,
      }));
  }
}

abstract class FakeNode {
  parentNode: FakeContainer | null = null;
  replaceWith(node: FakeNode): void {
    this.parentNode?.replaceChild(node, this);
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
}

export class FakeComment extends FakeNode {
  constructor(readonly text: string) {
    super();
  }
}

export class FakeIframe extends FakeNode {
  private readonly attrs = new Map<string, string>();
  readonly contentWindow = new FakeContentWindow();
  title = '';
  /** Every navigation (src assignment) with the sandbox/allow in force at that moment. */
  readonly navigations: { src: string; sandbox: string | null; allow: string | null }[] = [];
  constructor(readonly ownerDocument: FakeDocument) {
    super();
  }
  get attributes(): { name: string; value: string }[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  set src(value: string) {
    this.attrs.set('src', value);
    this.navigations.push({
      src: value,
      sandbox: this.getAttribute('sandbox'),
      allow: this.getAttribute('allow'),
    });
  }
  get src(): string {
    return this.attrs.get('src') ?? '';
  }
}

export class FakeContainer extends FakeNode {
  readonly children: FakeNode[] = [];
  appendChild(node: FakeNode): void {
    node.remove();
    node.parentNode = this;
    this.children.push(node);
  }
  replaceChild(next: FakeNode, old: FakeNode): void {
    const i = this.children.indexOf(old);
    if (i === -1) return;
    next.remove();
    this.children[i] = next;
    next.parentNode = this;
    old.parentNode = null;
  }
  removeChild(node: FakeNode): void {
    const i = this.children.indexOf(node);
    if (i !== -1) this.children.splice(i, 1);
    node.parentNode = null;
  }
}

export class FakeWindow extends FakeEventTarget {}

export class FakeDocument extends FakeEventTarget {
  hidden = false;
  readonly defaultView = new FakeWindow();
  createElement(tag: string): FakeIframe {
    if (tag !== 'iframe') throw new Error(`unexpected element ${tag}`);
    return new FakeIframe(this);
  }
  createComment(text: string): FakeComment {
    return new FakeComment(text);
  }
}

export const SHELL_URL = 'https://b1.usercontent.example/v1/';
export const SHELL_ORIGIN = 'https://b1.usercontent.example';

export function helloFrom(source: unknown, origin = SHELL_ORIGIN) {
  return { origin, source, data: { type: 'hello', protocol: PROTOCOL_VERSION } };
}

/** A fake page: document, container and the first iframe (in the container). */
export function fakePage() {
  const doc = new FakeDocument();
  const container = new FakeContainer();
  const iframe = doc.createElement('iframe');
  iframe.setAttribute('id', 'preview');
  iframe.setAttribute('data-testid', 'preview-frame');
  container.appendChild(iframe);
  return { doc, win: doc.defaultView, container, iframe };
}

export type PreviewCtor = new (iframe: HTMLIFrameElement, opts: PreviewOptions) => PreviewHandle;

/**
 * A fake shell that answers on the port of the latest `connect` its window received. It
 * replies `connected`, records every message, and (optionally) answers pings.
 */
export class FakeShell {
  port: FakePort | null = null;
  autoPong = true;
  readonly messages: { type: string; [k: string]: unknown }[] = [];

  constructor(private readonly win: FakeContentWindow) {}

  /** Completes the handshake for the newest `connect` (call after the app sent it). */
  connect(): void {
    const latest = this.win.connectPorts().at(-1);
    if (!latest) throw new Error('no connect message was posted to this window');
    this.port = latest.port;
    this.port.onmessage = ({ data }) => {
      const msg = data as { type: string; seq?: number };
      this.messages.push(msg);
      if (msg.type === 'ping' && this.autoPong) this.send({ type: 'pong', seq: msg.seq });
    };
    this.send({ type: 'connected', nonce: latest.nonce });
  }

  send(msg: unknown): void {
    this.port?.postMessage(msg);
  }

  /** Messages of a given type the shell received. */
  received(type: string): { type: string; [k: string]: unknown }[] {
    return this.messages.filter((m) => m.type === type);
  }
}
