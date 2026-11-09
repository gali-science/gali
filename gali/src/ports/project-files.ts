export type ProjectFile = {
  path: string;
  kind: "text" | "audio" | "image" | "video" | "pdf" | "data" | "binary";
  binary: boolean;
  bytes: number;
};

export type ProjectMedia = {
  path: string;
  kind: "audio" | "image" | "video" | "pdf";
  mime: string;
  data: Buffer;
};

export type ProjectFiles = {
  tree(root: string, relativePath: string, depth: number): Promise<ProjectFile[]>;
  readText(
    root: string,
    relativePath: string,
    offset?: number,
  ): Promise<{ file: ProjectFile; content: string; truncated?: boolean; nextOffset?: number }>;
  readMedia(root: string, relativePath: string): Promise<ProjectMedia>;
  searchText(
    root: string,
    relativePath: string,
    query: string,
    depth: number,
    limit: number,
  ): Promise<Array<{ path: string; line: number; text: string }>>;
};
