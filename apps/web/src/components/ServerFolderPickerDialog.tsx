import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog, DialogFooter, DialogTitle } from '@open-design/components';
import { Icon } from './Icon';
import styles from './ServerFolderPickerDialog.module.css';

export interface ServerFolderPickerDialogProps {
  open: boolean;
  initialPath?: string;
  onPick: (absolutePath: string) => void;
  onCancel: () => void;
}

interface BrowseEntry {
  name: string;
  path: string;
  hasChildren: boolean;
}

interface BrowseResponse {
  currentPath: string;
  parentPath: string | null;
  entries: BrowseEntry[];
}

async function fetchBrowse(path: string): Promise<BrowseResponse> {
  const url = `/api/fs/browse?path=${encodeURIComponent(path)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    let message = `Failed to browse (${resp.status})`;
    try {
      const body = (await resp.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error.trim()) {
        message = body.error;
      } else if (
        body.error &&
        typeof body.error === 'object' &&
        'message' in body.error &&
        typeof (body.error as { message: unknown }).message === 'string'
      ) {
        const m = (body.error as { message: string }).message.trim();
        if (m) message = m;
      }
    } catch {
      // keep default
    }
    const err = new Error(message) as Error & { status?: number };
    err.status = resp.status;
    throw err;
  }
  const data = (await resp.json()) as BrowseResponse;
  return data;
}

function breadcrumbSegments(currentPath: string): Array<{ label: string; path: string }> {
  if (!currentPath || currentPath === '/') {
    return [{ label: '/', path: '/' }];
  }
  const parts = currentPath.split('/').filter(Boolean);
  const segs: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }];
  let accum = '';
  for (const part of parts) {
    accum += `/${part}`;
    segs.push({ label: part, path: accum });
  }
  return segs;
}

export function ServerFolderPickerDialog({
  open,
  initialPath,
  onPick,
  onCancel,
}: ServerFolderPickerDialogProps) {
  const [currentPath, setCurrentPath] = useState(initialPath ?? '/var/home/noor/dev');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState(initialPath ?? '/var/home/noor/dev');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastFetchedRef = useRef<string | null>(null);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchBrowse(target);
      setCurrentPath(data.currentPath);
      setParentPath(data.parentPath);
      setEntries(data.entries);
      setInputValue(data.currentPath);
      lastFetchedRef.current = data.currentPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load folder';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load when opened
  useEffect(() => {
    if (!open) return;
    const target = initialPath?.trim() ? initialPath.trim() : '/var/home/noor/dev';
    setInputValue(target);
    // Avoid double-fetch if already on same path and we have entries
    if (lastFetchedRef.current === target && entries.length > 0 && currentPath === target) {
      return;
    }
    void load(target);
    // focus input after open
    const id = window.setTimeout(() => inputRef.current?.select(), 80);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPath]);

  // Keep inputValue in sync when currentPath changes via navigation (but not while user is typing)
  // We handle this inside load; input is controlled separately.

  const handleNavigate = useCallback(
    (next: string) => {
      void load(next);
    },
    [load],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const trimmed = inputValue.trim();
        if (!trimmed) return;
        void load(trimmed);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    },
    [inputValue, load, onCancel],
  );

  const handleSelect = useCallback(() => {
    if (!currentPath) return;
    onPick(currentPath);
  }, [currentPath, onPick]);

  // Global keyboard: Enter selects, Escape cancels (when not handled by input)
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        // If input is focused, its own handler navigates; don't double-select
        const active = document.activeElement;
        if (active === inputRef.current) return;
        // Only select if not loading
        if (!loading && currentPath) {
          e.preventDefault();
          onPick(currentPath);
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, loading, currentPath, onCancel, onPick]);

  if (!open) return null;

  const segs = breadcrumbSegments(currentPath);
  const canSelect = Boolean(currentPath && !loading);

  const dialog = (
    <Dialog
      onClose={onCancel}
      closeOnBackdrop
      closeOnEscape
      ariaLabel="Choose folder on server"
      className={styles.dialog}
      data-testid="server-folder-picker-dialog"
    >
      <DialogTitle className={styles.title}>Choose folder on server</DialogTitle>

      <div className={styles.body}>
        {/* Path input */}
        <div className={styles.pathRow}>
          <input
            ref={inputRef}
            type="text"
            className={styles.pathInput}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="/var/home/noor/dev"
            spellCheck={false}
            autoComplete="off"
            data-testid="server-folder-picker-input"
          />
          <Button
            variant="ghost"
            className={styles.goBtn}
            onClick={() => {
              const t = inputValue.trim();
              if (t) void load(t);
            }}
            disabled={loading}
            aria-label="Go to path"
          >
            Go
          </Button>
        </div>

        {/* Breadcrumb */}
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          {segs.map((s, i) => (
            <span key={s.path} className={styles.crumbWrap}>
              {i > 0 ? <span className={styles.crumbSep}>/</span> : null}
              <button
                type="button"
                className={`${styles.crumb} ${i === segs.length - 1 ? styles.crumbCurrent : ''}`}
                onClick={() => handleNavigate(s.path)}
                disabled={loading}
                title={s.path}
                data-testid={i === 0 ? 'server-folder-picker-crumb-root' : `server-folder-picker-crumb-${s.label}`}
              >
                {s.label === '/' ? '/' : s.label}
              </button>
            </span>
          ))}
        </nav>

        {error ? (
          <p className={styles.error} role="alert" data-testid="server-folder-picker-error">
            <Icon name="alert-triangle" size={13} /> {error}
          </p>
        ) : null}

        {/* List */}
        <div className={styles.list} role="listbox" data-testid="server-folder-picker-list">
          {loading ? (
            <div className={styles.hint} data-testid="server-folder-picker-loading">
              <Icon name="spinner" size={14} className={styles.spin} /> Loading…
            </div>
          ) : (
            <>
              {parentPath ? (
                <button
                  type="button"
                  className={styles.row}
                  onClick={() => handleNavigate(parentPath)}
                  data-testid="server-folder-picker-parent"
                >
                  <Icon name="folder" size={15} className={styles.rowIcon} />
                  <span className={styles.rowName}>..</span>
                </button>
              ) : null}
              {entries.length === 0 ? (
                <div className={styles.hint} data-testid="server-folder-picker-empty">
                  No subfolders
                </div>
              ) : (
                entries.map((e) => (
                  <button
                    key={e.path}
                    type="button"
                    className={styles.row}
                    onClick={() => handleNavigate(e.path)}
                    onDoubleClick={() => onPick(e.path)}
                    title={e.path}
                    data-testid={`server-folder-picker-entry-${e.name}`}
                  >
                    <Icon name="folder" size={15} className={styles.rowIcon} />
                    <span className={styles.rowName}>{e.name}</span>
                    {e.hasChildren ? (
                      <Icon name="chevron-right" size={14} className={styles.rowChevron} />
                    ) : null}
                  </button>
                ))
              )}
            </>
          )}
        </div>

        {/* Current selection hint */}
        <p className={styles.selectionHint} data-testid="server-folder-picker-current">
          <Icon name="folder-filled" size={13} /> <code>{currentPath || '/'}</code>
        </p>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} data-testid="server-folder-picker-cancel">
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSelect}
          disabled={!canSelect}
          data-testid="server-folder-picker-select"
        >
          Select
        </Button>
      </DialogFooter>
    </Dialog>
  );

  if (typeof document === 'undefined') return dialog;
  return createPortal(dialog, document.body);
}
