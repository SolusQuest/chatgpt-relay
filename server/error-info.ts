import type { Task } from "./task-store.js";

export function errorInfo(message: string, task?: Task) {
  let code = /^[a-z][a-z0-9_]+$/i.test(message) ? message.toLowerCase() : "operation_failed";
  if (/composer.*changed|composer.*edit/i.test(message)) code = "composer_changed";
  else if (/^session paused|^safety:/i.test(message)) code = "session_paused";
  else if (/user stopped/i.test(message)) code = "generation_stopped";
  const deliveryState = !task ? "unknown" : task.reply !== null || task.lateReply !== null ? "replied" :
    task.submitAcknowledgedAt !== null || task.generatingSeenAt !== null ? "acknowledged" :
    task.sendAttemptedAt !== null ? "uncertain" : "not_attempted";
  const nextAction = code === "composer_changed" || code === "composer_not_clean" ? "inspect_session_and_preserve_draft" :
    code === "page_identity_unavailable" || code === "reload_extension_and_page" ? "run_doctor" :
    code === "control_timeout" || code === "refresh_outcome_unknown" ? "inspect_session_and_operation_do_not_repeat" :
    deliveryState === "uncertain" || deliveryState === "acknowledged" ? "inspect_trace_and_recover_original_task" : "inspect_session_and_task_trace";
  return { code, message, deliveryState,
    // A failure alone never authorizes replay; active/preparing work can still race an observer.
    safeToResubmit: task?.sendAttemptedAt != null || task?.reply != null || task?.lateReply != null ? false : null,
    nextAction };
}
