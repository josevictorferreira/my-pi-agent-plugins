import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { type LspServerConfig, languageIdFor } from "./servers";

export interface Position {
  line: number;
  character: number;
}

export interface Diagnostic {
  range: { start: Position; end: Position };
  /** 1 = Error, 2 = Warning, 3 = Information, 4 = Hint. */
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DiagnosticsEntry {
  diagnostics: Diagnostic[];
  /** Value of `touchSeq` when the publish arrived — used to spot stale pushes. */
  seq: number;
  at: number;
}

const INITIALIZE_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 10000;
const DIAGNOSTICS_TIMEOUT_MS = 3000;
/** Servers like tsserver publish several times per change; take the last one. */
const DIAGNOSTICS_SETTLE_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export function fileUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

/**
 * One language server process, spoken to over stdio with hand-rolled
 * `Content-Length` framing (pi ships no JSON-RPC dependency and extensions
 * here carry no `node_modules`).
 *
 * Only what the extension needs: initialize, file sync, push diagnostics and
 * plain requests. No pull diagnostics, no dynamic capability registration, no
 * restart-on-crash.
 */
export class LspClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private versions = new Map<string, number>();
  private diagnostics = new Map<string, DiagnosticsEntry>();
  private touchSeq = 0;
  private dead = false;

  private constructor(
    readonly config: LspServerConfig,
    readonly root: string,
    private readonly child: ChildProcess,
  ) {
    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    // Servers chat on stderr; draining keeps the pipe from filling up.
    child.stderr?.resume();
    child.on("error", () => this.markDead("LSP process error"));
    child.on("exit", () => this.markDead("LSP process exited"));
  }

  get id(): string {
    return this.config.id;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get isAlive(): boolean {
    return !this.dead;
  }

  /** Spawn and initialize. Throws when the process dies or times out. */
  static async start(config: LspServerConfig, root: string): Promise<LspClient> {
    const child = spawn(config.command[0]!, config.command.slice(1), {
      cwd: root,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const client = new LspClient(config, root, child);
    try {
      await client.initialize();
    } catch (err) {
      client.dispose();
      throw err;
    }
    return client;
  }

  private async initialize(): Promise<void> {
    const uri = fileUri(this.root);
    await this.request(
      "initialize",
      {
        processId: process.pid,
        rootPath: this.root,
        rootUri: uri,
        workspaceFolders: [{ uri, name: basename(this.root) }],
        initializationOptions: this.config.initialization ?? {},
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            publishDiagnostics: { relatedInformation: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
          workspace: {
            workspaceFolders: true,
            configuration: true,
            symbol: {},
          },
        },
      },
      INITIALIZE_TIMEOUT_MS,
    );

    this.notify("initialized", {});
    if (this.config.initialization) {
      this.notify("workspace/didChangeConfiguration", { settings: this.config.initialization });
    }
  }

  // --- Wire protocol --------------------------------------------------------

  private send(message: unknown): void {
    if (this.dead) return;
    const stdin = this.child.stdin;
    if (!stdin || !stdin.writable) return;
    const body = Buffer.from(JSON.stringify(message), "utf-8");
    stdin.write("Content-Length: " + body.length + "\r\n\r\n");
    stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unparseable header: drop it and resync on the next frame.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;

      const body = this.buffer.subarray(start, start + length).toString("utf-8");
      this.buffer = this.buffer.subarray(start + length);
      try {
        this.handle(JSON.parse(body));
      } catch {
        // Malformed message — ignore, the server keeps talking.
      }
    }
  }

  private handle(message: any): void {
    if (message?.method !== undefined && message?.id !== undefined) {
      this.respond(message.id, message.method, message.params);
      return;
    }
    if (message?.method !== undefined) {
      this.handleNotification(message.method, message.params);
      return;
    }
    if (message?.id === undefined) return;

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "LSP request failed"));
    } else {
      pending.resolve(message.result ?? null);
    }
  }

  /**
   * Server-to-client requests. Configuration is answered from the server's
   * `initialization` options; everything else is acked with `null` so the
   * server does not block waiting on us.
   */
  private respond(id: unknown, method: string, params: any): void {
    let result: unknown = null;
    if (method === "workspace/configuration") {
      const items = Array.isArray(params?.items) ? params.items : [];
      result = items.map(() => this.config.initialization ?? {});
    }
    this.send({ jsonrpc: "2.0", id, result });
  }

  private handleNotification(method: string, params: any): void {
    if (method !== "textDocument/publishDiagnostics") return;
    const uri = params?.uri;
    if (typeof uri !== "string") return;
    this.diagnostics.set(uri, {
      diagnostics: Array.isArray(params.diagnostics) ? params.diagnostics : [],
      seq: this.touchSeq,
      at: Date.now(),
    });
  }

  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  // --- Public surface -------------------------------------------------------

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error("LSP server " + this.id + " is not running"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("LSP request " + method + " timed out after " + timeoutMs + "ms"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Open the file (first touch) or resend its full text, straight from disk. */
  async touchFile(absolutePath: string): Promise<void> {
    if (this.dead) return;
    let text: string;
    try {
      text = await readFile(absolutePath, "utf-8");
    } catch {
      return;
    }

    const uri = fileUri(absolutePath);
    this.touchSeq++;
    const version = this.versions.get(uri);
    if (version === undefined) {
      this.versions.set(uri, 0);
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: languageIdFor(absolutePath), version: 0, text },
      });
    } else {
      const next = version + 1;
      this.versions.set(uri, next);
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: next },
        contentChanges: [{ text }],
      });
    }
  }

  /**
   * Diagnostics published for `uri` after the most recent `touchFile`, once
   * pushes have settled. Empty when the server stays silent — a missing
   * answer must never hold up a tool result.
   */
  async waitForDiagnostics(uri: string, timeoutMs = DIAGNOSTICS_TIMEOUT_MS): Promise<Diagnostic[]> {
    const seq = this.touchSeq;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline && !this.dead) {
      const entry = this.diagnostics.get(uri);
      if (entry && entry.seq === seq) {
        let stamp = entry.at;
        while (Date.now() < deadline) {
          await sleep(DIAGNOSTICS_SETTLE_MS);
          const latest = this.diagnostics.get(uri);
          if (!latest || latest.at === stamp) break;
          stamp = latest.at;
        }
        return this.diagnostics.get(uri)?.diagnostics ?? [];
      }
      await sleep(25);
    }
    return [];
  }

  /** Last diagnostics published for a file, regardless of age. */
  getDiagnostics(uri: string): Diagnostic[] {
    return this.diagnostics.get(uri)?.diagnostics ?? [];
  }

  dispose(): void {
    this.markDead("LSP client disposed");
    try {
      this.child.kill();
    } catch {
      // Already gone.
    }
  }
}
