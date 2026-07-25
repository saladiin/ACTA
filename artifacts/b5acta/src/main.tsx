import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[char] ?? char,
  );
}

function isIgnorableRuntimeError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /signal is aborted|aborterror|cancelled|canceled/i.test(message);
}

function showStartupError(error: unknown): void {
  if (isIgnorableRuntimeError(error)) return;
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}${error.stack ? `\n\n${error.stack}` : ""}`
      : String(error);
  console.error("Local client runtime error", error);
  const existing = document.getElementById("local-client-runtime-error");
  const panel = existing ?? document.createElement("div");
  panel.id = "local-client-runtime-error";
  panel.innerHTML = `
    <div style="position:fixed;inset:0;z-index:2147483647;background:rgba(5,5,7,.92);color:#f8fafc;padding:24px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;overflow:auto;">
      <div style="max-width:680px;margin:10vh auto;border:1px solid rgba(248,113,113,.55);background:rgba(127,29,29,.18);padding:18px;">
        <div style="color:#fecaca;text-transform:uppercase;letter-spacing:.18em;font-weight:700;font-size:12px;">Local client runtime error</div>
        <pre style="white-space:pre-wrap;word-break:break-word;margin-top:12px;color:#fca5a5;font-size:12px;line-height:1.5;">${escapeHtml(message)}</pre>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">
          <button type="button" onclick="document.getElementById('local-client-runtime-error')?.remove()" style="border:1px solid rgba(148,163,184,.65);background:#020617;color:#e2e8f0;padding:7px 10px;font:inherit;font-size:11px;text-transform:uppercase;letter-spacing:.12em;cursor:pointer;">Dismiss</button>
          <button type="button" onclick="window.location.reload()" style="border:1px solid rgba(251,191,36,.75);background:#facc15;color:#111827;padding:7px 10px;font:inherit;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;cursor:pointer;">Reload</button>
        </div>
      </div>
    </div>
  `;
  if (!existing) document.body.appendChild(panel);
}

window.addEventListener("error", (event) => {
  if (isIgnorableRuntimeError(event.error ?? event.message)) return;
  showStartupError(event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  if (isIgnorableRuntimeError(event.reason)) return;
  showStartupError(event.reason);
});

try {
  createRoot(document.getElementById("root")!).render(<App />);
} catch (error) {
  showStartupError(error);
}
