export type FileNode = {
  name: string;   // filename segment only, e.g. "intro.tex"
  path: string;   // full path, e.g. "chapters/intro.tex"
  kind: "file";
};

export type FolderNode = {
  name: string;   // folder segment, e.g. "chapters"
  path: string;   // full folder path with trailing slash, e.g. "chapters/"
  kind: "folder";
  children: TreeNode[];
};

export type TreeNode = FileNode | FolderNode;

export function build_tree(file_names: string[]): TreeNode[] {
  const folder_map = new Map<string, FolderNode>();
  const root_nodes: TreeNode[] = [];

  function ensure_folder(folder_path: string): FolderNode {
    if (folder_map.has(folder_path)) return folder_map.get(folder_path)!;
    const segments = folder_path.replace(/\/$/, "").split("/");
    const name = segments[segments.length - 1];
    const node: FolderNode = { name, path: folder_path, kind: "folder", children: [] };
    folder_map.set(folder_path, node);

    if (segments.length > 1) {
      const parent_path = segments.slice(0, -1).join("/") + "/";
      ensure_folder(parent_path).children.push(node);
    } else {
      root_nodes.push(node);
    }
    return node;
  }

  for (const file of file_names) {
    const is_gitkeep = file.endsWith(".gitkeep");
    const slash = file.lastIndexOf("/");
    if (slash === -1) {
      // root-level file — skip .gitkeep
      if (!is_gitkeep) root_nodes.push({ name: file, path: file, kind: "file" });
    } else {
      const folder_path = file.slice(0, slash + 1);
      const name = file.slice(slash + 1);
      const folder = ensure_folder(folder_path); // always create the folder
      if (!is_gitkeep) folder.children.push({ name, path: file, kind: "file" });
    }
  }

  function sort_nodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.kind === "folder") sort_nodes(n.children);
    }
  }
  sort_nodes(root_nodes);

  return root_nodes;
}

export function collect_folder_paths(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  function walk(ns: TreeNode[]) {
    for (const n of ns) {
      if (n.kind === "folder") {
        paths.push(n.path);
        walk(n.children);
      }
    }
  }
  walk(nodes);
  return paths;
}

export function auto_suffix(name: string, existing: string[]): string {
  if (!existing.includes(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  let i = 1;
  while (existing.includes(`${base}_${i}${ext}`)) i++;
  return `${base}_${i}${ext}`;
}
