import path from "node:path";
import { GALI_CONFIG } from "../shared/config.js";
import type { ProjectEvent, ReviewProgressEvent, ReviewerEvent } from "../shared/domain/contracts.js";
import { prepareAgentUser } from "../src/agents/providers/codex/agent-user.js";
import { createAppContext } from "../src/application/app-context.js";
import { createActivityTracker, startIdleSleepWatcher } from "../src/http/idle-sleep.js";
import { createGaliHttpServer } from "../src/http/server.js";
import { loadEnv } from "../src/lib/env.js";
import {
  configureOperationalLogger,
  logSandboxEvent,
  operationalErrorFields,
} from "../src/observability/operational-logger.js";

loadEnv();

process.on("uncaughtException", (error) => {
  logSandboxEvent({
    eventName: "sandbox.process.crashed",
    level: "error",
    status: "uncaughtException",
    ...operationalErrorFields(error),
  });
});
process.on("unhandledRejection", (reason) => {
  logSandboxEvent({
    eventName: "sandbox.process.crashed",
    level: "error",
    status: "unhandledRejection",
    ...operationalErrorFields(reason),
  });
});

const secret = process.env.GALI_HTTP_SECRET;
if (!secret?.trim()) throw new Error("GALI_HTTP_SECRET is missing");
const port = Number(process.env.GALI_HTTP_PORT ?? 8787);
const dataDir = path.resolve(process.env.GALI_DATA ?? ".gali-data");
prepareAgentUser(dataDir);
configureOperationalLogger({
  ...(process.env.GALI_TELEMETRY_URL ? { url: process.env.GALI_TELEMETRY_URL } : {}),
  ...(process.env.GALI_TELEMETRY_TOKEN ? { token: process.env.GALI_TELEMETRY_TOKEN } : {}),
  ...(process.env.GALI_SANDBOX_ID ? { sandboxId: process.env.GALI_SANDBOX_ID } : {}),
  ...(process.env.GALI_BACKEND_VERSION ? { version: process.env.GALI_BACKEND_VERSION } : {}),
});

const fans = {
  reviewer: (_event: ReviewerEvent) => {},
  project: (_event: ProjectEvent) => {},
  progress: (_event: ReviewProgressEvent) => {},
};

const activity = createActivityTracker();

const app = await createAppContext({
  dataDir,
  migrations: path.resolve("drizzle"),
  onReviewerEvent: (event) => {
    activity.touch();
    fans.reviewer(event);
    if (event.type === "reviewer.finished" && event.status === "failed") {
      logSandboxEvent({
        eventName: "review.failed",
        level: "error",
        projectKey: event.projectKey,
        ...operationalErrorFields(event.error),
      });
    }
  },
  onProjectEvent: (event) => fans.project(event),
  onReviewProgress: (event) => fans.progress(event),
});

const server = await createGaliHttpServer(app, { port, secret, activity });
fans.reviewer = server.publishReviewer;
fans.project = server.publishProject;
fans.progress = server.publishProgress;

console.log(`gali http listening on 0.0.0.0:${port} dataDir=${dataDir}`);
logSandboxEvent({ eventName: "sandbox.process.started", level: "info" });

const sleepUrl = process.env.GALI_SLEEP_URL;
if (sleepUrl) {
  const sleepToken = process.env.GALI_SLEEP_TOKEN;
  if (!sleepToken) throw new Error("GALI_SLEEP_URL is set but GALI_SLEEP_TOKEN is missing");
  // The sandbox only learns its own id at wake time, so it arrives as env.
  const sandboxId = process.env.GALI_SANDBOX_ID;
  if (!sandboxId) throw new Error("GALI_SLEEP_URL is set but GALI_SANDBOX_ID is missing");
  const idleMinutes = GALI_CONFIG.sandboxIdleMinutes;
  startIdleSleepWatcher({
    tracker: activity,
    activeReviews: () => app.review.busy(),
    sandboxId,
    sleepUrl,
    sleepToken,
    idleAfterMs: idleMinutes * 60_000,
    checkEveryMs: 60_000,
    onFailure: (error) => {
      logSandboxEvent({
        eventName: "sandbox.sleep.failed",
        level: "error",
        ...operationalErrorFields(error),
      });
    },
  });
  console.log(`[idle] sleep after ${idleMinutes}m idle via ${sleepUrl}`);
} else {
  console.log("[idle] GALI_SLEEP_URL unset — idle sleep disabled");
}
