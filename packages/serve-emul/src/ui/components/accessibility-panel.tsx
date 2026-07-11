import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AccessibilityNode,
  AccessibilitySelector,
} from "../../shared/api-contracts";
import { apiRequest } from "../lib/api-client";

export type { AccessibilityNode } from "../../shared/api-contracts";

type Props = {
  enabled: boolean;
  nodes: AccessibilityNode[];
  highlightedId: string | null;
  onEnabledChange: (enabled: boolean) => void;
  onNodesChange: (nodes: AccessibilityNode[]) => void;
  onHighlight: (id: string | null) => void;
};

function nodeLabel(node: AccessibilityNode): string {
  return node.text || node.contentDescription || node.resourceId || node.className || "Unlabeled";
}

function nodeMeta(node: AccessibilityNode): string {
  const role = node.className.split(".").pop() || "node";
  const width = node.bounds.right - node.bounds.left;
  const height = node.bounds.bottom - node.bounds.top;
  return `${role} · ${width}x${height}`;
}

function preferredSelectorForNode(node: AccessibilityNode): AccessibilitySelector {
  if (node.resourceId) return { resourceId: node.resourceId };
  if (node.contentDescription) return { contentDescription: node.contentDescription };
  if (node.text) return { text: node.text };
  if (node.className || node.packageName) {
    return {
      className: node.className || undefined,
      packageName: node.packageName || undefined,
      clickable: node.clickable,
      enabled: node.enabled,
    };
  }
  return { id: node.id };
}

function nodesMatchingSelector(
  nodes: AccessibilityNode[],
  selector: AccessibilitySelector,
): AccessibilityNode[] {
  return nodes.filter((candidate) =>
    Object.entries(selector).every(([key, value]) => {
      if (key === "index" || value === undefined) return true;
      return candidate[key as keyof AccessibilityNode] === value;
    })
  );
}

function selectorForNode(node: AccessibilityNode, nodes: AccessibilityNode[]): AccessibilitySelector {
  const selector = preferredSelectorForNode(node);
  const matches = nodesMatchingSelector(nodes, selector);
  if (matches.length > 1) selector.index = matches.indexOf(node);
  return selector;
}

export function AccessibilityPanel({
  enabled,
  nodes,
  highlightedId,
  onEnabledChange,
  onNodesChange,
  onHighlight,
}: Props) {
  const [status, setStatus] = useState("AX off");
  const refreshInFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setStatus("Reading...");
    try {
      const json = await apiRequest("/api/accessibility", { method: "GET", cache: "no-store" });
      onNodesChange(json.nodes);
      setStatus(`${json.nodes.length} nodes`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [enabled, onNodesChange]);

  useEffect(() => {
    if (!enabled) {
      onNodesChange([]);
      onHighlight(null);
      setStatus("AX off");
      return;
    }
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [enabled, refresh, onHighlight, onNodesChange]);

  const tapNode = async (node: AccessibilityNode) => {
    setStatus("Tapping...");
    try {
      await apiRequest("/api/accessibility/tap", {
        method: "POST",
        body: { selector: selectorForNode(node, nodes) },
      });
      setStatus("Tapped");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="tool-panel accessibility-panel">
      <div className="panel-heading">
        <h2>Accessibility</h2>
        <div className="location-status">{status}</div>
      </div>
      <div className="panel-actions ax-actions">
        <button onClick={() => onEnabledChange(!enabled)}>{enabled ? "Hide" : "Show"}</button>
        <button onClick={() => void refresh()} disabled={!enabled}>
          Refresh
        </button>
      </div>
      {enabled && (
        <div className="ax-list" role="list">
          {nodes.length === 0 ? (
            <div className="ax-empty">No accessibility nodes yet.</div>
          ) : (
            nodes.map((node) => (
              <button
                key={node.id}
                type="button"
                className={node.id === highlightedId ? "ax-node active" : "ax-node"}
                onMouseEnter={() => onHighlight(node.id)}
                onMouseLeave={() => onHighlight(null)}
                onFocus={() => onHighlight(node.id)}
                onBlur={() => onHighlight(null)}
                onClick={() => void tapNode(node)}
                title={node.resourceId || node.packageName}
              >
                <span>{nodeLabel(node)}</span>
                <code>{nodeMeta(node)}</code>
              </button>
            ))
          )}
        </div>
      )}
    </section>
  );
}
