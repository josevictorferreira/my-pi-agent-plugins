import { MAX_OBS_BYTES, MAX_OBS_LINES, readWindow } from "./executor";

// The paper's environments have a sufficient statistic the model can write into
// Σ (shelf contents, a flag). Source code does not: the statistic a patch needs
// is the exact text, and models cannot carry that in facts. One run read the
// same 8-line model and its 11-line spec alternately for 11 steps because it
// could see only one of them at a time, and later re-read one 44-line file
// twelve times (22 re-reads in 54 steps). So the runtime keeps the last files
// the model read or wrote "open": their current text (re-read from disk every
// step, so a patch shows up at once) is part of every prompt, bounded like an
// observation. Σ still holds everything else; this is the one fact type the
// runtime records because the model cannot.

/** A read_file window the runtime keeps showing with its current contents. */
export interface OpenWindow {
  path: string;
  offset?: number;
  limit?: number;
  /** Step at which the file was last read or written. */
  step: number;
  /** Line range last shown for it and the file's line count, set when rendered. */
  start?: number;
  end?: number;
  total?: number;
}

// Four, not two: with two slots a run rotating through a spec and the two
// models it compared thrashed the window and re-read all three for 15 steps.
// The byte cap, not the count, is what bounds the prompt.
export const MAX_OPEN_FILES = 4;
export const MAX_OPEN_BYTES = MAX_OBS_BYTES;

/**
 * Whether a requested read_file window lies inside the range `shown` already
 * displays. Same path and identical offset/limit is the obvious case; a run
 * also asked for lines 1-30, 1-50 and 1-100 of a 44-line file in turn, and for
 * 40-50 of a file shown whole, so the comparison is on effective line ranges.
 */
export function covers(shown: OpenWindow, wanted: { path: string; offset?: number; limit?: number }): boolean {
  if (shown.path !== wanted.path || shown.start === undefined || shown.end === undefined || shown.total === undefined) return false;
  const start = Math.max(1, wanted.offset ?? 1);
  const end = Math.min(shown.total, start + (wanted.limit ?? MAX_OBS_LINES) - 1);
  return start >= shown.start && end <= shown.end;
}

/**
 * Record a read or a write: one window per path, most recent first, at most
 * MAX_OPEN_FILES. A write keeps the window the path already had, so a patch in
 * the middle of a long file does not scroll the view back to line 1.
 */
export function noteOpen(
  open: OpenWindow[],
  path: string,
  step: number,
  window?: { offset?: number; limit?: number; start: number; end: number; total: number },
): void {
  const index = open.findIndex((o) => o.path === path);
  const previous = index === -1 ? undefined : open.splice(index, 1)[0];
  open.unshift(window ? { path, step, ...window } : { path, step, offset: previous?.offset, limit: previous?.limit });
  while (open.length > MAX_OPEN_FILES) open.pop();
}

export interface OpenFilesView {
  text: string;
  /** The windows whose text is in `text`. */
  shown: OpenWindow[];
}

/**
 * Current text of the open windows, most recent first, within MAX_OPEN_BYTES.
 * `except` is the window whose text is already the latest observation. A file
 * that no longer exists is dropped from the list. Each rendered window's line
 * range is recorded on it, for `covers`.
 */
export async function renderOpenFiles(cwd: string, open: OpenWindow[], except?: OpenWindow): Promise<OpenFilesView> {
  const parts: string[] = [];
  const shown: OpenWindow[] = [];
  let bytes = 0;
  for (const window of [...open]) {
    if (window === except) continue;
    let read;
    try {
      read = await readWindow(cwd, window.path, window.offset, window.limit);
    } catch {
      open.splice(open.indexOf(window), 1);
      continue;
    }
    const size = Buffer.byteLength(read.text);
    if (parts.length && bytes + size > MAX_OPEN_BYTES) break;
    window.start = read.start;
    window.end = read.end;
    window.total = read.total;
    parts.push(read.text);
    shown.push(window);
    bytes += size;
  }
  return { text: parts.join("\n\n"), shown };
}
