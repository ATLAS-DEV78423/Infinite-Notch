import type { DroppedFile } from "./bridge";

export type Preparation = {
  id: string;
  name: string;
  state: "preparing" | "ready" | "failed";
  file?: DroppedFile;
  error?: "storage" | "denied" | "invalid";
};

/** One selected file. Original paths never enter display/chat state. */
export class FilePreparation {
  current: Preparation | null = null;

  begin(id: string, name: string): void {
    this.current = { id, name, state: "preparing" };
  }

  complete(id: string, file: DroppedFile): boolean {
    if (this.current?.id !== id || this.current.state !== "preparing") return false;
    this.current = { id, name: file.name, state: "ready", file };
    return true;
  }

  fail(id: string, error: NonNullable<Preparation["error"]>): boolean {
    if (this.current?.id !== id || this.current.state !== "preparing") return false;
    this.current = { id, name: this.current.name, state: "failed", error };
    return true;
  }

  clear(): void { this.current = null; }
}
