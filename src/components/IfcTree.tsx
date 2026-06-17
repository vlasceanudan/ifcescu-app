import { useState } from "react";
import { IFC_ENTITY_NAMES } from "@ifc-lite/data";

export interface TreeNode {
  expressID: number;
  type: string;
  name: string;
  ids: number[]; // renderable expressIDs in this subtree (∩ model geometry)
  children: TreeNode[];
  count?: number; // when set, this is a synthetic "class group" node of `count` elements
  defaultOpen?: boolean; // overrides the depth-based default expansion
}

// Canonical IFC class name in PascalCase ("IFCWALL" → "IfcWall"). The
// IFC_ENTITY_NAMES map (IFC4X3 schema) is the only source that recovers word
// boundaries for multi-word classes (IFCWALLSTANDARDCASE → IfcWallStandardCase).
// No Romanian translations — classes are shown exactly as their IFC type.
export function friendly(type: string): string {
  if (!type) return "";
  const hit = IFC_ENTITY_NAMES[type.toUpperCase()];
  if (hit) return hit;
  const rest = type.replace(/^IFC/i, "");
  return "Ifc" + rest.charAt(0).toUpperCase() + rest.slice(1).toLowerCase();
}

interface Props {
  /** Top-level nodes. Spatial view passes a single project node; Class/Material
   * views pass the group nodes directly (no IfcProject wrapper). */
  roots: TreeNode[];
  visibleIds: Set<number>;
  selectedIds: Set<number>;
  onSelect: (ids: number[], expressID: number) => void;
  onToggleVisible: (ids: number[], visible: boolean) => void;
}

export function IfcTree({ roots, visibleIds, selectedIds, onSelect, onToggleVisible }: Props) {
  return (
    <div className="ifctree">
      {roots.map((node) => (
        <Node key={node.expressID} node={node} depth={0} {...{ visibleIds, selectedIds, onSelect, onToggleVisible }} />
      ))}
    </div>
  );
}

function Node({
  node,
  depth,
  visibleIds,
  selectedIds,
  onSelect,
  onToggleVisible,
}: { node: TreeNode; depth: number } & Omit<Props, "roots">) {
  const [open, setOpen] = useState(node.defaultOpen ?? depth < 2);
  const hasChildren = node.children.length > 0;

  const anyVisible = node.ids.some((id) => visibleIds.has(id));
  const selected = selectedIds.has(node.expressID);
  // Label rules:
  // - group rows (count != null): own name ("Concrete") or class ("IfcWall"), + count
  // - leaf rows (no children = last hierarchy level): NAME ONLY (no class prefix),
  //   falling back to "IfcWall #1234" only when the element is unnamed
  // - branch containers (have children): "IfcSite: SP4" so the class stays visible
  const groupLabel = node.name ? node.name : friendly(node.type);
  const label =
    node.count != null
      ? `${groupLabel} (${node.count})`
      : !hasChildren
        ? node.name || `${friendly(node.type)} #${node.expressID}`
        : node.name
          ? `${friendly(node.type)}: ${node.name}`
          : `${friendly(node.type)} #${node.expressID}`;

  return (
    <div className="tnode">
      <div
        className={"trow" + (selected ? " selected" : "")}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        <span
          className="tcaret"
          onClick={() => hasChildren && setOpen((o) => !o)}
          style={{ visibility: hasChildren ? "visible" : "hidden" }}
        >
          {open ? "▾" : "▸"}
        </span>
        <span
          className="teye"
          title={anyVisible ? "Ascunde" : "Afișează"}
          onClick={(e) => {
            e.stopPropagation();
            if (node.ids.length) onToggleVisible(node.ids, !anyVisible);
          }}
          style={{ opacity: node.ids.length ? 1 : 0.25 }}
        >
          {anyVisible ? "👁" : "🚫"}
        </span>
        <span
          className={"tlabel" + (hasChildren ? " tbranch" : "")}
          title={label}
          onClick={() => node.ids.length && onSelect(node.ids, node.expressID)}
        >
          {label}
        </span>
      </div>
      {open &&
        node.children.map((c) => (
          <Node
            key={c.expressID}
            node={c}
            depth={depth + 1}
            visibleIds={visibleIds}
            selectedIds={selectedIds}
            onSelect={onSelect}
            onToggleVisible={onToggleVisible}
          />
        ))}
    </div>
  );
}
