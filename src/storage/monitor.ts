import {
  getStorageReport,
  type StorageReport,
  type StorageReportRoots,
  type StoragePolicy
} from "./manager.js";
import { purgeDeletedProjects } from "../projects/store.js";
import type { StorageScope } from "./manager.js";

export interface StorageMonitorOptions {
  policy: StoragePolicy;
  collectScopes: () => Promise<StorageScope[]>;
  roots?: StorageReportRoots;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface StorageMonitor {
  runNow(): Promise<StorageReport | undefined>;
  stop(): void;
}

/**
 * Run retention cleanup before each report, then emit warnings only when a
 * scope or the global store crosses its configured threshold. The timer is
 * unref'ed so a test process or graceful shutdown is never kept alive by the
 * monitor.
 */
export function startStorageMonitor(options: StorageMonitorOptions): StorageMonitor {
  const logger = options.logger ?? console;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;

  const runNow = async (): Promise<StorageReport | undefined> => {
    if (stopped || running) return undefined;
    running = true;
    try {
      let scopes = await options.collectScopes();
      let purgedCount = 0;
      let reclaimedBytes = 0;
      for (const scope of scopes) {
        const purged = await purgeDeletedProjects(scope.projectRoot, {
          retentionDays: options.policy.deletedProjectRetentionDays,
          workspaceRoot: scope.workspaceRoot,
          artifactRoot: options.roots?.artifactRoot,
          shareRoot: options.roots?.shareRoot
        });
        purgedCount += purged.length;
        reclaimedBytes += purged.reduce((sum, item) => sum + item.projectBytes + item.workspaceBytes + item.artifactBytes + item.shareBytes, 0);
      }
      if (purgedCount > 0) {
        logger.info(`[storage] purged ${purgedCount} expired project(s), reclaimed ${reclaimedBytes} bytes.`);
        scopes = await options.collectScopes();
      }

      const report = await getStorageReport(scopes, options.policy, options.roots);
      for (const warning of report.warnings) logger.warn(`[storage] ${warning}`);
      return report;
    } catch (error) {
      logger.error("[storage] maintenance scan failed:", error);
      return undefined;
    } finally {
      running = false;
    }
  };

  if (options.policy.monitorIntervalMs > 0) {
    timer = setInterval(() => {
      void runNow();
    }, options.policy.monitorIntervalMs);
    timer.unref?.();
    void runNow();
  }

  return {
    runNow,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    }
  };
}
