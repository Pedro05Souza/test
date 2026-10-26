import { AsyncLocalStorage } from "node:async_hooks";

/** Tracing fields propagated implicitly to every log line emitted while handling one request/message. */
export interface RequestContextFields {
  correlationId?: string;
  messageId?: string;
  requestId?: string;
}

const storage = new AsyncLocalStorage<RequestContextFields>();

export const RequestContext = {
  run<T>(fields: RequestContextFields, fn: () => T): T {
    return storage.run({ ...fields }, fn);
  },
  get(): RequestContextFields {
    return storage.getStore() ?? {};
  },
};
