import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

function showStartupError(error: unknown): void {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = `
    <div style="min-height:100dvh;background:#050507;color:#f8fafc;padding:24px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">
      <div style="max-width:680px;margin:10vh auto;border:1px solid rgba(248,113,113,.55);background:rgba(127,29,29,.18);padding:18px;">
        <div style="color:#fecaca;text-transform:uppercase;letter-spacing:.18em;font-weight:700;font-size:12px;">Local client startup error</div>
        <pre style="white-space:pre-wrap;word-break:break-word;margin-top:12px;color:#fca5a5;font-size:12px;line-height:1.5;">${message.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char] ?? char)}</pre>
      </div>
    </div>
  `;
}

window.addEventListener("error", (event) => {
  showStartupError(event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  showStartupError(event.reason);
});

try {
  createRoot(document.getElementById("root")!).render(<App />);
} catch (error) {
  showStartupError(error);
}
