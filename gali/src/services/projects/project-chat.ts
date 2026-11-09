import fsp from "node:fs/promises";
import path from "node:path";
import { UserError } from "../../lib/user-error.js";

export const PROJECT_CHAT_MAX_LINES = 200;

export function createProjectChat(dataDir: string) {
  const root = path.join(dataDir, "project-chats");
  const queues = new Map<string, Promise<unknown>>();
  const fileFor = (projectKey: string) => path.join(root, `${projectKey}.json`);

  function exclusive<T>(projectKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(projectKey) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    queues.set(projectKey, next.catch(() => undefined));
    return next;
  }

  return {
    async read(projectKey: string): Promise<unknown[]> {
      let raw: string;
      try {
        raw = await fsp.readFile(fileFor(projectKey), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return JSON.parse(raw) as unknown[];
    },

    write(projectKey: string, lines: unknown): Promise<number> {
      if (!Array.isArray(lines) || !lines.every((line) => line !== null && typeof line === "object" && !Array.isArray(line))) {
        throw new UserError("lines must be a list of objects");
      }
      const kept = lines.slice(-PROJECT_CHAT_MAX_LINES);
      return exclusive(projectKey, async () => {
        await fsp.mkdir(root, { recursive: true });
        const target = fileFor(projectKey);
        const staging = `${target}.tmp`;
        await fsp.writeFile(staging, JSON.stringify(kept));
        await fsp.rename(staging, target);
        return kept.length;
      });
    },

    forget(projectKey: string): Promise<void> {
      return exclusive(projectKey, () => fsp.rm(fileFor(projectKey), { force: true }));
    },
  };
}

export type ProjectChat = ReturnType<typeof createProjectChat>;
