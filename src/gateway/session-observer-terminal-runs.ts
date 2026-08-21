import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  isDefinitiveRunLifecycle,
} from "../agents/agent-run-terminal-outcome.js";
import type { SessionObserverEvent } from "./session-observer-contract.js";
import { markSessionObserverRunSuperseded } from "./session-observer-model.js";

type SessionObserverTerminalRunTrackerDeps = {
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  onRetryableError: (event: SessionObserverEvent) => void;
};

export function createSessionObserverTerminalRunTracker(
  deps: SessionObserverTerminalRunTrackerDeps,
) {
  const terminalRuns = new Map<string, number>();
  const provisionalTerminalRuns = new Map<string, number>();
  const pendingTerminalErrors = new Map<string, ReturnType<typeof setTimeout>>();

  const clearPendingTerminalError = (runId: string) => {
    deps.clearTimeoutFn(pendingTerminalErrors.get(runId));
    pendingTerminalErrors.delete(runId);
  };
  const markTerminalRun = (event: SessionObserverEvent, provisional: boolean) => {
    if (!provisional) {
      provisionalTerminalRuns.delete(event.runId);
    }
    markSessionObserverRunSuperseded(
      provisional ? provisionalTerminalRuns : terminalRuns,
      event.runId,
      event.ts,
    );
  };

  const inspect = (event: SessionObserverEvent, settledError = false) => {
    const lifecyclePhase = event.stream === "lifecycle" ? event.data.phase : undefined;
    const provisionalTerminal = settledError && lifecyclePhase === "error";
    const lateRecovery = provisionalTerminalRuns.has(event.runId) && lifecyclePhase === "end";
    const terminal =
      settledError || isDefinitiveRunLifecycle({ phase: lifecyclePhase, data: event.data });
    if (lifecyclePhase === "error" && !terminal) {
      provisionalTerminalRuns.delete(event.runId);
      clearPendingTerminalError(event.runId);
      const timer = deps.setTimeoutFn(
        () => deps.onRetryableError(event),
        AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
      );
      pendingTerminalErrors.set(event.runId, timer);
      return undefined;
    }
    if ((terminal && !provisionalTerminal) || lifecyclePhase === "start") {
      clearPendingTerminalError(event.runId);
    }
    if (lifecyclePhase === "start") {
      provisionalTerminalRuns.delete(event.runId);
    }
    if (terminalRuns.has(event.runId) && !lateRecovery) {
      return undefined;
    }
    return { terminal, provisionalTerminal, lateRecovery };
  };

  return {
    inspect,
    clearPendingTerminalError,
    markTerminalRun,
    dispose() {
      pendingTerminalErrors.forEach((_timer, runId) => clearPendingTerminalError(runId));
      terminalRuns.clear();
      provisionalTerminalRuns.clear();
    },
  };
}
