import { useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeRendererProps, type TreeApi } from "react-arborist";
import { getProjectTree, type ProjectFileDto } from "../../api";
import { buildArboristData, type FileTreeNode } from "./file-tree-data";

const TREE_DEPTH = 12;

function openStateForPath(selectedPath: string | null): Record<string, boolean> {
  if (!selectedPath) return { "dir:code": true };
  const parts = selectedPath.split("/").filter(Boolean);
  const open: Record<string, boolean> = {};
  let acc = "";
  for (let index = 0; index < parts.length - 1; index++) {
    acc = acc ? `${acc}/${parts[index]}` : parts[index]!;
    open[`dir:${acc}`] = true;
  }
  return open;
}

function FileNode({ node, style, dragHandle }: NodeRendererProps<FileTreeNode>) {
  const isDir = node.data.children !== undefined;
  const icon = isDir ? (node.isOpen ? "fa-folder-open" : "fa-folder") : "fa-file-lines";
  return (
    <div
      ref={dragHandle}
      style={style}
      className={`file-tree-row${node.isSelected ? " on" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        if (isDir) node.toggle();
        else node.activate();
      }}
    >
      <span className="file-tree-chev">{isDir ? (node.isOpen ? "▾" : "▸") : ""}</span>
      <i className={`fa-solid ${icon}`} />
      <span className="file-tree-name">{node.data.name}</span>
    </div>
  );
}

export function ProjectFilesTree({
  projectKey,
  revision,
  selectedPath,
  onOpenFile,
  dense = false,
}: {
  projectKey: string;
  revision: number;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  dense?: boolean;
}) {
  const [entries, setEntries] = useState<ProjectFileDto[]>([]);
  const [error, setError] = useState("");
  const hostRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<TreeApi<FileTreeNode> | undefined>(undefined);
  const [size, setSize] = useState({ width: 240, height: 280 });

  useEffect(() => {
    let cancelled = false;
    setError("");
    void getProjectTree(projectKey, "", TREE_DEPTH)
      .then((result) => {
        if (!cancelled) setEntries(result.entries);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectKey, revision]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const rect = host.getBoundingClientRect();
      setSize({
        width: Math.max(160, Math.floor(rect.width)),
        height: Math.max(160, Math.floor(rect.height)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const data = useMemo(() => buildArboristData(entries), [entries]);
  const [initialOpenState] = useState(() => openStateForPath(selectedPath));

  // Voice opens files the user never expanded to; reveal them in place.
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree || !selectedPath) return;
    tree.openParents(`file:${selectedPath}`);
    void tree.scrollTo(`file:${selectedPath}`);
  }, [selectedPath, data]);

  return (
    <div className={`project-files-tree${dense ? " dense" : ""}`} ref={hostRef}>
      {error && <div className="form-error">{error}</div>}
      {!error && data.length === 0 && <p className="file-tree-empty">No files.</p>}
      {data.length > 0 && (
        <Tree
          key={projectKey}
          ref={treeRef}
          data={data}
          width={size.width}
          height={size.height}
          indent={dense ? 12 : 14}
          rowHeight={dense ? 34 : 32}
          openByDefault={false}
          initialOpenState={initialOpenState}
          disableDrag
          disableDrop
          selection={selectedPath ? `file:${selectedPath}` : undefined}
          onActivate={(node) => {
            if (node.data.children === undefined) onOpenFile(node.data.path);
          }}
        >
          {FileNode}
        </Tree>
      )}
    </div>
  );
}
