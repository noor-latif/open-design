import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ProjectLocation } from '@open-design/contracts';
import type { AppConfig } from '../types';
import {
  fetchProjectLocations,
  listFsEntries,
  openProjectLocationFolderDialog,
  scanProjectLocations,
  updateProjectLocations,
} from '../state/project-locations';
import type { FsListResponse } from '../state/project-locations';
import { useI18n } from '../i18n';
import { Icon } from './Icon';

interface Props {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
  onProjectsRefresh?: () => Promise<void> | void;
}

interface DraftLocation {
  id?: string;
  path: string;
}

function locationLabel(locationPath: string): string {
  return locationPath.split(/[\\/]/).filter(Boolean).pop() || locationPath;
}

function externalLocations(locations: ProjectLocation[]): DraftLocation[] {
  return locations
    .filter((location) => !location.builtIn)
    .map((location) => ({ id: location.id, path: location.path }));
}

function toConfigLocations(locations: ProjectLocation[]): NonNullable<AppConfig['projectLocations']> {
  return locations
    .filter((location) => !location.builtIn)
    .map((location) => ({ id: location.id, name: location.name, path: location.path }));
}

export function ProjectLocationsSection({ cfg, setCfg, onProjectsRefresh }: Props) {
  const { t } = useI18n();
  const [locations, setLocations] = useState<ProjectLocation[]>([]);
  const [drafts, setDrafts] = useState<DraftLocation[]>(cfg.projectLocations ?? []);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draftsRef = useRef<DraftLocation[]>(drafts);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPath, setPickerPath] = useState('/var/home/noor/dev');
  const [pickerEntries, setPickerEntries] = useState<FsListResponse | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState('/var/home/noor/dev');

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchProjectLocations()
      .then((next) => {
        if (cancelled) return;
        setLocations(next);
        setDrafts(externalLocations(next));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setCfg]);

  const builtIn = useMemo(
    () => locations.find((location) => location.builtIn),
    [locations],
  );
  const effectiveDefaultLocationId = useMemo(() => {
    const configured = cfg.defaultProjectLocationId ?? 'default';
    return locations.some((location) => location.id === configured) ? configured : 'default';
  }, [cfg.defaultProjectLocationId, locations]);

  function defaultControlLabel(locationId: string): string {
    return effectiveDefaultLocationId === locationId
      ? t('settings.projectLocationsDefaultBadge')
      : t('settings.projectLocationsMakeDefault');
  }

  function handleDefaultLocationChange(locationId: string) {
    setError(null);
    setStatus(t('settings.projectLocationsDefaultSaved'));
    setCfg((current) => ({ ...current, defaultProjectLocationId: locationId }));
  }

  async function save(nextDrafts: DraftLocation[]) {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await updateProjectLocations(
        nextDrafts.filter((location) => location.path.trim()),
      );
      if (!saved) {
        setError(t('settings.projectLocationsSaveError'));
        return null;
      }
      setLocations(saved);
      const external = externalLocations(saved);
      setDrafts(external);
      setCfg((current) => {
        const configuredDefault = current.defaultProjectLocationId ?? 'default';
        const nextDefault = saved.some((location) => location.id === configuredDefault)
          ? configuredDefault
          : 'default';
        return {
          ...current,
          projectLocations: toConfigLocations(saved),
          defaultProjectLocationId: nextDefault,
        };
      });
      setStatus(t('settings.projectLocationsSaved'));
      void onProjectsRefresh?.();
      return external;
    } finally {
      setSaving(false);
    }
  }

  async function runScan() {
    const result = await scanProjectLocations();
    if (!result) {
      setError(t('settings.projectLocationsScanError'));
      return null;
    }
    setStatus(t('settings.projectLocationsScanComplete', {
      imported: result.imported.length,
      existing: result.existing.length,
    }));
    void onProjectsRefresh?.();
    return result;
  }

  async function loadPicker(targetPath: string) {
    setPickerLoading(true);
    setPickerError(null);
    try {
      const res = await listFsEntries(targetPath);
      if (!res) {
        setPickerError('Could not list that folder. Use manual path.');
        return;
      }
      setPickerEntries(res);
      setPickerPath(res.path);
      setManualPath(res.path);
    } catch {
      setPickerError('Could not list that folder. Use manual path.');
    } finally {
      setPickerLoading(false);
    }
  }

  async function handleAddFolder() {
    setError(null);
    setStatus(null);
    setPickerOpen(true);
    setPickerError(null);
    // ensure manualPath reflects pickerPath even if list fails
    setManualPath(pickerPath);
    await loadPicker(pickerPath);
  }

  async function handleSystemPicker() {
    setError(null);
    setStatus(null);
    const selected = await openProjectLocationFolderDialog();
    if (!selected) {
      setStatus(t('settings.projectLocationsNoFolderSelected'));
      return;
    }
    if (draftsRef.current.some((draft) => draft.path === selected)) {
      setStatus(t('settings.projectLocationsDuplicate'));
      return;
    }
    const previous = draftsRef.current;
    const next = [...previous, { path: selected }];
    setDrafts(next);
    const saved = await save(next);
    if (!saved) setDrafts(previous);
    else await runScan();
  }

  async function handleSelectPickerFolder() {
    const chosen = manualPath.trim() || pickerPath;
    if (!chosen) return;
    if (draftsRef.current.some((draft) => draft.path === chosen)) {
      setPickerError(t('settings.projectLocationsDuplicate'));
      return;
    }
    const previous = draftsRef.current;
    const next = [...previous, { path: chosen }];
    setDrafts(next);
    setPickerOpen(false);
    const saved = await save(next);
    if (!saved) setDrafts(previous);
    else await runScan();
  }

  async function handlePickerNavigate(dirName: string) {
    const nextPath = pickerPath.endsWith('/') ? pickerPath + dirName : pickerPath + '/' + dirName;
    await loadPicker(nextPath);
  }

  async function handlePickerUp() {
    if (!pickerEntries?.parent) return;
    await loadPicker(pickerEntries.parent);
  }

  async function removeDraft(index: number) {
    const previous = draftsRef.current;
    const next = previous.filter((_, i) => i !== index);
    setDrafts(next);
    const saved = await save(next);
    if (!saved) setDrafts(previous);
  }

  return (
    <section className="settings-section settings-section-card project-locations-section">
      <div className="section-head">
        <div>
          <h3>{t('settings.projectLocations')}</h3>
          <p className="hint">{t('settings.projectLocationsDescription')}</p>
        </div>
      </div>

      {builtIn ? (
        <div className={`project-location-card is-built-in${effectiveDefaultLocationId === builtIn.id ? ' is-default' : ''}`}>
          <div>
            <strong>{t('newproj.locationDefault')}</strong>
            <code>{builtIn.path}</code>
          </div>
          <label className="project-location-default-control">
            <input
              type="radio"
              name="project-location-default"
              checked={effectiveDefaultLocationId === builtIn.id}
              onChange={() => handleDefaultLocationChange(builtIn.id)}
            />
            <span>{defaultControlLabel(builtIn.id)}</span>
          </label>
          <button
            type="button"
            className="icon-btn project-location-add"
            onClick={handleAddFolder}
            disabled={loading || saving}
          >
            <Icon name="plus" size={14} />
            {t('settings.projectLocationsAddFolder')}
          </button>
        </div>
      ) : null}

      <div className="project-location-list">
        {drafts.map((draft, index) => (
          <div
            className={`project-location-edit${draft.id && effectiveDefaultLocationId === draft.id ? ' is-default' : ''}`}
            key={`${draft.id ?? 'new'}-${index}`}
          >
            <div className="project-location-edit-main">
              <strong>{locationLabel(draft.path)}</strong>
              <code>{draft.path}</code>
              <small>{t('settings.projectLocationsWorkBaseMeta')}</small>
            </div>
            {draft.id ? (
              <label className="project-location-default-control">
                <input
                  type="radio"
                  name="project-location-default"
                  checked={effectiveDefaultLocationId === draft.id}
                  onChange={() => handleDefaultLocationChange(draft.id!)}
                />
                <span>{defaultControlLabel(draft.id)}</span>
              </label>
            ) : null}
            <button type="button" className="icon-btn danger" onClick={() => removeDraft(index)} disabled={saving}>
              {t('common.delete')}
            </button>
          </div>
        ))}
      </div>

      {builtIn ? null : (
        <button
          type="button"
          className="icon-btn project-location-add"
          onClick={handleAddFolder}
          disabled={loading || saving}
        >
          <Icon name="plus" size={14} />
          {t('settings.projectLocationsAddFolder')}
        </button>
      )}

      {pickerOpen ? (
        <div className="project-location-card" style={{
          display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16,
          background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 'var(--radius-large)', padding: 16,
          boxShadow: 'var(--shadow-sm)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <code style={{
              flex: '1 1 auto', minWidth: 0, wordBreak: 'break-all',
              fontSize: 13, color: 'var(--text-strong)', background: 'var(--bg-subtle)',
              border: '1px solid var(--border-soft)', borderRadius: 'var(--radius-sm)', padding: '6px 10px'
            }}>{pickerPath}</code>
            <button type="button" className="ghost" onClick={handlePickerUp} disabled={!pickerEntries?.parent || pickerLoading} title="Go up">
              <Icon name="arrow-up" size={14} /> Up
            </button>
            <button type="button" className="ghost" onClick={() => loadPicker(pickerPath)} disabled={pickerLoading} title="Refresh">
              <Icon name="refresh" size={14} />
            </button>
          </div>

          <div style={{
            maxHeight: 240, overflowY: 'auto',
            background: 'var(--bg)', border: '1px solid var(--border-soft)', borderRadius: 'var(--radius)', padding: 4
          }}>
            {pickerLoading ? <p className="hint" style={{ padding: '12px 8px', margin: 0 }}>Loading…</p> : null}
            {pickerError ? <p className="settings-rescan-status error" style={{ margin: '8px' }}>{pickerError}</p> : null}
            {!pickerLoading && pickerEntries ? (
              pickerEntries.entries.filter(e => e.isDirectory).length === 0 ? (
                <p className="hint" style={{ padding: '12px 8px', margin: 0 }}>No subfolders — select this folder or type a path below</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {pickerEntries.entries.filter(e => e.isDirectory).map((entry) => (
                    <li key={entry.name} style={{ padding: '2px 0' }}>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => handlePickerNavigate(entry.name)}
                        style={{
                          width: '100%', justifyContent: 'flex-start', textAlign: 'left',
                          height: 32, padding: '0 10px', borderRadius: 'var(--radius-sm)',
                          fontWeight: 400, color: 'var(--text)', gap: 8
                        }}
                      >
                        <Icon name="folder" size={14} style={{ color: 'var(--text-soft)' }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="text"
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              placeholder="/var/home/noor/dev/my-project"
              spellCheck={false}
              style={{
                flex: '1 1 auto', minWidth: 0, height: 36,
                fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 13,
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0 10px',
                color: 'var(--text-strong)'
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" className="primary" onClick={handleSelectPickerFolder} disabled={saving || !manualPath.trim()}>
              Select this folder
            </button>
            <button type="button" className="ghost" onClick={() => setPickerOpen(false)}>
              Cancel
            </button>
            <span style={{ flex: '1 1 auto' }} />
            <button type="button" className="ghost" onClick={handleSystemPicker} style={{ opacity: 0.6, fontSize: 13 }}>
              System picker
            </button>
          </div>
        </div>
      ) : null}

      {status ? <p className="settings-rescan-status">{status}</p> : null}
      {error ? <p className="settings-rescan-status error">{error}</p> : null}
    </section>
  );
}
