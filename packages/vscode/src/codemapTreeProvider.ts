import * as vscode from "vscode";
import type { Codemap, Location, Trace } from "./engineClient.js";

type Node = CodemapNode | TraceNode | LocationNode;

export interface CodemapNode {
  kind: "codemap";
  codemap: Codemap;
}
export interface TraceNode {
  kind: "trace";
  codemap: Codemap;
  trace: Trace;
}
export interface LocationNode {
  kind: "location";
  codemap: Codemap;
  location: Location;
  label: string;
}

/** Sidebar tree: codemaps → traces (tree) → locations. */
export class CodemapTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private codemaps: Codemap[] = [];

  setCodemaps(codemaps: Codemap[]): void {
    this.codemaps = codemaps;
    this._onDidChange.fire();
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "codemap") {
      const item = new vscode.TreeItem(node.codemap.query, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${node.codemap.model.backend} · ${node.codemap.model.model_name}`;
      item.tooltip = `${node.codemap.id}\n${node.codemap.created_at}`;
      item.iconPath = new vscode.ThemeIcon("git-branch");
      item.contextValue = "codemap";
      item.id = node.codemap.id;
      item.command = {
        command: "roots.openCodemap",
        title: "Open Codemap",
        arguments: [node],
      };
      return item;
    }
    if (node.kind === "trace") {
      const hasChildren = (node.trace.children?.length ?? 0) > 0 || node.trace.locations.length > 0;
      const item = new vscode.TreeItem(
        node.trace.title,
        hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
      );
      item.description = node.trace.summary;
      item.tooltip = node.trace.summary;
      item.iconPath = new vscode.ThemeIcon("circle-small-filled");
      item.contextValue = "trace";
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("file-code");
    item.contextValue = "location";
    item.command = {
      command: "roots.openLocation",
      title: "Open Location",
      arguments: [node.codemap.repo.root, node.location],
    };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.codemaps.map((codemap) => ({ kind: "codemap", codemap }));
    }
    if (node.kind === "codemap") {
      const roots = rootTraces(node.codemap);
      return roots.map((trace) => ({ kind: "trace", codemap: node.codemap, trace }));
    }
    if (node.kind === "trace") {
      const children: Node[] = [];
      for (const loc of node.trace.locations) {
        children.push({
          kind: "location",
          codemap: node.codemap,
          location: loc,
          label: `${loc.file}:${loc.start_line}-${loc.end_line}`,
        });
      }
      const byId = new Map(node.codemap.traces.map((t) => [t.id, t]));
      for (const childId of node.trace.children ?? []) {
        const child = byId.get(childId);
        if (child) children.push({ kind: "trace", codemap: node.codemap, trace: child });
      }
      return children;
    }
    return [];
  }
}

/** Root traces are those not referenced as a child of any other trace. */
function rootTraces(codemap: Codemap): Trace[] {
  const referenced = new Set<string>();
  for (const t of codemap.traces) {
    for (const c of t.children ?? []) referenced.add(c);
  }
  return codemap.traces.filter((t) => !referenced.has(t.id));
}
