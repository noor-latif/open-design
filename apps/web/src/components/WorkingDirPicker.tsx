import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { Icon } from './Icon';
import styles from './WorkingDirPicker.module.css';
import { listFsEntries } from '../state/project-locations';
import type { FsListResponse } from '../state/project-locations';

interface Props {
  /**
   * Currently selected local working directory shown inline with a clear
   * button, or null to show only the "select" label (e.g. when the selection
   * is surfaced elsewhere, like the project composer's linked-dir chips).
   */
  workingDir: string | null;
  /** Most-recently-used directories, most-recent-first. */
  recentDirs: string[];
  /** Open the native folder picker (kept for fallback — web inline now preferred). */
  onPickDirectory?: () => void;
  /** Re-select a previously used directory (also used for newly browsed picks). */
  onSelectRecent: (dir: string) => void;
  /** Clear the current selection. Only reachable when `workingDir` is set. */
  onClear?: () => void;
  /** Extra class applied to the outer wrapper, for layout by the host. */
  className?: string;
  /** Optional empty-state label for hosts that need a shorter trigger. */
  emptyLabel?: string;
  /** The selected directory no longer exists on disk — flag it in red. */
  invalid?: boolean;
  /**
   * Panel direction. `'down'` (default) suits the Home composer where there
   * is room below; `'up'` suits the in-project composer whose trigger sits at
   * the bottom of the viewport, so a downward panel would be clipped.
   */
  placement?: 'down' | 'up';
  /** Fired when the panel opens, so the host can re-validate freshness. */
  onOpen?: () => void;
}

function basename(dir: string): string {
  return dir.split(/[/\\]/).filter(Boolean).pop() ?? dir;
}

/**
 * Working-directory picker: a borderless trigger that opens a panel with
 * "Choose folder" and a "Recent folders" submenu. Picking a directory grants
 * the agent read-only awareness of those local files (via the project's
 * `linkedDirs` → `--add-dir`); it does NOT import the folder into Design
 * Files. Shared by the Home composer and the in-project composer; layout is
 * left to the host via `className`.
 */
export function WorkingDirPicker({
  workingDir,
  recentDirs,
  onPickDirectory,
  onSelectRecent,
  onClear,
  className,
  emptyLabel,
  placement = 'down',
  invalid = false,
  onOpen,
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Inline web-native browser state — lives inside the same 220px panel.
  const [browsing, setBrowsing] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FsListResponse | null>(null);
  const [browsingLoading, setBrowsingLoading] = useState(false);
  const [browsingError, setBrowsingError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState('');

  const loadBrowserPath = useCallback(async (targetPath: string) => {
    setBrowsingLoading(true);
    setBrowsingError(null);
    try {
      let res = await listFsEntries(targetPath);
      // Fallback chain for container defaults like ProjectLocationsSection: dev → home → root.
      if (!res && targetPath === '/var/home/noor/dev') {
        res = await listFsEntries('/var/home/noor');
      }
      if (!res && (targetPath === '/var/home/noor/dev' || targetPath === '/var/home/noor')) {
        res = await listFsEntries('/');
      }
      if (!res) {
        setBrowsingError('Could not list that folder. Use manual path.');
        return;
      }
      setEntries(res);
      setCurrentPath(res.path);
      setManualPath(res.path);
    } catch {
      setBrowsingError('Could not list that folder. Use manual path.');
    } finally {
      setBrowsingLoading(false);
    }
  }, []);

  const handleChooseFolder = useCallback(async () => {
    const initial = workingDir?.trim() || '/var/home/noor/dev';
    setBrowsing(true);
    setRecentOpen(false);
    setCurrentPath(initial);
    setManualPath(initial);
    await loadBrowserPath(initial);
  }, [workingDir, loadBrowserPath]);

  const handleSelectThisFolder = useCallback(() => {
    const chosen = manualPath.trim() || currentPath.trim();
    if (!chosen) return;
    onSelectRecent(chosen);
    setOpen(false);
    setBrowsing(false);
    setRecentOpen(false);
  }, [manualPath, currentPath, onSelectRecent]);

  const handleBrowserNavigate = useCallback(async (dirName: string) => {
    const nextPath = currentPath.endsWith('/') ? currentPath + dirName : currentPath + '/' + dirName;
    await loadBrowserPath(nextPath);
  }, [currentPath, loadBrowserPath]);

  const handleBrowserUp = useCallback(async () => {
    if (!entries?.parent) return;
    await loadBrowserPath(entries.parent);
  }, [entries, loadBrowserPath]);

  useEffect(() => {
    if (!open) {
      setRecentOpen(false);
      return;
    }
    function onPointer(event: MouseEvent) {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setBrowsing(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (browsing) {
          setBrowsing(false);
          return;
        }
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, browsing]);

  // Reset browsing when panel closes; keep manualPath in sync when browsing opens.
  useEffect(() => {
    if (!open) setBrowsing(false);
  }, [open]);

  return (
    <div
      ref={wrapRef}
      className={`${styles.wrap}${className ? ` ${className}` : ''}`}
      data-testid="working-dir-picker"
    >
      <div className={styles.triggerRow}>
        <button
          type="button"
          className={`${styles.trigger}${invalid ? ` ${styles.triggerInvalid}` : ''}`}
          data-testid="working-dir-trigger"
          aria-expanded={open}
          title={invalid ? t('homeWorkingDir.missing') : (workingDir ?? t('homeWorkingDir.hint'))}
          onClick={() =>
            setOpen((v) => {
              if (!v) onOpen?.();
              return !v;
            })
          }
        >
          <Icon name="folder" size={14} className={styles.triggerIcon} />
          <span className={styles.triggerLabel}>
            {workingDir ? basename(workingDir) : (emptyLabel ?? t('homeWorkingDir.trigger'))}
          </span>
          <Icon name="chevron-down" size={14} className={styles.triggerChevron} />
        </button>
      </div>

      {open ? (
        <div
          className={`${styles.panel}${placement === 'up' ? ` ${styles.panelUp}` : ''}${browsing ? ` ${styles.panelBrowsing}` : ''}`}
          role="menu"
          data-testid="working-dir-panel"
        >
          {browsing ? (
            <>
              <div className={styles.browserHeader}>
                <code className={styles.browserPath} title={currentPath || manualPath}>
                  {currentPath || manualPath || '/'}
                </code>
                <button
                  type="button"
                  className={styles.browserIconBtn}
                  onClick={handleBrowserUp}
                  disabled={!entries?.parent || browsingLoading}
                  title="Go up"
                  aria-label="Go up"
                >
                  <Icon name="arrow-up" size={14} />
                </button>
                <button
                  type="button"
                  className={styles.browserIconBtn}
                  onClick={() => loadBrowserPath(currentPath || manualPath || '/var/home/noor/dev')}
                  disabled={browsingLoading}
                  title="Refresh"
                  aria-label="Refresh"
                >
                  <Icon name="refresh" size={14} />
                </button>
              </div>

              <div className={styles.browserList} role="listbox" data-testid="working-dir-browser-list">
                {browsingLoading ? (
                  <div className={styles.browserHint}>Loading…</div>
                ) : browsingError ? (
                  <div className={styles.browserError}>{browsingError}</div>
                ) : entries ? (
                  entries.entries.filter((e) => e.isDirectory).length === 0 ? (
                    <div className={styles.browserHint}>No subfolders — select this folder or type a path below</div>
                  ) : (
                    entries.entries
                      .filter((e) => e.isDirectory)
                      .map((entry) => (
                        <button
                          key={entry.name}
                          type="button"
                          role="option"
                          className={styles.browserItem}
                          onClick={() => handleBrowserNavigate(entry.name)}
                          title={entry.name}
                        >
                          <Icon name="folder" size={14} className={styles.browserItemIcon} />
                          <span className={styles.browserItemName}>{entry.name}</span>
                        </button>
                      ))
                  )
                ) : null}
              </div>

              <div className={styles.browserInputRow}>
                <input
                  type="text"
                  className={styles.browserInput}
                  value={manualPath}
                  onChange={(e) => setManualPath(e.target.value)}
                  placeholder={currentPath || '/var/home/noor/dev'}
                  spellCheck={false}
                  autoComplete="off"
                  data-testid="working-dir-manual-input"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSelectThisFolder();
                    }
                  }}
                />
              </div>

              <div className={styles.browserActions}>
                <button
                  type="button"
                  className="primary"
                  data-testid="working-dir-select-this"
                  onClick={handleSelectThisFolder}
                  disabled={!manualPath.trim() && !currentPath.trim()}
                >
                  Select this folder
                </button>
                <button
                  type="button"
                  className="ghost"
                  data-testid="working-dir-browser-cancel"
                  onClick={() => setBrowsing(false)}
                >
                  Cancel
                </button>
                {browsingError && onPickDirectory ? (
                  <button
                    type="button"
                    className="ghost"
                    style={{ opacity: 0.6, marginLeft: 'auto', fontSize: 12 }}
                    onClick={() => {
                      setOpen(false);
                      setBrowsing(false);
                      onPickDirectory();
                    }}
                  >
                    System picker
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                className={styles.item}
                data-testid="working-dir-pick"
                onClick={handleChooseFolder}
              >
                <Icon name="folder" size={14} className={styles.itemIcon} />
                <span>{workingDir ? t('homeWorkingDir.replace') : t('homeWorkingDir.pick')}</span>
              </button>

              <div
                className={styles.submenuRow}
                onMouseEnter={() => setRecentOpen(true)}
                onMouseLeave={() => setRecentOpen(false)}
              >
                <button
                  type="button"
                  role="menuitem"
                  className={styles.item}
                  aria-haspopup="menu"
                  aria-expanded={recentOpen}
                  data-testid="working-dir-recent"
                  onClick={() => setRecentOpen((v) => !v)}
                >
                  <Icon name="history" size={14} className={styles.itemIcon} />
                  <span>{t('homeWorkingDir.recent')}</span>
                  <Icon name="chevron-right" size={14} className={styles.itemChevron} />
                </button>
                {recentOpen ? (
                  <div
                    className={`${styles.flyout}${placement === 'up' ? ` ${styles.flyoutUp}` : ''}`}
                    role="menu"
                    data-testid="working-dir-recent-list"
                  >
                    {recentDirs.length === 0 ? (
                      <div className={styles.empty}>{t('homeWorkingDir.recentEmpty')}</div>
                    ) : (
                      recentDirs.map((dir) => (
                        <button
                          key={dir}
                          type="button"
                          role="menuitem"
                          className={styles.recentItem}
                          title={dir}
                          onClick={() => {
                            onSelectRecent(dir);
                            setOpen(false);
                          }}
                        >
                          <Icon name="folder" size={14} className={styles.itemIcon} />
                          <span className={styles.recentName}>{basename(dir)}</span>
                          <span className={styles.recentPath}>{dir}</span>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>

              {workingDir && onClear ? (
                <button
                  type="button"
                  role="menuitem"
                  className={styles.item}
                  data-testid="working-dir-clear"
                  onClick={() => {
                    onClear();
                    setOpen(false);
                  }}
                >
                  <Icon name="close" size={14} className={styles.itemIcon} />
                  <span>{t('homeWorkingDir.clear')}</span>
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
