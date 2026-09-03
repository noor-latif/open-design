import { useCallback, useRef, useState } from 'react';
import {
  isOpenDesignHostAvailable,
  pickAndImportHostProject,
  type OpenDesignHostProjectImportSuccess,
} from '@open-design/host';
import { pickLocalFolderPath } from '../state/projects';
import { resolvedWorkspaceContextForWrite } from '../state/projects';
import { useWorkspaceContext } from '../collab/useWorkspaceContext';
import { formatPickAndImportFailure } from '../utils/pickAndImportError';

interface UseOpenFolderImportArgs {
  skillId?: string | null;
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  onImportFolderResponse?: (response: OpenDesignHostProjectImportSuccess) => Promise<void> | void;
}

export function useOpenFolderImport({
  skillId,
  onImportFolder,
  onImportFolderResponse,
}: UseOpenFolderImportArgs) {
  const workspaceContextState = useWorkspaceContext();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<{ message: string; details?: string } | null>(null);
  const hasHostPickAndImport = isOpenDesignHostAvailable();
  const available = hasHostPickAndImport ? Boolean(onImportFolderResponse) : Boolean(onImportFolder);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerInitialPath, setPickerInitialPath] = useState('/var/home/noor/dev');
  const pickerResolverRef = useRef<((v: string | null) => void) | null>(null);

  const openFolder = useCallback(async () => {
    if (hasHostPickAndImport) {
      if (!onImportFolderResponse) return;
      setError(null);
      setImporting(true);
      try {
        const result = await pickAndImportHostProject({
          skillId: skillId ?? null,
          workspaceContext: resolvedWorkspaceContextForWrite(workspaceContextState),
        });
        if (!result) return;
        if (result.ok === true) {
          await onImportFolderResponse(result);
          return;
        }
        if ('canceled' in result && result.canceled === true) return;
        setError(formatPickAndImportFailure(result));
      } catch (err) {
        setError({
          message: err instanceof Error ? err.message : 'Failed to import folder',
        });
      } finally {
        setImporting(false);
      }
      return;
    }

    if (!onImportFolder) return;
    setError(null);
    setImporting(true);
    try {
      let selectedPath: string | null = null;
      try {
        selectedPath = await pickLocalFolderPath();
      } catch (dialogErr) {
        // Container/server has no zenity/display -> native dialog 500s.
        // Fall back to a web-native ServerFolderPickerDialog (nice UI) so
        // Import folder still works on https://… (Tailscale Funnel) and
        // headless Docker — no ugly window.prompt.
        const msg = dialogErr instanceof Error ? dialogErr.message : String(dialogErr);
        const isDialogUnavailable = /Could not open folder picker|zenity|display|cannot open/i.test(msg);
        if (!isDialogUnavailable) throw dialogErr;
        // Open the server-browsing dialog and wait for the user's pick
        const picked = await new Promise<string | null>((resolve) => {
          pickerResolverRef.current = resolve;
          setPickerInitialPath('/var/home/noor/dev');
          setPickerOpen(true);
        });
        if (picked == null) return;
        const trimmed = picked.trim();
        if (!trimmed) return;
        selectedPath = trimmed;
      }
      if (!selectedPath) return;
      await onImportFolder(selectedPath);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'Failed to import folder',
      });
    } finally {
      setImporting(false);
    }
  }, [
    hasHostPickAndImport,
    onImportFolder,
    onImportFolderResponse,
    skillId,
    workspaceContextState,
  ]);

  const closePicker = useCallback((value: string | null) => {
    setPickerOpen(false);
    const r = pickerResolverRef.current;
    pickerResolverRef.current = null;
    if (r) r(value);
  }, []);

  return {
    available,
    clearError: () => setError(null),
    error,
    importing,
    openFolder,
    // Web-native server folder picker fallback (no zenity/DISPLAY)
    pickerOpen,
    pickerInitialPath,
    onPickerPick: useCallback((p: string) => closePicker(p), [closePicker]),
    onPickerCancel: useCallback(() => closePicker(null), [closePicker]),
  };
}
