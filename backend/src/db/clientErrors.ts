import type pg from "pg";

const states = new WeakMap<pg.PoolClient,{ error?: Error }>();

/** pg removes the pool's idle error listener while a client is checked out. */
export function clientErrorState(client: pg.PoolClient) {
  let state = states.get(client);
  if (!state) {
    state = {};
    states.set(client,state);
    const current = state;
    client.on("error",error => { current.error = error; });
  }
  return state;
}
