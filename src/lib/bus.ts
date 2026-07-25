/** Tiny typed event bus for cross-component nudges. */

type Events = {
  "pane:search": { leafId: string };
};

type Handler<K extends keyof Events> = (payload: Events[K]) => void;

const handlers = new Map<keyof Events, Set<(payload: never) => void>>();

export function on<K extends keyof Events>(event: K, handler: Handler<K>): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(handler as (payload: never) => void);
  return () => set.delete(handler as (payload: never) => void);
}

export function emit<K extends keyof Events>(event: K, payload: Events[K]): void {
  const set = handlers.get(event);
  if (!set) return;
  for (const handler of [...set]) (handler as Handler<K>)(payload);
}
