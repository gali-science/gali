import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  key: text("key").unique().notNull(),
  title: text("title").notNull(),
  // Relative to the project folder, e.g. "paper/attention.pdf"; null for a project started from a question.
  paperPath: text("paper_path"),
  // Read off the first page by the fast model; null until then, or when the page has none.
  paperTitle: text("paper_title"),
  // The project's one Codex thread; null until the reviewer's first turn.
  reviewThreadId: text("review_thread_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Project = typeof projects.$inferSelect;
