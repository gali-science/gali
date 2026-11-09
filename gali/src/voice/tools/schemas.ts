import { PROJECT_TABS } from "../../../shared/domain/contracts.js";

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

const DESCRIBE_ARG = {
  type: "boolean",
  description:
    "true only when this reply must talk about what the view shows (the user asked about its content, or a walkthrough step). Otherwise omit: the tool returns at once and the view image arrives a moment later.",
};

const PROJECT_KEY = { type: "string" };

export function voiceToolSchemas() {
  return [
    {
      type: "function" as const,
      name: "list_projects",
      description: "List the projects (one PDF each).",
      parameters: objectSchema({}),
    },
    {
      type: "function" as const,
      name: "open_project",
      description:
        "Open a project by key or title fragment: the PDF on one side, the code on the other.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        query: { type: "string" },
      }),
    },
    {
      type: "function" as const,
      name: "go_home",
      description: "Open the list of projects.",
      parameters: objectSchema({}),
    },
    {
      type: "function" as const,
      name: "open_new_project",
      description:
        "Open the Add to library dialog, where the user picks the PDF and may add its code (a GitHub link or a .zip) from their device. You cannot pick files for them. Pass title only when the user said what to call it. After opening, one short sentence telling them to choose the PDF, and the code if they have it, then stop.",
      parameters: objectSchema({ title: { type: "string" } }),
    },
    {
      type: "function" as const,
      name: "close_new_project",
      description: "Dismiss the Add to library dialog.",
      parameters: objectSchema({}),
    },
    {
      type: "function" as const,
      name: "delete_project",
      description:
        "Permanently delete a project: all its files (the PDF, such as a paper or slides, and any code), its notes, and its findings. Resolve by projectKey or query. The first call without a confirmTitle matching the exact title returns needsConfirmation — ask the user to confirm the title, then call again with confirmTitle. Never invent confirmTitle.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        query: { type: "string" },
        confirmTitle: { type: "string" },
      }),
    },
    {
      type: "function" as const,
      name: "rename_project",
      description: "Rename a project. Its files stay the same.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        title: { type: "string" },
      }, ["projectKey", "title"]),
    },
    {
      type: "function" as const,
      name: "open_paper",
      description:
        "Show the PDF, optionally at a page. Expands the PDF panel if it was collapsed. For asks like “go to the results”, pick the page yourself from the PDF text and pass page.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        page: { type: "number" },
        describe: DESCRIBE_ARG,
      }, ["projectKey"]),
    },
    {
      type: "function" as const,
      name: "set_viewer_page",
      description:
        "Turn the page of the PDF. Pass page for an absolute page number, or direction next/prev.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        page: { type: "number" },
        direction: { type: "string", enum: ["next", "prev"] },
        describe: DESCRIBE_ARG,
      }, ["projectKey"]),
    },
    {
      type: "function" as const,
      name: "open_code_file",
      description:
        "Open a file from the project folder in the code panel (expands it if collapsed). Paths are relative to the project folder: the released code is under code/. Pass lines [first, last] to scroll to and mark a range, e.g. a code ref from the review. Unknown path → project_source tree or search first; never invent a path. Returns display (full | truncated | no-preview | too-large) — state it as fact.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        path: { type: "string" },
        lines: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 2 },
        describe: DESCRIBE_ARG,
      }, ["projectKey", "path"]),
    },
    {
      type: "function" as const,
      name: "show_tab",
      description:
        "Switch the right side of the project screen to a tab: review (the Findings tab: the findings on this PDF), notes (the user's highlights and notes), chat (this conversation as text), or code (the code viewer). Use for “show the findings”, “show the review”, “open my notes”, “show the chat”, “show the code”.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        tab: { type: "string", enum: [...PROJECT_TABS] },
      }, ["projectKey", "tab"]),
    },
    {
      type: "function" as const,
      name: "project_source",
      description:
        "Inspect the project folder: paper/ (the PDF), code/ (the released code), reviews/ (documents saved by your checks). tree=list paths; read=one text file; search=grep text contents (a literal substring, case-insensitive). Every PDF has a text copy beside it, <file>.pdf.txt, with === page N === lines; reading the PDF returns that copy, and search covers it, so a hit in paper/x.pdf.txt gives you the exact words and the page to pass to highlight_pdf_text. read returns the first 256KB with truncated: true and nextOffset — pass offset=nextOffset to continue. Use it to find paths and quick facts; for anything that needs understanding, ask_reviewer.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        action: { type: "string", enum: ["tree", "read", "search"] },
        path: { type: "string" },
        query: { type: "string" },
        depth: { type: "number" },
        limit: { type: "number" },
        offset: { type: "number" },
      }, ["projectKey", "action"]),
    },
    {
      type: "function" as const,
      name: "quick_answer",
      description:
        "Fast answer from the PDF's text (a few seconds). Use for simple questions the PDF answers directly: what a term or symbol means, what dataset or baseline they use, what a section says, a number from a table, a definition, a one-line summary. Pass the question with any page or section the user means. Returns { answer } — speak it as your own. If the answer says the PDF does not cover it, or the question needs the code, running anything, or careful checking, use ask_reviewer instead.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        question: { type: "string" },
      }, ["projectKey", "question"]),
    },
    {
      type: "function" as const,
      name: "ask_reviewer",
      description:
        "Run a deeper check on a hard question. It reads the whole PDF and code, can run the code, and remembers earlier questions on this project. Use for: does the code match the PDF, is this proof or derivation right, are the claims supported, check a number against the code, reproduce a result, write a review or a correctness report, anything quick_answer could not settle. Pass the full question (with page, section, figure, or file the user means) and a 6–12 word UI label in summary. Pass what the user asked, in their words, plus where they are; never add checks they did not ask for, such as the code or the implementation. The question is the user's request, not your instructions for the check: it already knows to write findings into the review. The summary names what the user asked, e.g. 'Full correctness review' or 'Does train.py match Eq. 3?', with no hedges like 'if needed'. Returns at once with { asked: true }; the answer arrives later as a background update. Long jobs (a full review, plots, running code) run in the background and report as their own update; other questions on the project, including what the job is doing, are answered meanwhile, one at a time.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        question: { type: "string" },
        summary: { type: "string" },
      }, ["projectKey", "question", "summary"]),
    },
    {
      type: "function" as const,
      name: "cancel_reviewer",
      description: "Stop the current question and any background job on this project, when the user asks to stop or cancel it.",
      parameters: objectSchema({ projectKey: PROJECT_KEY }, ["projectKey"]),
    },
    {
      type: "function" as const,
      name: "highlight_pdf_text",
      description:
        "Highlight a passage in the PDF and open the viewer on it. text must be verbatim from the PDF — from the page you see or from project_source search; never paraphrase. For a long passage pass its start and end joined by … (\"We compare against … strongest baseline.\"). Pass page when you know it, so the right occurrence wins. Pass note to attach a note to the highlight in one call. Returns the highlight number the user can refer to later.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        text: { type: "string" },
        page: { type: "number" },
        color: { type: "string", enum: ["yellow", "green", "blue", "pink", "orange"] },
        note: { type: "string" },
      }, ["projectKey", "text"]),
    },
    {
      type: "function" as const,
      name: "add_pdf_note",
      description:
        "Write a note on the PDF. By default it goes on the page on screen: pass no anchor and the app fills in that page. Only when the user names a place, pass one of: number (an existing highlight — replaces its note), quote (a verbatim passage — highlights it with the note), or page. Never ask where to put a note. text is the note itself, in the user's words, tightened.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        text: { type: "string" },
        number: { type: "number" },
        quote: { type: "string" },
        page: { type: "number" },
      }, ["projectKey", "text"]),
    },
    {
      type: "function" as const,
      name: "add_finding_to_notes",
      description:
        "Add a review finding to the user's notes, the same as its Add to notes button: the finding's title and body, highlighted on its quote in the PDF, or on the page on screen when it has none. findingId is the finding's id in review.json (f1, f2, …).",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        findingId: { type: "string" },
      }, ["projectKey", "findingId"]),
    },
    {
      type: "function" as const,
      name: "list_pdf_notes",
      description:
        "List the highlights and notes on the PDF in page order (number, page, quote, note). Use for “what did I highlight”, and to find a number before go_to_pdf_note or remove_pdf_note.",
      parameters: objectSchema({ projectKey: PROJECT_KEY }, ["projectKey"]),
    },
    {
      type: "function" as const,
      name: "go_to_pdf_note",
      description:
        "Open the PDF at one of its highlights or notes, by number. To go through them, walk them in list_pdf_notes order: open one, speak it, then the next.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        number: { type: "number" },
        describe: DESCRIBE_ARG,
      }, ["projectKey", "number"]),
    },
    {
      type: "function" as const,
      name: "remove_pdf_note",
      description:
        "Delete one highlight or note from the PDF, by number. Delete only the one the user named; list_pdf_notes first if the number is unclear.",
      parameters: objectSchema({
        projectKey: PROJECT_KEY,
        number: { type: "number" },
      }, ["projectKey", "number"]),
    },
    {
      type: "function" as const,
      name: "download_annotated_pdf",
      description:
        "Download a copy of the PDF with its highlights and notes written in as standard PDF comments, to the user's device. Use when they ask to download, export, save, or share their highlights or the annotated PDF.",
      parameters: objectSchema({ projectKey: PROJECT_KEY }, ["projectKey"]),
    },
    {
      type: "function" as const,
      name: "download_pdf_notes",
      description:
        "Download just the notes taken on the PDF — each note and highlighted passage, by page, numbered like the pins — as a markdown file. Use when they ask for their notes or a notes file rather than the annotated PDF.",
      parameters: objectSchema({ projectKey: PROJECT_KEY }, ["projectKey"]),
    },
    {
      type: "function" as const,
      name: "open_project_actions",
      description: "Open the project ⋯ actions sheet (Rename, Delete). Phone chrome.",
      parameters: objectSchema({ projectKey: PROJECT_KEY }, ["projectKey"]),
    },
    {
      type: "function" as const,
      name: "close_project_actions",
      description: "Close the project ⋯ actions sheet.",
      parameters: objectSchema({ projectKey: PROJECT_KEY }, ["projectKey"]),
    },
    {
      type: "function" as const,
      name: "navigate_back",
      description: "Phone back: dismiss the top overlay or return to the list of projects.",
      parameters: objectSchema({}),
    },
    {
      type: "function" as const,
      name: "open_transcript",
      description: "Open the voice Transcript sheet. Live voice log only.",
      parameters: objectSchema({}),
    },
    {
      type: "function" as const,
      name: "close_transcript",
      description: "Close the voice Transcript sheet.",
      parameters: objectSchema({}),
    },
    {
      type: "function" as const,
      name: "set_mic_muted",
      description: "Mute or unmute the voice mic. Does not end the voice session.",
      parameters: objectSchema({ muted: { type: "boolean" } }, ["muted"]),
    },
    {
      type: "function" as const,
      name: "end_voice",
      description: "End the voice session. Use when they ask to stop listening, hang up, or end voice.",
      parameters: objectSchema({}),
    },
    {
      type: "function" as const,
      name: "wait_for_user",
      description: "Use when silence or background audio needs no response.",
      parameters: objectSchema({}),
    },
    {
      type: "function" as const,
      name: "look_at_window",
      description:
        "Open the in-window region picker so the user can drag a rectangle on the Gali UI for you to see. ONLY when they explicitly ask you to look at something on screen (\"look at this figure\", \"can you see my selection\") that the navigation notes do not name. NEVER for “what am I looking at” or “where am I” — answer those from the latest navigation note. Does not capture outside Gali.",
      parameters: objectSchema({}),
    },
  ] as const;
}

export type VoiceToolSchema = ReturnType<typeof voiceToolSchemas>[number];
export type VoiceToolName = VoiceToolSchema["name"];
