type RequestId = string | number;

export interface ProtocolWriteError {
  code: string;
  message: string;
}

interface Write {
  message: unknown;
  requestId: RequestId | null;
  resolve: () => void;
  reject: (error: ProtocolWriteError) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Serialize native writes without letting a blocked pipe retain later work forever. */
export class ProtocolWriter {
  private queued: Write[] = [];
  private active: Write | null = null;
  private closed: ProtocolWriteError | null = null;
  failure: ProtocolWriteError | null = null;

  constructor(
    private readonly write: (message: unknown) => Promise<void>,
    private readonly onFailure: (error: ProtocolWriteError) => void,
    private readonly timeoutMs = 10_000,
  ) {}

  send(message: unknown): Promise<void> {
    const sending = new Promise<void>((resolve, reject) => {
      if (this.closed) { reject(this.closed); return; }
      const frame = message as { id?: unknown; method?: unknown } | null;
      const id = frame?.id;
      this.queued.push({
        message,
        requestId: typeof frame?.method === "string" && (typeof id === "string" || typeof id === "number") ? id : null,
        resolve,
        reject,
      });
      this.drain();
    });
    // Some providers send notifications without awaiting delivery.
    void sending.catch(() => {});
    return sending;
  }

  /** Only unsent requests can be cancelled locally. In-flight writes need native cleanup. */
  cancel(id: RequestId): boolean {
    const index = this.queued.findIndex((entry) => entry.requestId === id);
    if (index < 0) return false;
    const [entry] = this.queued.splice(index, 1);
    entry.reject({ code: "duckweed_send_cancelled", message: "Message cancelled before delivery." });
    return true;
  }

  /** A provider response proves delivery even if the native IPC callback was lost. */
  acknowledge(id: RequestId): void {
    if (this.active?.requestId === id) this.delivered(this.active);
  }

  close(): void {
    this.discard({ code: "duckweed_closed", message: "Agent connection closed." });
  }

  private drain(): void {
    if (this.closed || this.active) return;
    const entry = this.queued.shift();
    if (!entry) return;
    this.active = entry;
    entry.timer = setTimeout(() => this.fail(entry, {
      code: "duckweed_send_timeout",
      message: "The agent connection stopped accepting messages. Reopen the conversation to reconnect. Your message has been kept.",
    }), this.timeoutMs);
    try {
      void Promise.resolve(this.write(entry.message)).then(
        () => this.delivered(entry),
        (error: unknown) => this.fail(entry, {
          code: "duckweed_send_failed",
          message: `Could not deliver the message to the agent: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    } catch (error: unknown) {
      this.fail(entry, {
        code: "duckweed_send_failed",
        message: `Could not deliver the message to the agent: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private delivered(entry: Write): void {
    if (this.active !== entry || this.closed) return;
    clearTimeout(entry.timer);
    this.active = null;
    entry.resolve();
    this.drain();
  }

  private fail(entry: Write, error: ProtocolWriteError): void {
    if (this.active !== entry || this.closed) return;
    this.failure = error;
    this.discard(error);
    this.onFailure(error);
  }

  private discard(error: ProtocolWriteError): void {
    if (this.closed) return;
    this.closed = error;
    const entries = this.active ? [this.active, ...this.queued] : this.queued;
    this.active = null;
    this.queued = [];
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}
