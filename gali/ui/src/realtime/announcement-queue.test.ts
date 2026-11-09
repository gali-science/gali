import { expect, test } from "vitest";
import { AnnouncementQueue } from "./announcement-queue";

function responseCreates(awaitsPlayback: boolean): number {
  const sent: Array<{ type: string }> = [];
  const queue = new AnnouncementQueue({
    send: (event) => sent.push(event as { type: string }),
    canFlush: () => true,
    quietForMs: () => Number.POSITIVE_INFINITY,
    awaitsPlayback: () => awaitsPlayback,
  });
  queue.enqueue("first");
  queue.enqueue("second");
  queue.onResponseCreated("r1");
  queue.onResponseDone({
    id: "r1",
    status: "completed",
    metadata: { purpose: "gali_background" },
    output: [{ type: "message" }],
  });
  queue.flush();
  return sent.filter((event) => event.type === "response.create").length;
}

function spokenQueue() {
  const sent: Array<{ type: string }> = [];
  const queue = new AnnouncementQueue({
    send: (event) => sent.push(event as { type: string }),
    canFlush: () => true,
    quietForMs: () => Number.POSITIVE_INFINITY,
    awaitsPlayback: () => true,
  });
  const creates = () => sent.filter((event) => event.type === "response.create").length;
  return { queue, creates };
}

test("an update the user cuts into after it started playing is not spoken again", () => {
  const midResponse = spokenQueue();
  midResponse.queue.enqueue("update");
  midResponse.queue.onResponseCreated("r1");
  midResponse.queue.onAudioStarted("r1");
  midResponse.queue.interruptForSpeech();
  midResponse.queue.flush();
  expect(midResponse.creates()).toBe(1);

  const afterResponse = spokenQueue();
  afterResponse.queue.enqueue("update");
  afterResponse.queue.onResponseCreated("r1");
  afterResponse.queue.onAudioStarted("r1");
  afterResponse.queue.onResponseDone({ id: "r1", status: "completed", metadata: { purpose: "gali_background" }, output: [{ type: "message" }] });
  afterResponse.queue.interruptForSpeech();
  afterResponse.queue.flush();
  expect(afterResponse.creates()).toBe(1);

  const cleared = spokenQueue();
  cleared.queue.enqueue("update");
  cleared.queue.onResponseCreated("r1");
  cleared.queue.onAudioStarted("r1");
  cleared.queue.onResponseDone({ id: "r1", status: "completed", metadata: { purpose: "gali_background" }, output: [{ type: "message" }] });
  cleared.queue.onAudioCleared();
  cleared.queue.flush();
  expect(cleared.creates()).toBe(1);
});

test("an update cut before its audio started is spoken once more", () => {
  const { queue, creates } = spokenQueue();
  queue.enqueue("update");
  queue.onResponseCreated("r1");
  queue.interruptForSpeech();
  queue.flush();
  expect(creates()).toBe(2);
});

test("a text reply does not hold the next update for audio playback", () => {
  expect(responseCreates(false)).toBe(2);
});

test("a spoken reply holds the next update until playback ends", () => {
  expect(responseCreates(true)).toBe(1);
});
