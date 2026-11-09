import type { PdfAnnotationExportFormat } from "../../shared/domain/contracts";
import { GALI_HTTP_BASE } from "./http-bridge";
import { getPlatform } from "./platform/runtime";

/** Whether this platform can save files from Gali's HTTP routes to the user's device. */
export function canDownload(): boolean {
  return getPlatform().capabilities.downloadFiles;
}

// The route's Content-Disposition names the file; the empty attribute just marks the link a download.
function download(href: string): boolean {
  if (!canDownload()) return false;
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = "";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
}

export function downloadPdfAnnotations(projectKey: string, format: PdfAnnotationExportFormat): boolean {
  const query = new URLSearchParams({ format });
  return download(`${GALI_HTTP_BASE}/projects/${encodeURIComponent(projectKey)}/pdf-annotations/export?${query}`);
}