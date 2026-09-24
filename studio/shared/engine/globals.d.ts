// The shared tsconfig loads no DOM, Node or Bun types, so globals the contract
// relies on are declared here, one by one. Each exists in browsers, Electron's
// Node, utilityProcess and Bun.

/** HTML structured clone: a deep copy of plain data. */
declare function structuredClone<T>(value: T): T;
