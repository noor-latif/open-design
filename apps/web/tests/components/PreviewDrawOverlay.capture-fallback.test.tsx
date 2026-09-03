// @vitest-environment jsdom

// Issue #4064: the srcDoc foreignObject snapshot bridge legitimately fails on
// real-world artifacts (Chromium often refuses to rasterize <foreignObject>
// HTML loaded via <img>). A failed screenshot must not dead-end an annotation
// that carries its own meaning without pixels (typed note / attached images) —
// the retry warning is a dead end because retrying the same pipeline fails the
// same way. Ink/box-only annotations still block: without the bitmap there is
// nothing to send.
// Extended tiers: host compositor -> displayMedia (secureContext) ->
// daemon Playwright -> foreignObject. Tests below cover tier fallback.

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreviewDrawOverlay } from '../../src/components/PreviewDrawOverlay';
import {
  captureDaemonScreenshot,
  captureViaDisplayMediaSnapshot,
  getDaemonScreenshotHtml,
  requestPreviewSnapshot,
} from '../../src/runtime/exports';

vi.mock('../../src/runtime/exports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime/exports')>();
  return {
    ...actual,
    requestPreviewSnapshot: vi.fn(async () => null),
    captureViaDisplayMediaSnapshot: vi.fn(async () => null),
    captureDaemonScreenshot: vi.fn(async () => null),
    getDaemonScreenshotHtml: vi.fn(() => null),
  };
});

let restoreRect: (() => void) | null = null;

function installCompositeMocks() {
  const originalImage = globalThis.Image;
  class MockImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      window.setTimeout(() => this.onload?.(), 0);
    }
  }
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: MockImage,
    writable: true,
  });
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => ({
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      lineCap: 'round',
      lineJoin: 'round',
      lineTo: vi.fn(),
      measureText: vi.fn(() => ({ width: 0 })),
      moveTo: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      setLineDash: vi.fn(),
      stroke: vi.fn(),
      strokeRect: vi.fn(),
      fillStyle: '',
      font: '',
      strokeStyle: '',
    })) as unknown as CanvasRenderingContext2D as unknown as HTMLCanvasElement['getContext'],
  );
  const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) => {
    cb(new Blob(['png'], { type: 'image/png' }));
  });
  return () => {
    getContext.mockRestore();
    toBlob.mockRestore();
    if (originalImage) {
      Object.defineProperty(globalThis, 'Image', { configurable: true, value: originalImage, writable: true });
    } else {
      delete (globalThis as { Image?: unknown }).Image;
    }
  };
}

beforeEach(() => {
  const rectSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 320,
      height: 200,
      right: 320,
      bottom: 200,
      toJSON: () => ({}),
    } as DOMRect);
  restoreRect = () => rectSpy.mockRestore();
  // Default: all tiers fail — existing fallback tests rely on this
  vi.mocked(requestPreviewSnapshot).mockResolvedValue(null);
  vi.mocked(captureViaDisplayMediaSnapshot).mockResolvedValue(null);
  vi.mocked(captureDaemonScreenshot).mockResolvedValue(null);
  vi.mocked(getDaemonScreenshotHtml).mockReturnValue(null);
  // Ensure displayMedia tier is attempted by default (secure context)
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true, writable: true });
});

afterEach(() => {
  cleanup();
  restoreRect?.();
  restoreRect = null;
  vi.mocked(requestPreviewSnapshot).mockClear();
  vi.mocked(captureViaDisplayMediaSnapshot).mockClear();
  vi.mocked(captureDaemonScreenshot).mockClear();
  vi.mocked(getDaemonScreenshotHtml).mockReset();
});

function drawSelectionBox(canvas: HTMLCanvasElement) {
  fireEvent.pointerDown(canvas, { clientX: 40, clientY: 30, pointerId: 1 });
  fireEvent.pointerMove(canvas, { clientX: 220, clientY: 150, pointerId: 1 });
  fireEvent.pointerUp(canvas, { clientX: 220, clientY: 150, pointerId: 1 });
}

describe('PreviewDrawOverlay capture fallback (issue #4064)', () => {
  it('sends a box annotation with a typed note even when the snapshot fails', async () => {
    const annotation = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<{ ack?: (result: { ok: boolean }) => void }>).detail;
      detail.ack?.({ ok: true });
    });
    window.addEventListener('opendesign:annotation', annotation);

    try {
      const { container, getByRole, getByText } = render(
        <PreviewDrawOverlay active>
          <iframe title="srcdoc" data-od-render-mode="srcdoc" />
        </PreviewDrawOverlay>,
      );

      const canvas = container.querySelector<HTMLCanvasElement>('canvas');
      expect(canvas).toBeTruthy();
      drawSelectionBox(canvas!);

      const input = container.querySelector<HTMLInputElement>('.preview-draw-note-input');
      expect(input).toBeTruthy();
      fireEvent.change(input!, { target: { value: 'This section is missing its bar chart.' } });

      fireEvent.click(getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(annotation).toHaveBeenCalledTimes(1));
      expect(annotation.mock.calls[0]?.[0]).toMatchObject({
        detail: expect.objectContaining({
          action: 'send',
          note: 'This section is missing its bar chart.',
          file: null,
        }),
      });
      await waitFor(() =>
        expect(
          getByText('Could not capture the preview. The annotation was sent without a screenshot.'),
        ).toBeTruthy(),
      );
    } finally {
      window.removeEventListener('opendesign:annotation', annotation);
    }
  });

  it('still blocks a box-only annotation with no note when the snapshot fails', async () => {
    const annotation = vi.fn();
    window.addEventListener('opendesign:annotation', annotation);

    try {
      const { container, getByRole, getByText } = render(
        <PreviewDrawOverlay active>
          <iframe title="srcdoc" data-od-render-mode="srcdoc" />
        </PreviewDrawOverlay>,
      );

      const canvas = container.querySelector<HTMLCanvasElement>('canvas');
      expect(canvas).toBeTruthy();
      drawSelectionBox(canvas!);

      fireEvent.click(getByRole('button', { name: 'Send' }));

      await waitFor(() =>
        expect(
          getByText('Could not capture the preview. Try again to avoid sending only ink.'),
        ).toBeTruthy(),
      );
      expect(annotation).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('opendesign:annotation', annotation);
    }
  });

  it('host unavailable -> daemon success: box-only annotation sends via daemon tier', async () => {
    const restoreComposite = installCompositeMocks();
    const annotation = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<{ ack?: (result: { ok: boolean }) => void }>).detail;
      detail.ack?.({ ok: true });
    });
    window.addEventListener('opendesign:annotation', annotation);

    // Host unavailable: no captureSnapshot prop, so overlay skips tier 1
    // displayMedia also unavailable -> daemon succeeds
    vi.mocked(captureViaDisplayMediaSnapshot).mockResolvedValue(null);
    vi.mocked(getDaemonScreenshotHtml).mockReturnValue('<html><body>daemon html</body></html>');
    vi.mocked(captureDaemonScreenshot).mockResolvedValue({
      dataUrl: 'data:image/png;base64,daemon',
      w: 320,
      h: 200,
    });
    vi.mocked(requestPreviewSnapshot).mockResolvedValue(null);

    try {
      const { container, getByRole } = render(
        <PreviewDrawOverlay active>
          <iframe title="srcdoc" data-od-render-mode="srcdoc" />
        </PreviewDrawOverlay>,
      );
      const canvas = container.querySelector<HTMLCanvasElement>('canvas');
      expect(canvas).toBeTruthy();
      drawSelectionBox(canvas!);

      fireEvent.click(getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(annotation).toHaveBeenCalledTimes(1));
      expect(annotation.mock.calls[0]?.[0]).toMatchObject({
        detail: expect.objectContaining({ action: 'send', file: expect.any(File) }),
      });
      expect(captureDaemonScreenshot).toHaveBeenCalledTimes(1);
      expect(captureViaDisplayMediaSnapshot).toHaveBeenCalled();
    } finally {
      window.removeEventListener('opendesign:annotation', annotation);
      restoreComposite();
    }
  });

  it('daemon 503 (null) falls through to foreignObject bridge', async () => {
    const restoreComposite = installCompositeMocks();
    const annotation = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<{ ack?: (result: { ok: boolean }) => void }>).detail;
      detail.ack?.({ ok: true });
    });
    window.addEventListener('opendesign:annotation', annotation);

    vi.mocked(captureViaDisplayMediaSnapshot).mockResolvedValue(null);
    vi.mocked(getDaemonScreenshotHtml).mockReturnValue('<html><body>daemon html</body></html>');
    // Simulate 503: daemon returns null so caller falls through
    vi.mocked(captureDaemonScreenshot).mockResolvedValue(null);
    vi.mocked(requestPreviewSnapshot).mockResolvedValue({
      dataUrl: 'data:image/png;base64,foreign',
      w: 320,
      h: 200,
    });

    try {
      const { container, getByRole } = render(
        <PreviewDrawOverlay active>
          <iframe title="srcdoc" data-od-render-mode="srcdoc" />
        </PreviewDrawOverlay>,
      );
      const canvas = container.querySelector<HTMLCanvasElement>('canvas');
      drawSelectionBox(canvas!);

      fireEvent.click(getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(annotation).toHaveBeenCalledTimes(1));
      expect(annotation.mock.calls[0]?.[0]).toMatchObject({
        detail: expect.objectContaining({ file: expect.any(File) }),
      });
      expect(captureDaemonScreenshot).toHaveBeenCalled();
      expect(requestPreviewSnapshot).toHaveBeenCalled();
    } finally {
      window.removeEventListener('opendesign:annotation', annotation);
      restoreComposite();
    }
  });

  it('displayMedia success path sends box-only annotation without daemon', async () => {
    const restoreComposite = installCompositeMocks();
    const annotation = vi.fn((event: Event) => {
      const detail = (event as CustomEvent<{ ack?: (result: { ok: boolean }) => void }>).detail;
      detail.ack?.({ ok: true });
    });
    window.addEventListener('opendesign:annotation', annotation);

    vi.mocked(captureViaDisplayMediaSnapshot).mockResolvedValue({
      dataUrl: 'data:image/png;base64,displaymedia',
      w: 320,
      h: 200,
    });
    // daemon should not be called when displayMedia succeeds
    vi.mocked(getDaemonScreenshotHtml).mockReturnValue('<html>should not be used</html>');
    vi.mocked(captureDaemonScreenshot).mockResolvedValue({
      dataUrl: 'data:image/png;base64,daemon-should-not-be-reached',
      w: 10,
      h: 10,
    });
    vi.mocked(requestPreviewSnapshot).mockResolvedValue(null);

    try {
      const { container, getByRole } = render(
        <PreviewDrawOverlay active>
          <iframe title="srcdoc" data-od-render-mode="srcdoc" />
        </PreviewDrawOverlay>,
      );
      const canvas = container.querySelector<HTMLCanvasElement>('canvas');
      drawSelectionBox(canvas!);

      fireEvent.click(getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(annotation).toHaveBeenCalledTimes(1));
      expect(annotation.mock.calls[0]?.[0]).toMatchObject({
        detail: expect.objectContaining({ file: expect.any(File) }),
      });
      expect(captureViaDisplayMediaSnapshot).toHaveBeenCalledTimes(1);
      // daemon tier skipped after displayMedia success
      expect(captureDaemonScreenshot).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('opendesign:annotation', annotation);
      restoreComposite();
    }
  });
});
