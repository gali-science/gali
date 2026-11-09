export type FileKind = "image" | "pdf" | "audio" | "video" | "text" | "binary";

const IMAGE_EXT = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const AUDIO_EXT = new Set(["aac", "aiff", "flac", "m4a", "mp3", "ogg", "wav", "wma"]);
const VIDEO_EXT = new Set(["m4v", "mov", "mp4", "webm"]);
const BINARY_EXT = new Set([
  "arrow", "feather", "h5", "hdf5", "npy", "npz", "parquet", "sqlite", "sqlite3",
  "zip", "tar", "gz", "7z", "rar", "docx", "doc", "pptx", "ppt", "xlsx", "xls",
  "key", "heic", "tif", "tiff", "avi", "mkv", "mpeg", "mpg", "wmv", "bin", "exe",
  "pt", "pth", "ckpt", "onnx", "pkl", "pickle", "joblib", "safetensors",
]);

export function fileKind(path: string): FileKind {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "pdf") return "pdf";
  if (IMAGE_EXT.has(extension)) return "image";
  if (AUDIO_EXT.has(extension)) return "audio";
  if (VIDEO_EXT.has(extension)) return "video";
  if (BINARY_EXT.has(extension)) return "binary";
  return "text";
}

export function fileName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
