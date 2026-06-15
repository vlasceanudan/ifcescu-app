import { useState } from "react";

export interface TreeNode {
  expressID: number;
  type: string;
  name: string;
  ids: number[]; // renderable expressIDs in this subtree (∩ model geometry)
  children: TreeNode[];
}

const TYPE_RO: Record<string, string> = {
  IFCPROJECT: "Proiect",
  IFCSITE: "Sit",
  IFCBUILDING: "Clădire",
  IFCBUILDINGSTOREY: "Nivel",
  IFCSPACE: "Spațiu",
  IFCBUILDINGELEMENTPROXY: "Element",
};

function friendly(type: string): string {
  return (
    TYPE_RO[type] ??
    type.replace(/^IFC/, "").replace(/([a-z])([A-Z])/g, "$1 $2")
  );
}

interface Props {
  root: TreeNode;
  visibleIds: Set<number>;
  selectedIds: Set<number>;
  onSelect: (ids: number[], expressID: number) => void;
  onToggleVisible: (ids: number[], visible: boolean) => void;
}

export function IfcTree({ root, visibleIds, selectedIds, onSelect, onToggleVisible }: Props) {
  return (
    <div className="ifctree">
      <Node node={root} depth={0} {...{ visibleIds, selectedIds, onSelect, onToggleVisible }} />
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
}: { node: TreeNode; depth: number } & Omit<Props, "root">) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children.length > 0;

  const anyVisible = node.ids.some((id) => visibleIds.has(id));
  const selected = selectedIds.has(node.expressID);
  const label = node.name ? `${friendly(node.type)}: ${node.name}` : `${friendly(node.type)} #${node.expressID}`;

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
          className="tlabel"
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
