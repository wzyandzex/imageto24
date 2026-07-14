import { useCallback, useEffect, useState } from "react";
import { browserCloudTemporalJobClient } from "@/pipeline/browser/cloudTemporalClient";
import { recoveryFromHash } from "@/lib/cloudJobHelpers";
import {
  isTerminalCloudTemporalStatus,
  type CloudTemporalJob,
  type CloudTemporalJobResult,
  type CloudTemporalRecoveryIdentity,
} from "@/pipeline";
import type { Status } from "@/appTypes";

/**
 * Owns cloud temporal job lifecycle for the single-image UI:
 * recovery-from-hash, polling, result download URLs, and immediate deletion.
 *
 * Status/error are lifted so the shared run trigger can stay the single source
 * of truth for local vs cloud processing state.
 */
export function useCloudJob(setStatus: (status: Status) => void, setError: (error: string | null) => void) {
  const [cloudJob, setCloudJob] = useState<CloudTemporalJob | null>(null);
  const [cloudResult, setCloudResult] = useState<CloudTemporalJobResult | null>(null);
  const [cloudResultUrl, setCloudResultUrl] = useState<string | null>(null);
  const [cloudRecoveryError, setCloudRecoveryError] = useState<string | null>(null);
  const [cloudDeletePending, setCloudDeletePending] = useState(false);

  const setCloudResultDownload = useCallback((next: CloudTemporalJobResult | null) => {
    setCloudResult(next);
    setCloudResultUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      if (!next) return null;
      return URL.createObjectURL(new Blob([next.buffer], { type: next.mimeType }));
    });
  }, []);

  const clearCloudJob = useCallback(() => {
    setCloudJob(null);
    setCloudDeletePending(false);
    setCloudResultDownload(null);
    setCloudRecoveryError(null);
  }, [setCloudResultDownload]);

  const refreshCloudJob = useCallback(async (recovery: CloudTemporalRecoveryIdentity) => {
    setCloudRecoveryError(null);
    const nextJob = await browserCloudTemporalJobClient.getJob(recovery);
    setCloudJob(nextJob);
    if (nextJob.status === "ready") {
      setCloudResultDownload(null);
      const nextResult = await browserCloudTemporalJobClient.getResult(nextJob.recovery);
      setCloudResultDownload(nextResult);
    } else {
      setCloudResultDownload(null);
    }
    if (nextJob.status === "failed") {
      setError(nextJob.failure?.message ?? "Cloud temporal enhancement failed.");
      setStatus("error");
    } else if (nextJob.status === "ready" || nextJob.status === "expired" || nextJob.status === "deleted") {
      setError(null);
      setStatus("done");
    } else {
      setError(null);
      setStatus("processing");
    }
    return nextJob;
  }, [setCloudResultDownload, setError, setStatus]);

  const deleteCloudJob = useCallback(async () => {
    if (!cloudJob || cloudDeletePending || cloudJob.status === "deleted" || cloudJob.status === "expired") return;
    setCloudDeletePending(true);
    setCloudRecoveryError(null);
    try {
      const deleted = await browserCloudTemporalJobClient.deleteJob(cloudJob.recovery);
      setCloudJob(deleted);
      setCloudResultDownload(null);
      setStatus("done");
      setError(null);
      if (window.location.hash.includes("cloud-job=")) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    } catch (err) {
      setCloudRecoveryError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    } finally {
      setCloudDeletePending(false);
    }
  }, [cloudJob, cloudDeletePending, setCloudResultDownload, setError, setStatus]);

  useEffect(() => {
    const recovery = recoveryFromHash(window.location.hash);
    if (!recovery) return;
    void refreshCloudJob(recovery).catch((err) => {
      setCloudRecoveryError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    });
  }, [refreshCloudJob, setStatus]);

  useEffect(() => {
    if (!cloudJob || isTerminalCloudTemporalStatus(cloudJob.status)) return;
    const id = window.setInterval(() => {
      void refreshCloudJob(cloudJob.recovery).catch((err) => {
        setCloudRecoveryError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    }, 2_000);
    return () => window.clearInterval(id);
  }, [cloudJob, refreshCloudJob, setStatus]);

  useEffect(() => {
    return () => {
      if (cloudResultUrl) URL.revokeObjectURL(cloudResultUrl);
    };
  }, [cloudResultUrl]);

  return {
    cloudJob,
    setCloudJob,
    cloudResult,
    cloudResultUrl,
    cloudRecoveryError,
    cloudDeletePending,
    setCloudResultDownload,
    clearCloudJob,
    refreshCloudJob,
    deleteCloudJob,
  };
}
