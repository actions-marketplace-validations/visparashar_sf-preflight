// SPDX-License-Identifier: Apache-2.0
/**
 * The blast-radius graph: the VS Code extension's model (vscode/src/graph.ts) and renderer
 * (vscode/media/graph.js), the renderer running in its own frame (graph/index.html) as it does in
 * a VS Code webview. Clicking a node with findings lists them.
 */
import { useEffect, useMemo, useRef } from "preact/hooks";
import type { AnalysisResult } from "../../src/core/types.js";
import { type GraphNode, graphOf } from "../../vscode/src/graph.js";
import { plural } from "./lib/format.js";

export type Theme = "light" | "dark";

export function GraphFrame({
  report,
  theme,
  onNode,
}: {
  report: AnalysisResult;
  theme: Theme;
  onNode: (node: GraphNode) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const firstTheme = useRef(theme);
  const graph = useMemo(() => graphOf(report), [report]);
  const message = useMemo(
    () => ({
      type: "graph",
      // Like the extension, the frame gets no file paths.
      graph: {
        ...graph,
        nodes: graph.nodes.map(({ file: _file, line: _line, ...n }) => ({ ...n, openable: n.findings.length > 0 })),
      },
      meta: {
        summary: `${plural(Math.max(0, graph.nodes.length - 1), "component")} in the blast radius`,
        openAction: "show its findings",
      },
    }),
    [graph],
  );

  const post = (msg: unknown) => frame.current?.contentWindow?.postMessage(msg, window.location.origin);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin || ev.source !== frame.current?.contentWindow) return;
      const data = ev.data as { type?: unknown; id?: unknown };
      if (data?.type === "ready") post(message);
      else if (data?.type === "open" && typeof data.id === "string") {
        const node = graph.nodes.find((n) => n.id === data.id);
        if (node) onNode(node);
      }
    };
    window.addEventListener("message", onMessage);
    post(message);
    return () => window.removeEventListener("message", onMessage);
  }, [message, onNode]);

  useEffect(() => post({ type: "theme", theme }), [theme]);

  return (
    <div class="graph-frame">
      <iframe ref={frame} src={`graph/?theme=${firstTheme.current}`} title="Blast radius graph" />
    </div>
  );
}
