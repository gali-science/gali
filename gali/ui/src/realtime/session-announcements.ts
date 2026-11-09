export type BackgroundKind = "finished" | "info";

export type BackgroundEntry = {
  text: string;
  itemSent: boolean;
  itemId: string;
  /** The project the update is about, so a newer one can purge it. */
  topic: string | null;
  kind: BackgroundKind;
  heard?: boolean;
};
