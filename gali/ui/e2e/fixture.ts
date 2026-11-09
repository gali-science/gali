import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Route } from "@playwright/test";
import type { ProjectDto, ProjectFileDto } from "../../shared/domain/contracts";

/** A real two-page PDF, so the embedpdf worker actually parses and paints. */
const samplePdf = readFileSync(fileURLToPath(new URL("./fixtures/sample.pdf", import.meta.url)));

export const alphaProject: ProjectDto = {
  key: "alpha",
  title: "Alpha study",
  paperPath: "paper/alpha.pdf",
  paperTitle: null,
  createdAt: "2026-09-18T09:00:00.000Z",
  updatedAt: "2026-09-18T10:00:00.000Z",
};

const trainPy = "import torch\n\n\ndef main():\n    print('train')\n";

const files: ProjectFileDto[] = [
  { path: "paper/alpha.pdf", kind: "pdf", binary: true, bytes: samplePdf.length },
  { path: "code/train.py", kind: "text", binary: false, bytes: trainPy.length },
  { path: "code/README.md", kind: "text", binary: false, bytes: 7 },
];

export type TrialStatus = "active" | "exhausted";

type Options = {
  galiProjects: ProjectDto[];
  galiTrial: TrialStatus;
};

function json(route: Route, body: unknown) {
  return route.fulfill({ json: body });
}

export const test = base.extend<Options>({
  galiProjects: [[], { option: true }],
  galiTrial: ["active", { option: true }],
  page: async ({ page, galiProjects, galiTrial }, use) => {
    await page.clock.setFixedTime(new Date("2026-09-18T12:00:00.000Z"));
    const trial = galiTrial === "exhausted"
      ? { status: "exhausted", spentUsd: 0.1, budgetUsd: 0.1, remainingUsd: 0 }
      : { status: "active", spentUsd: 0, budgetUsd: 5, remainingUsd: 5 };

    await page.route("**/api/sandbox/ensure", (route) => json(route, { status: "ready" }));
    await page.route("**/api/consent", (route) =>
      json(route, {
        version: 1,
        accepted: true,
        voiceOpenAiAccepted: true,
        experimentsTogetherAccepted: true,
        acceptedAt: "2026-09-18T08:00:00.000Z",
      }));
    await page.route("**/api/me", (route) =>
      json(route, { displayName: "Ada", identityEmail: "ada@example.com", trial }));
    await page.route("**/api/usage", (route) => json(route, { trial }));
    await page.route("**/api/memory", (route) => json(route, null));
    await page.route("**/api/client-error", (route) => json(route, { ok: true }));
    await page.route("**/api/client-event", (route) => json(route, { ok: true }));

    await page.route("**/api/gali/**", (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^\/api\/gali/, "");
      if (path === "/health") return json(route, { ok: true, capabilities: { importUpload: true } });
      if (path === "/events") {
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": hb\n\n" });
      }
      if (path === "/events/recent") return json(route, { latest: 0, reviewer: [], projects: [] });
      if (path === "/projects") return json(route, galiProjects);
      const match = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
      if (!match) return route.fulfill({ status: 404, json: { error: `no fixture for ${path}` } });
      const project = galiProjects.find((candidate) => candidate.key === decodeURIComponent(match[1]!));
      if (!project) return route.fulfill({ status: 404, json: { error: "unknown project" } });
      const rest = match[2] ?? "";
      if (rest === "") return json(route, project);
      if (rest === "/tree") return json(route, { path: "", entries: files });
      if (rest === "/pdf-annotations") return json(route, []);
      if (rest === "/media") {
        return route.fulfill({ status: 200, contentType: "application/pdf", body: samplePdf });
      }
      if (rest === "/file") {
        const file = files.find((candidate) => candidate.path === url.searchParams.get("path"))!;
        return json(route, { file, content: file.path === "code/train.py" ? trainPy : "# Alpha\n" });
      }
      return route.fulfill({ status: 404, json: { error: `no fixture for ${path}` } });
    });
    await use(page);
  },
});

export { expect };
