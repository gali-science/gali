const EXTENSION_LANG: Record<string, string> = {
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".css": "css",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".jsonl": "json",
  ".md": "markdown",
  ".mjs": "javascript",
  ".py": "python",
  ".r": "r",
  ".rb": "ruby",
  ".rs": "rust",
  ".sh": "bash",
  ".sql": "sql",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".txt": "plaintext",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
};

export function languageFromPath(filePath: string): string {
  const base = filePath.includes("/") ? filePath.slice(filePath.lastIndexOf("/") + 1) : filePath;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const extension = base.slice(dot).toLowerCase();
  return EXTENSION_LANG[extension] ?? "plaintext";
}
