import { z } from "zod";

// Imported first by main.tsx: zod decides at schema construction time whether
// it may compile parsers with `new Function`. The window's CSP has no
// 'unsafe-eval', so that probe would log a CSP violation; jitless skips it.
z.config({ jitless: true });
