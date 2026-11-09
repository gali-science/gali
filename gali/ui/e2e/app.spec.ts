import { alphaProject, expect, test } from "./fixture";

type Page = import("@playwright/test").Page;
type Locator = import("@playwright/test").Locator;

function box(locator: Locator) {
  return locator.evaluate((element) => element.getBoundingClientRect().toJSON() as DOMRect);
}
async function waitForBoot(page: Page) {
  await expect(page.locator(".boot-pane")).toHaveCount(0, { timeout: 8_000 });
}

async function openAlpha(page: Page) {
  await page.goto("/");
  await waitForBoot(page);
  await page.getByRole("button", { name: /Alpha study/ }).click();
  await expect(page.getByRole("region", { name: "PDF" })).toBeVisible();
}

test.describe("empty home", () => {
  test("boots to the drop page", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);

    await expect(page.getByRole("heading", { name: "Drop a PDF and its code" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible();
    await expect(page).toHaveScreenshot("empty-desktop-home.png", {
      fullPage: true,
      maxDiffPixels: 200,
    });
  });
});

test.describe("drop page", () => {
  test.use({ galiProjects: [alphaProject] });

  test("dropping a PDF uploads it and opens the project", async ({ page }) => {
    let created: unknown = null;
    await page.route("**/api/gali/import-uploads**", (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api\/gali/, "");
      if (path === "/import-uploads") {
        created = route.request().postDataJSON();
        return route.fulfill({ json: { uploadId: "u1", maxChunkBytes: 8_000_000 } });
      }
      if (path === "/import-uploads/u1") return route.fulfill({ json: { state: "done", project: alphaProject } });
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto("/");
    await waitForBoot(page);

    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File(["%PDF-1.4\n"], "attention_is_all.pdf", { type: "application/pdf" }));
      return data;
    });
    await page.getByRole("region", { name: "New project" }).dispatchEvent("drop", { dataTransfer: transfer });

    await expect(page.getByRole("region", { name: "PDF" })).toBeVisible();
    expect(created).toEqual({ title: "attention is all" });
  });
});

test.describe("empty home on phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Add to library only reviews a paper, and needs the PDF", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    await page.getByRole("button", { name: "Add to library" }).click();

    const dialog = page.getByRole("dialog", { name: "Add to library" });
    const review = dialog.getByRole("button", { name: "Add", exact: true });
    await expect(review).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Start a project" })).toHaveCount(0);
    await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveCount(0);

    await dialog.locator('input[type="file"][accept^=".pdf"]').setInputFiles({
      name: "attention_is_all.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n"),
    });
    await expect(dialog.getByLabel("PDF", { exact: true })).toHaveText("attention_is_all.pdf");
    await expect(review).toBeEnabled();
  });
});

test.describe("paper review", () => {
  test.use({ galiProjects: [alphaProject] });

  test("opens on the paper alone and shows the code tree on demand", async ({ page }) => {
    await openAlpha(page);

    await expect(page.getByRole("toolbar", { name: "PDF controls" })).toContainText("1 / 2", { timeout: 20_000 });
    await expect(page.getByRole("region", { name: "Code" })).toHaveCount(0);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Browse code" }).click();
    await expect(page.getByRole("region", { name: "Code" })).toBeVisible();
    await page.getByText("train.py").click();
    await expect(page.getByRole("region", { name: "File code/train.py" })).toContainText("print('train')");
  });

  test("the Code tab closes again and leaves the paper", async ({ page }) => {
    await openAlpha(page);
    const paper = page.getByRole("region", { name: "PDF" });
    const code = page.getByRole("region", { name: "Code" });

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Browse code" }).click();
    await expect(code).toBeVisible();
    await expect(paper).toBeVisible();

    await page.getByRole("button", { name: "Close Code" }).click();
    await expect(code).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Findings" })).toHaveAttribute("aria-selected", "true");
    await expect(paper).toBeVisible();
  });

  // The unit suites mock embedpdf away, so this is the only place the pdfium
  // worker, the wasm, and the render pipeline actually run.
  test("renders a real pdf through embedpdf", async ({ page }) => {
    await openAlpha(page);

    const sheet = page.getByRole("region", { name: "PDF" }).locator("img").first();
    await expect(sheet).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(
        () => sheet.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
  });

  test("the Chat tab opens the chat and Findings brings the findings back", async ({ page }) => {
    await openAlpha(page);
    const chat = page.getByRole("tab", { name: "Chat" });
    await expect(chat).toHaveAttribute("aria-selected", "false");

    await chat.click();
    await expect(chat).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".chat-drawer.is-tab")).toContainText("No messages yet");

    await page.getByRole("tab", { name: "Findings" }).click();
    await expect(page.locator(".chat-drawer.is-tab")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Findings" })).toBeVisible();
  });
});

test.describe("phone empty home", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("pins More actions to the top corner, where the paper list has it", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    const menu = await box(page.getByRole("button", { name: "More actions" }));
    const mark = await box(page.locator(".home-empty-mark"));
    expect(menu.top).toBe(20);
    expect(menu.right).toBe(366);
    expect(menu.bottom).toBeLessThan(mark.top);
  });
});

test.describe("phone", () => {
  test.use({
    galiProjects: [alphaProject],
    viewport: { width: 390, height: 844 },
  });

  test("puts More actions in the same top corner as the empty home", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    const menu = await box(page.getByRole("button", { name: "More actions" }));
    expect(menu.top).toBe(20);
    expect(menu.right).toBe(366);
  });

  test("uses the phone paper roster", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);

    await expect(page.locator(".phone-app")).toBeVisible();
    await expect(page.getByRole("button", { name: /Alpha study/ })).toBeVisible();
    await expect(page).toHaveScreenshot("phone-home.png", {
      fullPage: true,
      maxDiffPixels: 200,
    });
  });

  test("switches between paper and code", async ({ page }) => {
    await openAlpha(page);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Browse code" }).click();
    await expect(page.getByRole("region", { name: "Code" })).toBeVisible();
    await expect(page.getByRole("region", { name: "PDF" })).toHaveCount(0);
    await page.getByRole("button", { name: "PDF", exact: true }).click();
    await expect(page.getByRole("region", { name: "PDF" })).toBeVisible();
  });

  test("a finding's page link opens the PDF on that page", async ({ page }) => {
    await page.route("**/api/gali/projects/alpha/review", (route) =>
      route.fulfill({
        json: {
          document: {
            title: "Alpha review",
            findings: [{
              id: "f1",
              severity: "ok",
              title: "The headline number matches the table",
              body: "The reported number matches Table 2.",
              refs: [{ paper: { page: 2, quote: "Table 2", place: "§2 Results" } }],
              visuals: [],
            }],
          },
          updatedAt: "2026-09-18T11:00:00.000Z",
          problems: [],
          anchors: { "f1:0": null },
          dismissed: [],
        },
      }));
    await openAlpha(page);
    const toolbar = page.getByRole("toolbar", { name: "PDF controls" });
    await expect(toolbar).toContainText("1 / 2", { timeout: 20_000 });

    await page.getByRole("button", { name: "Findings", exact: true }).click();
    await expect(page.getByRole("region", { name: "PDF" })).toHaveCount(0);
    await page.getByRole("button", { name: /§2 Results/ }).click();
    await expect(toolbar).toContainText("2 / 2", { timeout: 10_000 });
    await page.waitForTimeout(1_000);
    await expect(toolbar).toContainText("2 / 2");
  });

  test("keeps the pdf toolbar contained and touch-friendly", async ({ page }) => {
    await openAlpha(page);

    const toolbar = page.getByRole("toolbar", { name: "PDF controls" });
    await expect(toolbar).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    await expect
      .poll(() =>
        page.getByLabel("Next page").evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThanOrEqual(40);
    await toolbar.getByRole("button", { name: "Find in PDF" }).click();
    await expect(toolbar.getByRole("searchbox", { name: "Find in PDF" })).toBeVisible();
  });

  test("gives the notes and chat controls touch-size targets", async ({ page }) => {
    await page.route((url) => url.pathname.endsWith("/pdf-annotations"), (route) =>
      route.fulfill({
        json: [{
          number: 1,
          page: 1,
          pageWidth: 612,
          pageHeight: 792,
          rects: [{ x: 72, y: 72, width: 200, height: 12 }],
          quote: "A quoted line",
          note: "A note",
          color: "yellow",
          createdAt: "2026-09-18T09:30:00.000Z",
        }],
      }));
    await openAlpha(page);

    for (const toggle of await page.locator(".review-panel-toggle").all()) {
      expect((await box(toggle)).height).toBeGreaterThanOrEqual(44);
    }

    const pinButton = page.getByRole("button", { name: "Note 1" });
    await expect(pinButton).toBeVisible({ timeout: 20_000 });
    const pin = await box(pinButton);
    expect(pin.height).toBeGreaterThan(23.5);
    const nearPin = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("aria-label"),
      { x: pin.left + pin.width / 2, y: pin.top - 8 },
    );
    expect(nearPin).toBe("Note 1");

    await page.getByRole("button", { name: "Notes", exact: true }).click();
    const notes = page.getByRole("region", { name: "Notes" });
    const mine = await box(notes.getByRole("tab", { name: "Your notes" }));
    const review = await box(notes.getByRole("tab", { name: "Saved findings" }));
    expect(mine.height).toBeGreaterThanOrEqual(44);
    expect(review.top).toBe(mine.top);

    for (const name of ["Download notes", "Download PDF"]) {
      const download = await box(notes.getByRole("button", { name }));
      expect(download.height).toBeGreaterThanOrEqual(44);
      expect(download.top).toBeGreaterThanOrEqual(mine.bottom);
    }
    for (const name of ["Edit", "Delete"]) {
      expect((await box(notes.getByRole("button", { name, exact: true }))).height).toBeGreaterThanOrEqual(44);
    }
    expect((await box(notes.getByRole("button", { name: "#1 · p. 1" }))).height).toBeGreaterThanOrEqual(44);

    await page.getByTitle("Chat", { exact: true }).click();
    const copy = page.locator(".chat-drawer .chat-copy");
    await expect(copy).toBeVisible();
    const fit = await copy.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return { text: range.getBoundingClientRect().width, button: element.getBoundingClientRect().width };
    });
    expect(fit.button).toBeGreaterThanOrEqual(fit.text + 20);
  });

  test("gives the paper title the header row and puts the view switch below it", async ({ page }) => {
    await openAlpha(page);
    const title = await box(page.locator(".context-strip-title"));
    const views = await box(page.getByRole("group", { name: "View" }));
    expect(views.top).toBeGreaterThanOrEqual(title.bottom);
    expect(title.width).toBeGreaterThanOrEqual(200);
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Browse code" })).toBeVisible();
  });

  test("hides mute and end voice in the dock while voice is off", async ({ page }) => {
    await openAlpha(page);
    await expect(page.getByTitle("Chat", { exact: true })).toBeVisible();
    await expect(page.getByTitle("Mute mic")).toBeHidden();
    await expect(page.getByTitle("End voice")).toBeHidden();
  });

  test("gives the account terms links touch-size targets", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Account" }).click();
    for (const name of ["Demo Terms", "Privacy Notice"]) {
      expect((await box(page.getByRole("button", { name, exact: true }))).height).toBeGreaterThanOrEqual(44);
    }
    expect((await box(page.getByRole("link", { name: "About Gali" }))).height).toBeGreaterThanOrEqual(44);
  });

  test("gives the demo page touch-size targets and a dock without dead buttons", async ({ page }) => {
    await page.route("**/api/try/title", (route) => route.fulfill({ json: { title: null } }));
    await page.goto("/?try");
    for (const target of [
      page.getByRole("button", { name: "Choose file" }),
      page.getByRole("link", { name: "Join the waitlist for Gali's full agent" }),
      page.getByRole("link", { name: "About", exact: true }),
      page.getByRole("button", { name: "Demo Terms" }),
      page.getByRole("button", { name: "Privacy Notice" }),
    ]) {
      expect((await box(target)).height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByRole("link", { name: "Join the waitlist for Gali's full agent" })).toHaveAttribute("href", "./?waitlist");

    await page.locator('input[type="file"]').first().setInputFiles("e2e/fixtures/sample.pdf");
    const dock = page.getByRole("navigation", { name: "PDF, chat and voice" });
    await expect(dock).toBeVisible({ timeout: 20_000 });
    await expect(dock.getByTitle("Mute mic")).toBeHidden();
    await expect(dock.getByTitle("End voice")).toBeHidden();
    await dock.getByTitle("Chat").click();
    const signIn = page.locator(".try-inline-signin");
    await expect(signIn).toBeVisible();
    await expect(signIn).toHaveText("Join the waitlist");
    await expect(signIn).toHaveAttribute("href", "./?waitlist");
    const link = await box(signIn);
    expect(link.height).toBeGreaterThanOrEqual(44);
    const onEdge = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.classList.contains("try-inline-signin"),
      { x: link.left + link.width / 2, y: link.top + 3 },
    );
    expect(onEdge).toBe(true);
  });
});

test.describe("demo page", () => {
  test("the splitter keeps the default widths, resizes within limits, and hides when stacked", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("**/api/try/title", (route) => route.fulfill({ json: { title: null } }));
    await page.goto("/?try");
    await page.locator('input[type="file"]').first().setInputFiles("e2e/fixtures/sample.pdf");
    const splitter = page.getByRole("separator", { name: "Resize panels" });
    await expect(splitter).toBeVisible({ timeout: 20_000 });
    const source = page.locator(".try-source");
    const side = page.locator(".try-side");

    expect(Math.round((await box(side)).width)).toBe(Math.round(0.42 * (1440 - 57) - 40));
    expect((await box(splitter)).width).toBe(12);

    const grip = await box(splitter);
    const y = grip.top + grip.height / 2;
    await page.mouse.move(grip.left + grip.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(300, y, { steps: 5 });
    await page.mouse.up();
    const narrowPaper = (await box(source)).width;
    expect(narrowPaper).toBeLessThan(300);
    expect((await box(side)).width).toBeGreaterThan(1000);

    const moved = await box(splitter);
    await page.mouse.move(moved.left + moved.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(1430, y, { steps: 5 });
    await page.mouse.up();
    const paper = (await box(source)).width;
    const panel = (await box(side)).width;
    expect(paper / (paper + panel)).toBeCloseTo(0.75, 1);

    await page.setViewportSize({ width: 800, height: 900 });
    await expect(splitter).toBeHidden();
  });
});

test.describe("exhausted trial", () => {
  test.use({ galiTrial: "exhausted" });

  test("says the trial is spent and keeps the papers", async ({ page }) => {
    await page.goto("/");
    await waitForBoot(page);

    const dialog = page.getByRole("dialog", { name: "Your trial is spent" });
    await expect(dialog).toContainText("Your work stays here. Contact us to keep reviewing.");
    await dialog.getByRole("button", { name: "Got it" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Trial spent. Your work stays here.")).toBeVisible();
  });
});
