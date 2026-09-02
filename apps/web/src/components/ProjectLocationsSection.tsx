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
        <div className="project-location-card" style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ flex: '1 1 auto', wordBreak: 'break-all' }}>{pickerPath}</strong>
            <button type="button" className="icon-btn" onClick={handlePickerUp} disabled={!pickerEntries?.parent || pickerLoading}>
              Up
            </button>
            <button type="button" className="icon-btn" onClick={() => loadPicker(pickerPath)} disabled={pickerLoading}>
              Refresh
            </button>
          </div>

          <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, padding: 8 }}>
            {pickerLoading ? <p className="hint">Loading…</p> : null}
            {pickerError ? <p className="settings-rescan-status error">{pickerError}</p> : null}
            {!pickerLoading && pickerEntries ? (
              pickerEntries.entries.length === 0 ? (
                <p className="hint">Empty folder</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {pickerEntries.entries.map((entry) => (
                    <li key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                      {entry.isDirectory ? (
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => handlePickerNavigate(entry.name)}
                          style={{ flex: '1 1 auto', justifyContent: 'flex-start', textAlign: 'left' }}
                        >
                          <Icon name="folder" size={14} />
                          {entry.name}
                        </button>
                      ) : (
                        <span style={{ flex: '1 1 auto', opacity: 0.5, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Icon name="file" size={14} />
                          {entry.name}
                        </span>
                      )}
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
              placeholder="/var/home/noor/dev/my-project-base"
              style={{ flex: '1 1 auto', minWidth: 0 }}
              className="project-location-manual-input"
            />
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="icon-btn" onClick={handleSelectPickerFolder} disabled={saving}>
              Select this folder
            </button>
            <button type="button" className="icon-btn" onClick={() => setPickerOpen(false)}>
              Cancel
            </button>
            <button type="button" className="icon-btn" onClick={handleSystemPicker} style={{ marginLeft: 'auto', opacity: 0.7 }}>
              Use system picker (zenity)
            </button>
          </div>
        </div>
      ) : null}

      {status ? <p className="settings-rescan-status">{status}</p> : null}
      {error ? <p className="settings-rescan-status error">{error}</p> : null}
    </section>
  );
}
