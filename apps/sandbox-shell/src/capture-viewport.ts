/**
 * Fixed viewport of a capture (docs/03 §3.7). The renderer uses the same size at DPR 1. In a
 * module of its own so the capture page's script does not bundle the gate (and zod with it).
 */
export const CAPTURE_VIEWPORT = { width: 1280, height: 800 } as const;
