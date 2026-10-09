// SPDX-License-Identifier: Apache-2.0
// Runs the VS Code extension's graph renderer (graph.js) in a page of the report viewer: it stands
// in for the webview API, so the renderer's messages go to the viewer, and applies the viewer's theme.
(() => {
  const setTheme = (theme) => {
    document.body.classList.toggle("vscode-light", theme === "light");
    document.body.classList.toggle("vscode-dark", theme !== "light");
  };
  setTheme(new URLSearchParams(window.location.search).get("theme"));
  window.addEventListener("message", (ev) => {
    if (ev.origin !== window.location.origin || ev.source !== window.parent) return;
    if (ev.data?.type === "theme") setTheme(ev.data.theme);
  });
  window.acquireVsCodeApi = () => ({
    postMessage: (msg) => window.parent.postMessage(msg, window.location.origin),
  });
})();
