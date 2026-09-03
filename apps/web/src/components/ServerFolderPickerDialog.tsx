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
  picking?: boolean;
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
  picking = false,
}: ServerFolderPickerDialogProps) {
  const [currentPath, setCurrentPath] = useState(initialPath ?? '/var/home/noor/dev');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState(initialPath ?? '/var/home/noor/dev');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastFetchedRef = useRef<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

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
      // Clear selection when navigating — selection is for picking a child without entering it
      setSelectedPath(null);
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
    const target = selectedPath ?? currentPath;
    if (!target) return;
    onPick(target);
  }, [selectedPath, currentPath, onPick]);

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
  const canSelect = Boolean((selectedPath ?? currentPath) && !loading && !picking);

  const dialog = (
    <Dialog
      onClose={onCancel}
      closeOnBackdrop
      closeOnEscape
      ariaLabel="Choose folder on server"
      className={styles.dialog}
      data-testid="server-folder-picker-dialog"
    >
      <DialogTitle className={styles.title}>Open folder on server</DialogTitle>
      <p className={styles.helper} data-testid="server-folder-picker-helper">
        Shows folders on the server &mdash; not your browser. In Docker, host folders must be bind-mounted
        first (<code>{`$\{HOME\}/dev:$\{HOME\}/dev:rw`}</code> &rarr; pick <code>/var/home/noor/dev/…</code>).
      </p>

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

        {/* List — single-click selects, double-click or chevron enters */}
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
                  <Icon name="arrow-up" size={14} className={styles.rowChevron} />
                </button>
              ) : null}
              {entries.length === 0 ? (
                <div className={styles.hint} data-testid="server-folder-picker-empty">
                  No subfolders
                </div>
              ) : (
                entries.map((e) => {
                  const isSelected = selectedPath === e.path;
                  return (
                    <div
                      key={e.path}
                      className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
                      data-testid={`server-folder-picker-entry-${e.name}`}
                      role="option"
                      aria-selected={isSelected}
                    >
                      <button
                        type="button"
                        className={styles.rowMain}
                        onClick={() => setSelectedPath(e.path)}
                        onDoubleClick={() => onPick(e.path)}
                        title={`Select ${e.path}`}
                      >
                        <Icon name="folder" size={15} className={styles.rowIcon} />
                        <span className={styles.rowName}>{e.name}</span>
                        {isSelected ? (
                          <Icon name="check" size={14} className={styles.rowCheck} />
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className={styles.rowEnter}
                        onClick={() => handleNavigate(e.path)}
                        title={`Open ${e.name}`}
                        aria-label={`Open ${e.name}`}
                      >
                        <Icon name="chevron-right" size={14} className={styles.rowChevron} />
                      </button>
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>

        {/* Current selection hint — shows what Select will open */}
        <p className={styles.selectionHint} data-testid="server-folder-picker-current">
          <Icon name="folder-filled" size={13} />{' '}
          {selectedPath ? (
            <>
              Selected: <code>{selectedPath}</code>
            </>
          ) : (
            <>
              This folder: <code>{currentPath || '/'}</code>
            </>
          )}
        </p>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={picking} data-testid="server-folder-picker-cancel">
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSelect}
          disabled={!canSelect}
          data-testid="server-folder-picker-select"
        >
          {picking ? (
            <>
              <Icon name="spinner" size={14} className={styles.spin} /> Opening…
            </>
          ) : selectedPath ? (
            <>Open {selectedPath.split('/').pop()}</>
          ) : (
            <>Open this folder</>
          )}
        </Button>
      </DialogFooter>
    </Dialog>
  );

  if (typeof document === 'undefined') return dialog;
  return createPortal(dialog, document.body);
}
