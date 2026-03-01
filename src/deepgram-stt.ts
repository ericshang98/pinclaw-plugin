// ── Deepgram STT service for cloud-based speech recognition ──
// Uses Nova-2 model with Chinese (zh) language support via WebSocket streaming.

import { WebSocket } from "ws";

const DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen";

export interface DeepgramSessionOptions {
  language?: string;        // default "zh"
  keywords?: string[];      // e.g. ["Pinclaw:2"]
  onPartial: (text: string, confidence: number) => void;
  onFinal: (text: string, confidence: number) => void;
  onError: (err: Error) => void;
}

export class DeepgramSession {
  private ws: WebSocket | null = null;
  private closed = false;
  private finalText = "";
  private finalConfidence = 0;

  constructor(
    private apiKey: string,
    private options: DeepgramSessionOptions,
    private sampleRate: number = 16000,
    private log: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void },
  ) {
    this.connect();
  }

  private connect(): void {
    const params = new URLSearchParams({
      model: "nova-2",
      language: this.options.language ?? "zh",
      encoding: "linear16",
      sample_rate: String(this.sampleRate),
      channels: "1",
      punctuate: "true",
      smart_format: "true",
      interim_results: "true",
      endpointing: "300",
      utterance_end_ms: "1500",
    });

    if (this.options.keywords?.length) {
      for (const kw of this.options.keywords) {
        params.append("keywords", kw);
      }
    }

    const url = `${DEEPGRAM_WS_URL}?${params.toString()}`;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    this.ws.on("open", () => {
      this.log.info("[deepgram] Session connected");
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "Results") {
          const alt = msg.channel?.alternatives?.[0];
          if (!alt) return;
          const text = alt.transcript ?? "";
          const confidence = alt.confidence ?? 0;
          if (!text) return;

          if (msg.is_final) {
            // Accumulate final segments
            this.finalText += (this.finalText ? " " : "") + text;
            this.finalConfidence = confidence;

            if (msg.speech_final) {
              // Entire utterance done
              this.options.onFinal(this.finalText.trim(), this.finalConfidence);
              this.finalText = "";
              this.finalConfidence = 0;
            }
          } else {
            // Interim result — combine accumulated final + current interim
            const preview = this.finalText ? `${this.finalText} ${text}` : text;
            this.options.onPartial(preview.trim(), confidence);
          }
        }
      } catch (err: any) {
        this.log.warn("[deepgram] Parse error:", err.message);
      }
    });

    this.ws.on("error", (err) => {
      this.log.error("[deepgram] WS error:", err.message);
      if (!this.closed) this.options.onError(err);
    });

    this.ws.on("close", () => {
      this.log.info("[deepgram] Session closed");
      // If we have accumulated final text that wasn't emitted via speech_final, emit now
      if (this.finalText.trim()) {
        this.options.onFinal(this.finalText.trim(), this.finalConfidence);
        this.finalText = "";
      }
    });
  }

  /** Send raw PCM audio chunk (linear16, 16kHz, mono) */
  sendAudio(chunk: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }

  /** Signal end of audio — flush Deepgram buffer */
  finalize(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "Finalize" }));
    }
  }

  /** Clean up */
  close(): void {
    this.closed = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {}
    }
    this.ws?.close();
    this.ws = null;
  }
}

export class DeepgramSTT {
  private apiKey: string;
  private log: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };

  constructor(apiKey: string, log?: { info: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void }) {
    this.apiKey = apiKey;
    this.log = log ?? {
      info: (...args: any[]) => console.log("[deepgram]", ...args),
      warn: (...args: any[]) => console.warn("[deepgram]", ...args),
      error: (...args: any[]) => console.error("[deepgram]", ...args),
    };
  }

  /** Check if the service is configured (has API key) */
  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  /** Create a new live transcription session for a device */
  createSession(options: DeepgramSessionOptions, sampleRate = 16000): DeepgramSession {
    return new DeepgramSession(this.apiKey, options, sampleRate, this.log);
  }
}
