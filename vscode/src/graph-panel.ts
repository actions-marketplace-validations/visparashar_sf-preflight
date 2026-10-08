// SPDX-License-Identifier: Apache-2.0
/**
 * The blast-radius graph panel: a webview beside the editor showing one project's graph, updated
 * whenever that project is analyzed again. The webview gets node ids, labels and kinds, never file
 * paths; opening a node looks its file up here and only opens files inside the project.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { AnalysisResult } from "../../src/core/types.js";
import { type Graph, graphOf } from "./graph.js";

export interface GraphSource {
  dir: string;
  label: string;
  result?: AnalysisResult;
  error?: string;
  busy: boolean;
}

/** What the webview is sent: the graph without file paths, and the header text. */
export function graphMessage(src: GraphSource, multiProject: boolean) {
  const graph: Graph | undefined = src.result ? graphOf(src.result) : undefined;
  const s = src.result?.summary;
  const counts = s
    ? [
        `${s.changedComponents} changed`,
        `${Math.max(0, (graph?.nodes.length ?? 1) - 1)} in the blast radius`,
        s.findingsBySeverity.high ? `${s.findingsBySeverity.high} high` : "",
        s.findingsBySeverity.medium ? `${s.findingsBySeverity.medium} medium` : "",
        src.result?.base ? `vs ${src.result.base}` : "",
      ].filter(Boolean)
    : [];
  return {
    type: "graph" as const,
    graph: graph && {
      ...graph,
      nodes: graph.nodes.map(({ file, line: _line, ...n }) => ({ ...n, openable: Boolean(file) })),
    },
    meta: {
      title: multiProject ? `Blast radius · ${src.label}` : "Blast radius",
      risk: s?.risk,
      summary: counts.join(" · "),
      busy: src.busy,
      error: src.error,
    },
  };
}

export class GraphPanel {
  private static current: GraphPanel | undefined;
  private graph: Graph | undefined;
  private ready = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private source: () => GraphSource | undefined,
    private readonly multiProject: () => boolean,
    private readonly onReport: (dir: string) => void,
  ) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => {
      if (GraphPanel.current === this) GraphPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((msg: unknown) => void this.receive(msg));
  }

  /** Open the panel for a project, or point the open one at it. */
  static show(
    extensionUri: vscode.Uri,
    source: () => GraphSource | undefined,
    multiProject: () => boolean,
    onReport: (dir: string) => void,
  ): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.source = source;
      GraphPanel.current.panel.reveal(undefined, true);
      GraphPanel.current.update();
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      "sfPreflight.graph",
      "Blast radius graph",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "activity.svg");
    GraphPanel.current = new GraphPanel(panel, extensionUri, source, multiProject, onReport);
    return GraphPanel.current;
  }

  /** Re-send the graph, when the panel is open (after each analysis). */
  static refresh(): void {
    GraphPanel.current?.update();
  }

  /** The project shown, if the panel is open. */
  static shownDir(): string | undefined {
    return GraphPanel.current?.source()?.dir;
  }

  update(): void {
    const src = this.source();
    if (!src || !this.ready) return;
    const msg = graphMessage(src, this.multiProject());
    this.graph = src.result ? graphOf(src.result) : undefined;
    void this.panel.webview.postMessage(msg);
  }

  private async receive(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const { type, id } = msg as { type?: unknown; id?: unknown };
    if (type === "ready") {
      this.ready = true;
      this.update();
    } else if (type === "report") {
      const src = this.source();
      if (src) this.onReport(src.dir);
    } else if (type === "open" && typeof id === "string") {
      const src = this.source();
      const node = this.graph?.nodes.find((n) => n.id === id);
      if (!src || !node?.file) return;
      const rel = path.relative(src.dir, node.file);
      if (rel.startsWith("..") || path.isAbsolute(rel) || !existsSync(node.file)) return;
      const line = node.line ?? 0;
      await vscode.window.showTextDocument(vscode.Uri.file(node.file), {
        viewColumn: vscode.ViewColumn.One,
        selection: new vscode.Range(line, 0, line, 0),
        preview: true,
      });
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f));
    const nonce = randomBytes(16).toString("base64");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media("graph.css")}">
<title>Blast radius graph</title>
</head>
<body>
<header>
  <h1 id="title">Blast radius</h1>
  <span id="risk" class="risk" hidden></span>
  <span id="summary" class="summary"></span>
  <span id="omitted" class="summary" hidden></span>
  <span class="spacer"></span>
  <button id="fit" type="button" title="Fit the graph to the panel (or double-click the background)">Fit</button>
  <button id="report" type="button" title="The full Markdown report">Report</button>
</header>
<svg id="graph" role="group" aria-label="Blast radius graph">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z"></path>
    </marker>
  </defs>
  <g id="viewport"></g>
</svg>
<div id="empty" class="empty" hidden></div>
<div id="tip" class="tip" hidden></div>
<div class="hint">Drag to pan · scroll to zoom · click a node to open it</div>
<div class="legend" aria-label="Legend">
  <span class="changed">changed</span><span>impacted</span><span class="medium">collision</span><span class="high">high risk</span><span class="recursion">recursion</span>
</div>
<script nonce="${nonce}" src="${media("graph.js")}"></script>
</body>
</html>`;
  }
}
