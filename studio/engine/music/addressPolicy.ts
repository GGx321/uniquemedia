// The SSRF defence at connect time (invariant 31): an address a CDN host name resolves to is used only when it is a
// public unicast one. The host name passed the pattern check (`cdnPolicy.ts`), but DNS is not ours: a hostile or hijacked
// resolver, or a rebinding trick, can answer a name we allow with the loopback, the LAN, the cloud metadata address or a
// multicast group. This is an ALLOWLIST for IPv6 (global unicast 2000::/3 minus the special ranges inside it) and a
// denylist of every special-purpose block for IPv4, and anything that is not a well-formed address is refused: a text
// this cannot read is never "public". No `node:` import: it is pure arithmetic on the text.

interface Block {
  readonly base: number;
  readonly bits: number;
}

const v4 = (a: number, b: number, c: number, d: number): number => (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);

/** Every IANA special-purpose IPv4 block that is not public unicast, plus multicast and the reserved class E. */
const REFUSED_V4: readonly Block[] = [
  { base: v4(0, 0, 0, 0), bits: 8 }, // "this network"
  { base: v4(10, 0, 0, 0), bits: 8 }, // private
  { base: v4(100, 64, 0, 0), bits: 10 }, // carrier-grade NAT
  { base: v4(127, 0, 0, 0), bits: 8 }, // loopback
  { base: v4(169, 254, 0, 0), bits: 16 }, // link-local, and the cloud metadata address
  { base: v4(172, 16, 0, 0), bits: 12 }, // private
  { base: v4(192, 0, 0, 0), bits: 24 }, // IETF protocol assignments
  { base: v4(192, 0, 2, 0), bits: 24 }, // documentation
  { base: v4(192, 88, 99, 0), bits: 24 }, // 6to4 relay anycast (deprecated)
  { base: v4(192, 168, 0, 0), bits: 16 }, // private
  { base: v4(198, 18, 0, 0), bits: 15 }, // benchmarking
  { base: v4(198, 51, 100, 0), bits: 24 }, // documentation
  { base: v4(203, 0, 113, 0), bits: 24 }, // documentation
  { base: v4(224, 0, 0, 0), bits: 4 }, // multicast
  { base: v4(240, 0, 0, 0), bits: 4 }, // reserved, and the broadcast address
];

/** Four decimal octets, no leading zeros (some resolvers read `010` as octal), each 0 to 255. */
function parseV4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return v4(octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0);
}

function publicV4(address: number): boolean {
  return !REFUSED_V4.some(({ base, bits }) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((address & mask) >>> 0) === base;
  });
}

/** Eight 16-bit groups, or null when the text is not a well-formed IPv6 address (a zone id makes it not one). */
function parseV6(text: string): number[] | null {
  if (text.includes("%") || !/^[0-9a-fA-F:.]+$/.test(text)) return null;
  let head = text;
  let tail: number[] = [];
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) is two groups.
  const lastColon = text.lastIndexOf(":");
  const dotted = text.slice(lastColon + 1);
  if (dotted.includes(".")) {
    const embedded = parseV4(dotted);
    if (embedded === null) return null;
    head = text.slice(0, lastColon + 1);
    tail = [embedded >>> 16, embedded & 0xffff];
    // `::1.2.3.4` leaves `::` in `head`; `a:b:c:d:e:f:1.2.3.4` leaves a trailing single colon to strip.
    if (!head.endsWith("::")) head = head.slice(0, -1);
  }
  const doubled = head.split("::");
  if (doubled.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const before = groups(doubled[0] ?? "");
  if (before === null) return null;
  if (doubled.length === 1) {
    const all = [...before, ...tail];
    return all.length === 8 ? all : null;
  }
  const after = groups(doubled[1] ?? "");
  if (after === null) return null;
  const known = before.length + after.length + tail.length;
  // `::` stands for at least one group of zeros.
  if (known > 7) return null;
  return [...before, ...Array<number>(8 - known).fill(0), ...after, ...tail];
}

const embeddedV4 = (high: number, low: number): number => (((high << 16) | low) >>> 0);

function publicV6(g: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const zeroTo = (n: number): boolean => g.slice(0, n).every((group) => group === 0);
  // IPv4-mapped: judged by the IPv4 address it carries.
  if (zeroTo(5) && g5 === 0xffff) return publicV4(embeddedV4(g6, g7));
  // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d: all inside ::/96, none public.
  if (zeroTo(6)) return false;
  // NAT64 64:ff9b::/96 carries an IPv4 address; the local-use 64:ff9b:1::/48 is never public.
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && publicV4(embeddedV4(g6, g7));
  // 6to4 2002::/16 carries an IPv4 address in the next 32 bits.
  if (g0 === 0x2002) return publicV4(embeddedV4(g1, g2));
  // Everything else must be global unicast, 2000::/3 (this refuses fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64 ...).
  if ((g0 & 0xe000) !== 0x2000) return false;
  // Special ranges inside 2000::/3: the IETF protocol assignments 2001::/23 (Teredo 2001::/32 among them), the
  // documentation blocks 2001:db8::/32 and 3fff::/20.
  if (g0 === 0x2001 && g1 <= 0x01ff) return false;
  if (g0 === 0x2001 && g1 === 0x0db8) return false;
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return false;
  return true;
}

/** Whether `address` (a literal, as a resolver returns it) is a public unicast address. Anything unreadable is not. */
export function isPublicAddress(address: string): boolean {
  if (address.includes(":")) {
    const groups = parseV6(address);
    return groups !== null && publicV6(groups);
  }
  const parsed = parseV4(address);
  return parsed !== null && publicV4(parsed);
}
