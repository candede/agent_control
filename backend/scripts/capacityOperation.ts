import { AsyncLocalStorage } from "node:async_hooks";

const operation = new AsyncLocalStorage<string>();
export const capacityOperation = <T>(name: string, work: () => Promise<T>) => operation.run(name, work);
export const currentCapacityOperation = () => operation.getStore();
