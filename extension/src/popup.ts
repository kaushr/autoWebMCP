import type { SessionStatus, TraceResponse } from "./protocol";

/** Minimal control surface: start, stop, session status, and a privacy switch. */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function render(status: SessionStatus): void {
  const recording = status.recording;
  $("state").className = `state${recording ? " recording" : ""}`;
  $("state-text").textContent = recording ? "Recording this tab" : "Idle";
  $("platform").textContent = recording
    ? `${status.application?.platform ?? "generic"} · capture active`
    : "Not recording";
  $("application").textContent = status.application?.host ?? "—";
  $("events").textContent = String(status.captureEvents);
  $("session").textContent = status.sessionId ? status.sessionId.slice(0, 14) : "—";
  ($("start") as HTMLButtonElement).disabled = recording;
  ($("stop") as HTMLButtonElement).disabled = !recording;
  ($("copy") as HTMLButtonElement).disabled = !status.hasTrace;
  ($("capture-values") as HTMLInputElement).checked = status.settings.captureValues;

  const notice = $("notice");
  if (status.lastHandoff) {
    notice.hidden = false;
    notice.className = `notice${status.lastHandoff.ok ? "" : " error"}`;
    notice.textContent = status.lastHandoff.message;
  } else {
    notice.hidden = true;
  }
}

async function send(message: unknown): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage<SessionStatus & { error?: string }>(message);
    if (response?.error) {
      const notice = $("notice");
      notice.hidden = false;
      notice.className = "notice error";
      notice.textContent = response.error;
      return;
    }
    render(response);
  } catch (error) {
    const notice = $("notice");
    notice.hidden = false;
    notice.className = "notice error";
    notice.textContent = error instanceof Error ? error.message : String(error);
  }
}

$("start").addEventListener("click", () => {
  const name = ($("recording-name") as HTMLInputElement).value;
  const description = ($("recording-description") as HTMLTextAreaElement).value;
  void send({
    type: "session:start",
    ...(name.trim() || description.trim() ? { recording: { name, description } } : {})
  });
});
$("stop").addEventListener("click", () => void send({ type: "session:stop" }));
$("capture-values").addEventListener("change", (event) =>
  void send({
    type: "session:settings",
    settings: { captureValues: (event.target as HTMLInputElement).checked }
  })
);
$("copy").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage<TraceResponse>({ type: "session:trace" });
  if (!response.trace) return;
  await navigator.clipboard.writeText(JSON.stringify(response.trace, null, 2));
  const notice = $("notice");
  notice.hidden = false;
  notice.className = "notice";
  notice.textContent = "Recording JSON copied to the clipboard.";
});

void send({ type: "session:status" });
setInterval(() => void send({ type: "session:status" }), 1_000);
