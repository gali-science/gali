import { afterEach, expect, test, vi } from "vitest";
import {
  mintRealtimeToken,
  RealtimeTokenError,
} from "../src/adapters/openai/realtime-token.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function tokenResponse() {
  return new Response(JSON.stringify({ client_secret: { value: "ephemeral" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function gateway() {
  vi.stubEnv("GALI_MODEL_GATEWAY_URL", "https://gateway.example/v1");
  vi.stubEnv("GALI_MODEL_GATEWAY_TOKEN", "gateway-token");
}

async function mintedSession() {
  gateway();
  const fetchMock = vi.fn().mockResolvedValue(tokenResponse());
  vi.stubGlobal("fetch", fetchMock);
  await mintRealtimeToken();
  const init = fetchMock.mock.calls[0]![1] as { body: string };
  return (JSON.parse(init.body) as {
    session: {
      instructions: string;
      tools: Array<{ name: string; description: string; parameters: { properties: Record<string, { enum?: string[] }> } }>;
    };
  }).session;
}

test("a gateway token is metered and minted through the gateway", async () => {
  gateway();
  const fetchMock = vi.fn().mockResolvedValue(tokenResponse());
  vi.stubGlobal("fetch", fetchMock);

  await expect(mintRealtimeToken()).resolves.toMatchObject({
    client_secret: { value: "ephemeral" },
    metered: true,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "https://gateway.example/v1/realtime/client_secrets",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer gateway-token" }) as unknown,
    }),
  );
});

test("a local key is not metered", async () => {
  vi.stubEnv("GALI_MODEL_GATEWAY_URL", "");
  vi.stubEnv("GALI_MODEL_GATEWAY_TOKEN", "");
  vi.stubEnv("OPENAI_API_KEY", "local-key");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()));

  await expect(mintRealtimeToken()).resolves.toMatchObject({ metered: false });
});

test("tells Gali the user types in the Gali bar, not in the Chat tab", async () => {
  const { instructions } = await mintedSession();
  expect(instructions).toContain("Gali bar");
  expect(instructions).not.toContain("where the user can also type");
});

test("Gali keeps the user's language after tools and background updates, and knows Chat is per project", async () => {
  const { instructions } = await mintedSession();
  expect(instructions).toContain("Reply in the language of the user's latest message. Keep that language after tool results and background updates, even when they are in English. Before the user says anything, use English. Never switch from an accent alone.");
  expect(instructions).not.toContain("English by default.");
  expect(instructions).toContain("Chat (this project's part of the conversation as text");
});

test("Gali names the project when asked about a job without one", async () => {
  const { instructions } = await mintedSession();
  expect(instructions).toContain('When the user asks about a job without naming its project ("why did it crash?", "is it done?"), name the project in your answer. If more than one project could be meant, ask which one.');
});

test("Gali knows Browse code shows every project file, including the ones its checks write", async () => {
  const { instructions } = await mintedSession();
  expect(instructions).toContain("Browse code in the More actions menu opens the Code tab with every file in the project, including files your checks write.");
});

test("Gali reviews papers and helps the user learn from them, with no research mode", async () => {
  const session = await mintedSession();
  expect(session.instructions).toContain("You are Gali, a voice assistant that helps a human review a PDF or learn from it: a scientific paper, slides, a chapter, or notes.");
  expect(session.instructions).toContain("explain only: do not bring up problems or findings unless they ask.");
  expect(session.instructions).toContain("Practice problems, a worked example with real numbers, or a visual (a diagram, plot, or chart that explains something) go to ask_reviewer too, and the question says \"add it as a study finding\", never \"explain only, no findings\"; they land in the Findings tab under To study.");
  expect(session.instructions).toContain('When you speak of them, say "the findings" or "the Findings tab", never "the review".');
  expect(session.instructions).toContain("You cannot draw yourself, but ask_reviewer can: never tell the user a visual cannot be made. When it is ready, tell them it is in the Findings tab under To study.");
  expect(session.instructions).toContain("Home is the Library: the list of projects. On desktop the list is in the sidebar and Home is the drop page. A project screen");
  expect(session.instructions).toContain("Add to library / new project → open_new_project. The user picks the PDF and may add its code");
  expect(session.instructions).toContain("Choose files opens the same dialog as open_new_project.");
  expect(session.instructions).toContain("Desktop has a slim sidebar on the left that opens when the pointer is over it: the Gali mark, New (goes Home), every project (newest first; click one to open it), and Account at the bottom.");
  expect(session.instructions).not.toContain("Desktop has no sidebar");
  expect(session.instructions).toContain("Home / Library → go_home.");
  expect(session.instructions).toContain("Chat and Account are in the More actions menu.");
  expect(session.instructions).toContain("In a project, Home in the top-left breadcrumb goes home");
  expect(session.instructions).toContain("Account and Delete are in the More actions menu. The Account page has a Back to Home button at the top.");
  expect(session.instructions).not.toContain("Back to Library");
  expect(session.instructions).not.toMatch(/\bPapers\b/);
  for (const research of ["Research mode", "Start a project", "Lab", "draft", "data/", "Experiments need the user's yes"]) {
    expect(session.instructions).not.toContain(research);
  }

  const tools = new Map(session.tools.map((tool) => [tool.name, tool]));
  expect(tools.has("download_draft")).toBe(false);
  expect(tools.get("show_tab")!.parameters.properties.tab!.enum).toEqual(["review", "notes", "chat", "code"]);
  expect(Object.keys(tools.get("open_paper")!.parameters.properties)).toEqual(["projectKey", "page", "describe"]);
  for (const tool of session.tools) {
    expect(tool.description).not.toMatch(/\b(?:lab|draft|starts a project|datasets)\b/i);
  }
});

test("Gali calls the file a PDF, not a paper, outside the list of what a PDF can be and folder paths", async () => {
  const session = await mintedSession();
  const unlisted = (text: string) => text.replace(/a (?:scientific )?paper(?:,| or) slides/g, "").replace(/paper\//g, "");
  expect(unlisted(session.instructions)).not.toMatch(/\bpapers?\b/i);
  for (const tool of session.tools) {
    expect(unlisted(tool.description)).not.toMatch(/\bpapers?\b/i);
  }
});

test("Gali speaks as the only persona: it says it is checking, never that it hands work to a reviewer", async () => {
  const { instructions } = await mintedSession();
  expect(instructions).toContain("say \"I'm checking\" rather than naming an agent.");
  expect(instructions).toContain("Before the call, one short clause that you are checking it and it can take a while");
  expect(instructions).toContain("if it is analysis, offer to look into it.");
  expect(instructions).not.toContain("passing it to the reviewer");
  expect(instructions).not.toContain("offer to ask the reviewer");
});

test("the voice model never reads the word reviewer outside the ask_reviewer and cancel_reviewer ids", async () => {
  const { instructions, tools } = await mintedSession();
  const outsideIds = /(?<!ask_|cancel_)reviewer/i;
  expect(instructions).not.toMatch(outsideIds);
  for (const tool of tools) expect(`${tool.name}: ${tool.description}`).not.toMatch(outsideIds);
});

test("Gali passes the user's question as asked and owns the caveats in an answer", async () => {
  const { instructions, tools } = await mintedSession();
  const noWidening = "Pass what the user asked, in their words, plus where they are; never add checks they did not ask for, such as the code or the implementation.";
  expect(instructions).toContain(noWidening);
  expect(tools.find((tool) => tool.name === "ask_reviewer")!.description).toContain(noWidening);
  expect(instructions).toContain("Caveats and choices in an answer are yours; never attribute them to anyone else.");
});

test("Gali says it is checking once per question, not again on a retry", async () => {
  const { instructions } = await mintedSession();
  expect(instructions).toContain("Say it once per question, never again when you call again for the same question.");
});

test("an okay or thanks gets a few words, not the job status again, and a job start may be only a silent note", async () => {
  const { instructions } = await mintedSession();
  expect(instructions).toContain('When the user only acknowledges ("okay", "thanks"), answer in a few words and never repeat the status of a running job.');
  expect(instructions).toContain("when the job starts you may get only a silent note");
  expect(instructions).not.toContain("the first update only says the job started");
});

test("keeps the gateway status and code", async () => {
  gateway();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({
      error: { message: "Your $10 trial is spent.", code: "trial_exhausted" },
    }), { status: 402 }),
  ));

  const error = await mintRealtimeToken().then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(RealtimeTokenError);
  expect(error).toMatchObject({ status: 402, code: "trial_exhausted", message: "Your $10 trial is spent." });
});
