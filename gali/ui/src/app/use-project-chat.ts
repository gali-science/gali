import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readProjectChat, saveProjectChat } from "../api";
import type { StatusMark } from "../realtime-client";
import type { VoiceLine } from "../useVoice";

const SAVE_DELAY_MS = 1_000;
const SAVED_LINES_MAX = 200;
const MESSAGE_CHARS_MAX = 4_000;
const FIELD_CHARS_MAX = 1_000;
const SAVE_BYTES_MAX = 900_000;

function scalars(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string") out[key] = field.slice(0, FIELD_CHARS_MAX);
    else if (typeof field === "number" || typeof field === "boolean") out[key] = field;
  }
  return out;
}

export function savedLine(line: VoiceLine): Record<string, unknown> {
  const projectKey = line.projectKey ? { projectKey: line.projectKey } : {};
  if (line.kind === "message") {
    return { kind: "message", role: line.role, text: line.text.slice(0, MESSAGE_CHARS_MAX), ...projectKey };
  }
  if (line.kind === "status") {
    return { kind: "status", text: line.text, ...projectKey, ...(line.mark ? { mark: line.mark } : {}) };
  }
  const result = scalars(line.result);
  const project = line.result && typeof line.result === "object" ? (line.result as { project?: unknown }).project : undefined;
  const title = project && typeof project === "object" ? (project as { title?: unknown }).title : undefined;
  return {
    kind: "tool",
    name: line.name,
    args: scalars(line.args),
    result: typeof title === "string" ? { ...result, project: { title } } : result,
    ...projectKey,
  };
}

export function fittedLines(lines: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const kept = lines.slice(-SAVED_LINES_MAX);
  const encoder = new TextEncoder();
  const sizes = kept.map((line) => encoder.encode(JSON.stringify(line)).length + 1);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let start = 0;
  while (start < kept.length && total > SAVE_BYTES_MAX) {
    total -= sizes[start]!;
    start += 1;
  }
  return kept.slice(start);
}

export function restoredLines(raw: unknown[]): VoiceLine[] {
  const out: VoiceLine[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const line = item as Record<string, unknown>;
    const projectKey = typeof line.projectKey === "string" ? { projectKey: line.projectKey } : {};
    if (line.kind === "message" && typeof line.role === "string" && typeof line.text === "string") {
      out.push({ id: 0, kind: "message", role: line.role, text: line.text, ...projectKey });
    } else if (line.kind === "tool" && typeof line.name === "string") {
      out.push({ id: 0, kind: "tool", name: line.name, args: line.args, result: line.result, ...projectKey });
    } else if (line.kind === "status" && typeof line.text === "string") {
      const mark = line.mark && typeof line.mark === "object" ? { mark: line.mark as StatusMark } : {};
      out.push({ id: 0, kind: "status", text: line.text, ...projectKey, ...mark });
    }
  }
  return out.map((line, index) => ({ ...line, id: index - out.length }));
}

export function useProjectChat(openKey: string | null, lines: VoiceLine[]): VoiceLine[] {
  const [history, setHistory] = useState<Record<string, VoiceLine[]>>({});
  const loads = useRef(new Map<string, Promise<VoiceLine[] | null>>());
  const savedCounts = useRef(new Map<string, number>());
  const saves = useRef(new Map<string, Promise<void>>());
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const load = useCallback((key: string) => {
    const pending = loads.current.get(key);
    if (pending) return pending;
    const next = Promise.resolve()
      .then(() => readProjectChat(key))
      .then(({ lines: raw }) => restoredLines(raw))
      .catch(() => {
        loads.current.delete(key);
        return null;
      });
    loads.current.set(key, next);
    return next;
  }, []);

  useEffect(() => {
    if (!openKey) return;
    let alive = true;
    void load(openKey).then((loaded) => {
      if (alive && loaded) setHistory((current) => (current[openKey] ? current : { ...current, [openKey]: loaded }));
    });
    return () => {
      alive = false;
    };
  }, [load, openKey]);

  useEffect(() => {
    const dirty = new Set<string>();
    const counts = new Map<string, number>();
    for (const line of lines) {
      if (line.projectKey) counts.set(line.projectKey, (counts.get(line.projectKey) ?? 0) + 1);
    }
    for (const [key, count] of counts) {
      if (savedCounts.current.get(key) !== count) dirty.add(key);
    }
    if (dirty.size === 0) return;
    const timer = window.setTimeout(() => {
      for (const key of dirty) {
        const next = (saves.current.get(key) ?? Promise.resolve()).then(async () => {
          const loaded = await load(key);
          if (!loaded) return;
          const live = linesRef.current.filter((line) => line.projectKey === key);
          await saveProjectChat(key, fittedLines([...loaded, ...live].map(savedLine)));
          savedCounts.current.set(key, live.length);
        }).catch(() => {});
        saves.current.set(key, next);
      }
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [lines, load]);

  return useMemo(() => {
    if (!openKey) return lines;
    return [...(history[openKey] ?? []), ...lines.filter((line) => line.projectKey === openKey || jobEnded(line))];
  }, [history, lines, openKey]);
}

function jobEnded(line: VoiceLine): boolean {
  return line.kind === "status"
    && line.mark?.type === "reviewer"
    && (line.mark.phase === "finished" || line.mark.phase === "failed");
}
