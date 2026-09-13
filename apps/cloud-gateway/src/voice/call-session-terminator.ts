import type { CallSession, CallSessionTermination, CallSessionTerminationResult } from "./call-session-do.js";

type SessionNamespace = Pick<DurableObjectNamespace<CallSession>, "idFromName"> & {
  get(id: DurableObjectId): Pick<CallSession, "terminate">;
};

/** The callback recorder invokes this only after the terminal D1 commit. */
export class DurableObjectCallSessionTerminator {
  constructor(private readonly namespace: SessionNamespace) {}

  terminate(input: CallSessionTermination): Promise<CallSessionTerminationResult> {
    const stub = this.namespace.get(this.namespace.idFromName(input.sessionId));
    return stub.terminate(input);
  }
}
