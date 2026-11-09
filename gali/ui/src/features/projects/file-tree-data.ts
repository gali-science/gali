import type { ProjectFileDto } from "../../api";

export type FileTreeNode = {
  id: string;
  name: string;
  path: string;
  kind?: ProjectFileDto["kind"];
  binary?: boolean;
  bytes?: number;
  children?: FileTreeNode[];
};

export function buildArboristData(files: ProjectFileDto[]): FileTreeNode[] {
  type Mutable = FileTreeNode & { children?: Mutable[] };
  const root: Mutable[] = [];
  const folders = new Map<string, Mutable>();

  function folder(path: string): Mutable {
    const existing = folders.get(path);
    if (existing) return existing;
    const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
    const node: Mutable = { id: `dir:${path}`, name, path, children: [] };
    folders.set(path, node);
    if (path.includes("/")) {
      const parentPath = path.slice(0, path.lastIndexOf("/"));
      folder(parentPath).children!.push(node);
    } else {
      root.push(node);
    }
    return node;
  }

  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  for (const file of sorted) {
    const parts = file.path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    const fileName = parts.at(-1)!;
    const parentParts = parts.slice(0, -1);
    const node: Mutable = {
      id: `file:${file.path}`,
      name: fileName,
      path: file.path,
      kind: file.kind,
      binary: file.binary,
      bytes: file.bytes,
    };
    if (parentParts.length === 0) {
      root.push(node);
      continue;
    }
    folder(parentParts.join("/")).children!.push(node);
  }

  function sortNodes(nodes: Mutable[]): void {
    nodes.sort((left, right) => {
      const leftDir = left.children !== undefined;
      const rightDir = right.children !== undefined;
      if (leftDir !== rightDir) return leftDir ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    for (const node of nodes) {
      if (node.children) sortNodes(node.children);
    }
  }

  sortNodes(root);
  return root;
}
