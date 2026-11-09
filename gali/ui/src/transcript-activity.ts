import type { VoiceLine } from "./useVoice";

export type ActivityIcon =
  | "project"
  | "file"
  | "page"
  | "lookup"
  | "reviewer"
  | "delete"
  | "status";

export type ActivityState = "running" | "done" | "failed";

export type ActivityItem = {
  kind: "activity";
  id: number;
  icon: ActivityIcon;
  label: string;
  detail?: string;
  page?: number;
  state?: ActivityState;
};

export type TranscriptItem =
  | { kind: "message"; id: number; role: "user" | "assistant"; text: string }
  | ActivityItem;

type Activity = Omit<ActivityItem, "kind" | "id">;
type Row = Record<string, unknown>;

function record(value: unknown): Row {
  return typeof value === "object" && value !== null ? (value as Row) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function whole(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function lookupLabel(summary: string, state: ActivityState): string {
  const what = summary || "your question";
  if (state === "running") return `Looking up: ${what}`;
  if (state === "failed") return `Lookup failed: ${what}`;
  return `Looked up: ${what}`;
}

function toolActivity(
  name: string,
  args: Row,
  result: Row,
): Activity | null {
  if (result.error !== undefined) {
    return name === "quick_answer"
      ? { icon: "lookup", label: lookupLabel(text(args.question), "failed"), state: "failed" }
      : null;
  }
  switch (name) {
    case "open_project": {
      const title = text(record(result.project).title);
      return result.opened === true && title ? { icon: "project", label: `Opened ${title}` } : null;
    }
    case "open_paper": {
      if (result.opened !== true) return null;
      const page = whole(result.page);
      return { icon: "file", label: "Opened the PDF", ...(page === null ? {} : { page }) };
    }
    case "open_code_file": {
      const path = text(result.path);
      return result.opened === true && path ? { icon: "file", label: `Opened ${basename(path)}`, detail: path } : null;
    }
    case "set_viewer_page": {
      if (result.turned !== true) return null;
      const page = whole(result.page);
      if (page !== null) return { icon: "page", label: `Turned to page ${page}`, page };
      return {
        icon: "page",
        label: result.direction === "prev" ? "Turned to the previous page" : "Turned to the next page",
      };
    }
    case "highlight_pdf_text":
    case "add_pdf_note":
    case "go_to_pdf_note":
    case "remove_pdf_note": {
      const number = whole(result.number);
      const page = whole(result.page);
      const path = text(result.path);
      if (number === null || page === null || !path) return null;
      const verb = name === "highlight_pdf_text"
        ? "Highlighted"
        : name === "add_pdf_note"
          ? "Noted"
          : name === "go_to_pdf_note"
            ? "Went to"
            : "Removed";
      return {
        icon: name === "go_to_pdf_note" ? "page" : "file",
        label: `${verb} #${number} on page ${page}`,
        detail: basename(path),
        ...(name === "go_to_pdf_note" ? { page } : {}),
      };
    }
    case "download_annotated_pdf":
    case "download_pdf_notes": {
      const path = text(result.path);
      if (result.started !== true || !path) return null;
      const label = name === "download_pdf_notes" ? "Downloaded notes" : "Downloaded with highlights";
      return { icon: "file", label, detail: basename(path) };
    }
    case "quick_answer":
      if (result.noPaper === true) return null;
      return { icon: "lookup", label: lookupLabel(text(args.question), "done"), state: "done" };
    case "ask_reviewer": {
      if (result.asked !== true) return null;
      const summary = text(args.summary) || text(args.question);
      return {
        icon: "reviewer",
        label: `Asked Gali: ${summary}`,
        ...(typeof result.queued === "string" ? { detail: "queued" } : {}),
      };
    }
    case "rename_project": {
      const title = text(result.title);
      return result.renamed === true && title ? { icon: "project", label: `Renamed to ${title}` } : null;
    }
    case "delete_project": {
      if (result.deleted !== true) return null;
      const title = text(args.confirmTitle);
      return { icon: "delete", label: title ? `Deleted ${title}` : "Deleted" };
    }
    default:
      return null;
  }
}

function statusText(line: Extract<VoiceLine, { kind: "status" }>, titles: ReadonlyMap<string, string>): string {
  const title = line.projectKey ? titles.get(line.projectKey) : undefined;
  return title && line.projectKey ? line.text.replace(line.projectKey, title) : line.text;
}

export function transcriptItems(
  lines: ReadonlyArray<VoiceLine>,
  titles: ReadonlyMap<string, string>,
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const line of lines) {
    if (line.kind === "message") {
      if (!line.text.trim()) continue;
      items.push({ kind: "message", id: line.id, role: line.role === "user" ? "user" : "assistant", text: line.text });
      continue;
    }
    if (line.kind === "status") {
      const mark = line.mark;
      if (mark?.type === "view-shared") continue;
      if (mark?.type === "reviewer" && mark.phase === "started") continue;
      items.push({ kind: "activity", id: line.id, icon: "status", label: statusText(line, titles) });
      continue;
    }
    const args = record(line.args);
    const activity = toolActivity(line.name, args, record(line.result));
    if (!activity) continue;
    const last = items[items.length - 1];
    if (activity.icon === "page") {
      const { page, ...turn } = activity;
      if (last?.kind === "activity" && last.icon === "file" && page !== undefined) {
        items[items.length - 1] = { ...last, page };
      } else if (last?.kind === "activity" && last.icon === "page") {
        items[items.length - 1] = { ...turn, kind: "activity", id: last.id };
      } else {
        items.push({ ...turn, kind: "activity", id: line.id });
      }
      continue;
    }
    items.push({ kind: "activity", id: line.id, ...activity });
  }
  return items;
}

export function activityDetail(item: ActivityItem): string {
  return [item.detail, item.page === undefined ? undefined : `p. ${item.page}`]
    .filter(Boolean)
    .join(" · ");
}

export function formatTranscript(items: ReadonlyArray<TranscriptItem>): string {
  return items
    .map((item) => {
      if (item.kind === "message") return `${item.role === "user" ? "User" : "Gali"}: ${item.text.trim()}`;
      const detail = activityDetail(item);
      return `· ${item.label}${detail ? ` · ${detail}` : ""}`;
    })
    .join("\n");
}
