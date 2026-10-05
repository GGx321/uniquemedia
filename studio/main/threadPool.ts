// Side-effect module: the FIRST import of main.ts, so it runs before main's own top level and its first file, DNS or crypto call. In the built bundle the
// shared chunks and `electron` load before it; that is safe only while their top level stays inert (no file, DNS or crypto call at load).
//
// libuv runs every file, `getaddrinfo` (the OpenRouter and flashapi hosts) and crypto call of the process on a pool of four threads, made when it is first used
// and sized by `UV_THREADPOOL_SIZE` at that moment. The media protocol's disk work is bounded to a few of them (mediaProtocol.ts), but a library and an export
// folder on shares that stopped answering would still hold three of the four and leave main one for settings, keys and the network. So the pool is made bigger.
// Measured on Electron 43: eight parallel pbkdf2 took 2.0 times one with the default pool and 1.15 times one with the variable set on the entry's first line.

/** Threads in the pool. */
export const THREADPOOL_SIZE = 8;
/** The threads main must keep for settings, keys, DNS and crypto when every media slot is held by a dead share. */
export const MAIN_RESERVED_THREADS = 4;

// An owner who asked for more keeps it.
const asked = Number(process.env.UV_THREADPOOL_SIZE);
if (!(Number.isInteger(asked) && asked >= THREADPOOL_SIZE)) process.env.UV_THREADPOOL_SIZE = String(THREADPOOL_SIZE);
