import { expect, test } from "vitest";
import { anchorNoteToViewer, DOWNLOAD_UNAVAILABLE, RealtimeToolDispatcher } from "./tool-running";

test("a PDF download never claims a download on a device that cannot save files", async () => {
  const dispatcher = new RealtimeToolDispatcher("s", () => false);
  await expect(dispatcher.dispatch("download_annotated_pdf", { projectKey: "p" })).resolves.toEqual({ error: DOWNLOAD_UNAVAILABLE });
});

test("add_finding_to_notes gets the page on screen, for a finding with no quote in the paper", () => {
  expect(anchorNoteToViewer("add_finding_to_notes", { findingId: "f2" }, { path: "paper/x.pdf", page: 3 }))
    .toEqual({ findingId: "f2", page: 3 });
});
