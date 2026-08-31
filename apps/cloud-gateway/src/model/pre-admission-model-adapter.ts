import {
  isModelProviderNotStartedError,
  ModelAdapterError,
  snapshotModelAdapterStreamInput,
  type ModelAdapter,
  type ModelAdapterStreamInput,
  type ModelToken,
} from "./model-adapter.js";

export type HermesPreAdmissionState =
  | "disabled"
  | "ready"
  | "readiness_circuit_open";

export interface PreAdmissionModelAdapterOptions {
  readonly direct: ModelAdapter;
  readonly hermes: ModelAdapter;
  readonly hermesState: () => HermesPreAdmissionState | Promise<HermesPreAdmissionState>;
}

/** Selects the local Hermes sidecar only before a voice admission has begun. */
export class PreAdmissionModelAdapter implements ModelAdapter {
  constructor(private readonly options: PreAdmissionModelAdapterOptions) {}

  stream(inputValue: ModelAdapterStreamInput): AsyncIterable<ModelToken> {
    const input = snapshotModelAdapterStreamInput(inputValue);
    if (input.channel !== "voice") return this.options.direct.stream(input);
    return this.streamVoice(input);
  }

  private async *streamVoice(input: Readonly<ModelAdapterStreamInput>): AsyncIterable<ModelToken> {
    let state: HermesPreAdmissionState;
    try { state = await this.options.hermesState(); }
    catch { yield* this.options.direct.stream(input); return; }
    if (state !== "ready") {
      yield* this.options.direct.stream(input);
      return;
    }

    let iterator: AsyncIterator<ModelToken>;
    try {
      const iterable = this.options.hermes.stream(input);
      iterator = iterable[Symbol.asyncIterator]();
    }
    catch (error) {
      if (isModelProviderNotStartedError(error)) {
        yield* this.options.direct.stream(input);
        return;
      }
      throw error;
    }
    let tokenObserved = false;
    let completed = false;
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (typeof iterator.return !== "function") throw new ModelAdapterError("model_protocol_invalid");
      const result = await iterator.return();
      try {
        if (result === null || typeof result !== "object" || Array.isArray(result) || result.done !== true) {
          throw new ModelAdapterError("model_protocol_invalid");
        }
      } catch (error) {
        if (error instanceof ModelAdapterError) throw error;
        throw new ModelAdapterError("model_protocol_invalid");
      }
    };
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          completed = true;
          return;
        }
        tokenObserved = true;
        yield next.value;
      }
    } catch (error) {
      if (!tokenObserved && isModelProviderNotStartedError(error)) {
        await close();
        yield* this.options.direct.stream(input);
        return;
      }
      try { await close(); }
      catch { /* A cleanup failure must not replace the primary Hermes outcome. */ }
      throw error;
    } finally {
      if (!completed && !closed) await close();
    }
  }
}
