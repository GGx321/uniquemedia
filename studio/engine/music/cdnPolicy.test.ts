import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CDN_HOST_PATTERNS, checkCdnUrl, hostForLog } from "./cdnPolicy";
import { cdnHostPatterns, musicLists } from "./fixtures";

// Invariant 31, sources: https only, port 443, a host that matches one of two anchored lowercase patterns at label
// boundaries, no credentials, and anything else refused and named by host only.

const GOOD_FBCDN = "https://instagram.fkiv8-1.fna.fbcdn.net/v/t/track.m4a?oh=1&oe=6ABF5FF1";
const GOOD_CDNINSTAGRAM = "https://scontent-fra3-2.cdninstagram.com/v/t/track.m4a?oh=1&oe=6ABF5FF1";

function reasonOf(raw: string): string {
  const checked = checkCdnUrl(raw);
  return checked.ok ? "accepted" : checked.reason;
}

describe("the two host patterns", () => {
  test("are exactly the ones the 3c.1 fixtures export, so the allowlist and its fixtures cannot drift apart", () => {
    expect(CDN_HOST_PATTERNS.map(String)).toEqual(cdnHostPatterns.map(String));
  });
});

describe("what is accepted", () => {
  test.each([
    ["the fna.fbcdn.net family", GOOD_FBCDN],
    ["the cdninstagram.com family", GOOD_CDNINSTAGRAM],
    ["an explicit port 443 (the default, which a URL drops)", "https://scontent-fra3-1.cdninstagram.com:443/x.m4a"],
    ["an upper-case host, which a URL lowercases", "https://SCONTENT-FRA3-1.CDNINSTAGRAM.COM/x.m4a"],
  ])("%s", (_label, raw) => {
    expect(checkCdnUrl(raw).ok).toBe(true);
  });

  test("every download and cover URL of both 3c.1 lists, so the real hosts of both edges pass", () => {
    let checked = 0;
    for (const fixture of Object.values(musicLists)) {
      const list = JSON.parse(readFileSync(fixture.file, "utf8")) as { response: { items: { track: { progressive_download_url: string; cover_artwork_uri?: string } }[] } };
      for (const { track } of list.response.items) {
        expect(checkCdnUrl(track.progressive_download_url).ok).toBe(true);
        if (track.cover_artwork_uri !== undefined) expect(checkCdnUrl(track.cover_artwork_uri).ok).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(60);
  });

  test("hands back the parsed URL, the one the request must use", () => {
    const checked = checkCdnUrl(GOOD_FBCDN);
    expect(checked.ok && checked.url.hostname).toBe("instagram.fkiv8-1.fna.fbcdn.net");
  });
});

describe("what is refused, at label boundaries", () => {
  test.each([
    ["a suffix match without the dot", "https://evilcdninstagram.com/x"],
    ["the allowed name as a prefix of another host", "https://scontent-fra3-1.cdninstagram.com.evil.example/x"],
    ["the allowed name as a subdomain of another host", "https://evil.example/scontent-fra3-1.cdninstagram.com"],
    ["an extra label in front", "https://x.scontent-fra3-1.cdninstagram.com/x"],
    ["a glued prefix", "https://xscontent-fra3-1.cdninstagram.com/x"],
    ["a trailing dot (a different name to a resolver)", "https://scontent-fra3-1.cdninstagram.com./x"],
    ["the other family with a glued prefix", "https://xinstagram.fkiv8-1.fna.fbcdn.net/x"],
    ["the other family with a foreign parent", "https://instagram.fkiv8-1.fna.fbcdn.net.evil.example/x"],
    ["the bare parent domain", "https://cdninstagram.com/x"],
    ["an unrelated Facebook CDN host", "https://scontent.xx.fbcdn.net/x"],
    ["a different shard shape (no dash number)", "https://scontent-fra3.cdninstagram.com/x"],
    ["an underscore in the shard label", "https://scontent-fra_3-1.cdninstagram.com/x"],
    ["a punycode lookalike", "https://xn--80ak6aa92e.cdninstagram.com/x"],
  ])("%s", (_label, raw) => {
    expect(reasonOf(raw)).toBe("host");
  });

  test.each([
    ["an IPv4 literal", "https://127.0.0.1/x"],
    ["a private IPv4 literal", "https://10.0.0.5/x"],
    ["an IPv6 literal", "https://[::1]/x"],
    ["a decimal IPv4", "https://2130706433/x"],
    ["a hex IPv4", "https://0x7f000001/x"],
    ["localhost", "https://localhost/x"],
  ])("%s", (_label, raw) => {
    expect(reasonOf(raw)).toBe("host");
  });

  test("a userinfo trick: the allowed name before an @ is a user name, and the host after it is what counts", () => {
    expect(checkCdnUrl("https://scontent-fra3-1.cdninstagram.com@evil.example/x").ok).toBe(false);
  });

  test("a backslash trick: everything before the backslash's slash is the host", () => {
    expect(checkCdnUrl("https://evil.example\\@scontent-fra3-1.cdninstagram.com/x").ok).toBe(false);
  });
});

describe("what is refused apart from the host", () => {
  test.each([
    ["http", "http://scontent-fra3-1.cdninstagram.com/x", "scheme"],
    ["ftp", "ftp://scontent-fra3-1.cdninstagram.com/x", "scheme"],
    ["file", "file:///etc/passwd", "scheme"],
    ["data", "data:audio/mp4;base64,AAAA", "scheme"],
    ["a scheme-relative URL", "//scontent-fra3-1.cdninstagram.com/x", "unparseable"],
    ["a relative path", "/v/t/track.m4a", "unparseable"],
    ["an empty string", "", "unparseable"],
    ["credentials", "https://user:pw@scontent-fra3-1.cdninstagram.com/x", "credentials"],
    ["a user name alone", "https://user@scontent-fra3-1.cdninstagram.com/x", "credentials"],
    ["port 8443", "https://scontent-fra3-1.cdninstagram.com:8443/x", "port"],
    ["port 80", "https://scontent-fra3-1.cdninstagram.com:80/x", "port"],
    ["port 444", "https://scontent-fra3-1.cdninstagram.com:444/x", "port"],
  ] as const)("%s", (_label, raw, reason) => {
    expect(reasonOf(raw)).toBe(reason);
  });

  test("a URL longer than 4096 chars", () => {
    expect(reasonOf(`https://scontent-fra3-1.cdninstagram.com/${"a".repeat(4100)}`)).toBe("unparseable");
  });
});

describe("what a refusal says", () => {
  test("names only the host: never the path, the query or the signature", () => {
    const checked = checkCdnUrl("https://evil.example/secret/track.m4a?oh=SIGNATURE&oe=1");
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.host).toBe("evil.example");
    expect(JSON.stringify(checked)).not.toContain("SIGNATURE");
    expect(JSON.stringify(checked)).not.toContain("secret");
  });

  test("hostForLog of something that is not a URL is a fixed word, not the text", () => {
    expect(hostForLog("not a url with SIGNATURE")).toBe("(unparseable)");
  });

  test("hostForLog cuts a long host and drops control characters and bidi marks", () => {
    const host = hostForLog(`https://${"a".repeat(300)}.example/x`);
    expect(host.length).toBeLessThanOrEqual(80);
    expect(hostForLog("https://ex‮ample.test/")).not.toMatch(/[‮\u0000-\u001f]/);
  });
});
