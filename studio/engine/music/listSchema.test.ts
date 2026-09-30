import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { musicLists } from "./fixtures";
import { MAX_LISTED_TRACKS, parseFlashapiList, type ListParse } from "./listSchema";
import { signedUrlExpiresAtMs } from "./signedUrl";

// SP5's lenient schema: only `track.id` is required; every other field is optional and a wrongly typed one reads as
// absent; unknown keys are ignored; URLs must be https; the open string fields are never enums; a track with no
// download URL or no duration is dropped. The real list responses of 3c.1 are the input.

interface Fixture {
  fetchedAt: string;
  quota: { remaining: string; limit: string };
  response: unknown;
}
const fixture = (which: keyof typeof musicLists): Fixture => JSON.parse(readFileSync(musicLists[which].file, "utf8")) as Fixture;

const DL = "https://scontent-fra3-1.cdninstagram.com/o1/v/t2/f2/m86/AQ.mp4?oe=68DC1E2F&oh=00_x";

/** A body with the given raw items. */
const body = (...items: unknown[]) => ({ status: "ok", items });
const item = (track: Record<string, unknown>, metadata?: Record<string, unknown>) => ({ track, ...(metadata === undefined ? {} : { metadata }) });
/** A track that survives: an id, a full download URL and a duration. */
const good = (extra: Record<string, unknown> = {}) => ({ id: "1395615172492847", progressive_download_url: DL, duration_in_ms: 157412, ...extra });

function parsed(input: unknown): Extract<ListParse, { ok: true }> {
  const result = parseFlashapiList(input);
  if (!result.ok) throw new Error(`expected a parse, got ${result.reason}`);
  return result;
}

describe("the real lists", () => {
  test.each(["kyiv", "frankfurt"] as const)("the %s list parses whole: 30 items, every one a track", (which) => {
    const list = parsed(fixture(which).response);
    expect(list.observed.itemCount).toBe(30);
    expect(list.tracks).toHaveLength(30);
    expect(list.dropped).toEqual([]);
  });

  test.each(["kyiv", "frankfurt"] as const)("the %s list's explicit count is the one 3c.1 pinned", (which) => {
    const list = parsed(fixture(which).response);
    expect(list.tracks.filter((t) => t.explicit)).toHaveLength(musicLists[which].explicitCount);
    expect(list.observed.explicitCount).toBe(musicLists[which].explicitCount);
  });

  test.each(["kyiv", "frankfurt"] as const)("the %s list: every download URL is https on the host 3c.1 recorded", (which) => {
    const list = parsed(fixture(which).response);
    const hosts = new Set(list.tracks.map((t) => new URL(t.downloadUrl).hostname));
    const expected: readonly string[] = musicLists[which].downloadHosts;
    for (const host of hosts) expect(expected).toContain(host);
    for (const track of list.tracks) expect(new URL(track.downloadUrl).protocol).toBe("https:");
  });

  test.each(["kyiv", "frankfurt"] as const)("the %s list: each track expires 100 to 110 hours after the response (SP5: 104 to 108)", (which) => {
    const { fetchedAt, response } = fixture(which);
    for (const track of parsed(response).tracks) {
      const expires = signedUrlExpiresAtMs(track.downloadUrl);
      expect(expires).not.toBeNull();
      const hours = ((expires ?? 0) - Date.parse(fetchedAt)) / 3_600_000;
      expect(hours).toBeGreaterThan(100);
      expect(hours).toBeLessThan(110);
    }
  });

  test("the highlights arrive as the server sent them, unsorted (sorting is the store's, 3c.4)", () => {
    const unsorted = parsed(fixture("kyiv").response).tracks.filter((t) => t.highlightsMs.some((v, i, all) => i > 0 && v < (all[i - 1] ?? 0)));
    expect(unsorted.length).toBeGreaterThan(0);
  });

  test("the dash manifest is never carried into a track", () => {
    const text = JSON.stringify(parsed(fixture("kyiv").response).tracks);
    expect(text).not.toContain("MPD");
    expect(text).not.toContain("dash_manifest");
    expect(text).not.toContain("web_30s_preview");
  });

  test("the distinct monetization and subtype values are observed, as the open strings they are", () => {
    const { observed } = parsed(fixture("kyiv").response);
    expect(observed.monetizationValues).toContain("REVSHARE");
    expect(observed.subtypeValues).toContain("DEFAULT");
  });

  test.each(["kyiv", "frankfurt"] as const)("the %s list holds no key the SP5 sample did not already have", (which) => {
    const { observed } = parsed(fixture(which).response);
    expect(observed.unknownTrackKeys).toEqual([]);
    expect(observed.unknownMetadataKeys).toEqual([]);
    expect(observed.unknownTopLevelKeys).toEqual([]);
  });

  test("a key the sample never had is reported by name (top level, track, metadata) and never reaches a track", () => {
    const list = parsed({ status: "ok", brand_new: 1, items: [item(good({ shiny_new_field: "x" }), { another_new: 2 })] });
    expect(list.observed.unknownTrackKeys).toEqual(["shiny_new_field"]);
    expect(list.observed.unknownMetadataKeys).toEqual(["another_new"]);
    expect(list.observed.unknownTopLevelKeys).toEqual(["brand_new"]);
    expect(JSON.stringify(list.tracks)).not.toContain("shiny_new_field");
  });

  test("a track holds exactly the fields the schema keeps", () => {
    const { tracks } = parsed(fixture("kyiv").response);
    expect(Object.keys(tracks[0] ?? {}).sort()).toEqual(
      ["artist", "coverUrl", "downloadUrl", "durationMs", "explicit", "highlightsMs", "licensedSubtype", "monetization", "title", "trackId"].sort(),
    );
  });

  test("the origins of every URL in the list are observed (scheme and host, never a path or query)", () => {
    const { observed } = parsed(fixture("kyiv").response);
    expect(observed.urlOrigins).toContain("https://instagram.fkiv8-1.fna.fbcdn.net");
    for (const origin of observed.urlOrigins) expect(origin).not.toContain("?");
  });

  test("page_info is observed, and there is no second page request", () => {
    expect(parsed(fixture("kyiv").response).observed.pageInfo).toEqual({ nextMaxId: "30", moreAvailable: true });
  });
});

describe("the id", () => {
  test("a numeric id becomes its decimal string", () => {
    expect(parsed(body(item(good({ id: 4199287736976977 })))).tracks[0]?.trackId).toBe("4199287736976977");
  });

  test("a string id is kept, trimmed", () => {
    expect(parsed(body(item(good({ id: " 4199287736976977 "})))).tracks[0]?.trackId).toBe("4199287736976977");
  });

  test.each([
    ["missing", undefined],
    ["null", null],
    ["an empty string", ""],
    ["a blank string", "   "],
    ["a fractional number", 1234567.5],
    ["a negative number", -12345678],
    ["a number past 2^53, which JSON already rounded", 9007199254740993],
    ["an object", { a: 1 }],
    ["a boolean", true],
  ])("an id that is %s drops the track as no-id", (_label, id) => {
    const track = good();
    Reflect.deleteProperty(track, "id");
    const list = parsed(body(item({ ...track, ...(id === undefined ? {} : { id }) })));
    expect(list.tracks).toEqual([]);
    expect(list.dropped).toEqual([{ index: 0, reason: "no-id" }]);
  });

  test.each([
    ["shorter than 8 chars", "12345"],
    ["with uppercase", "ABCD1234EFGH"],
    ["with a path character", "../../etc/passwd"],
    ["longer than 64 chars", "1".repeat(65)],
  ])("an id %s cannot be a montage's trackId, so the track is dropped as id-unusable", (_label, id) => {
    expect(parsed(body(item(good({ id })))).dropped).toEqual([{ index: 0, reason: "id-unusable" }]);
  });

  test("a second track with the same id (a string and a number alike) is dropped as duplicate-id", () => {
    const list = parsed(body(item(good({ id: 4199287736976977 })), item(good({ id: "4199287736976977" }))));
    expect(list.tracks).toHaveLength(1);
    expect(list.dropped).toEqual([{ index: 1, reason: "duplicate-id" }]);
  });
});

describe("only the id is required, and a track without a download URL or a duration is dropped", () => {
  test("a track with the id alone is dropped for its missing download URL, without an error", () => {
    const list = parsed(body(item({ id: "1395615172492847" })));
    expect(list.tracks).toEqual([]);
    expect(list.dropped).toEqual([{ index: 0, reason: "no-download-url" }]);
  });

  test("a track with a URL and a duration and nothing else survives, with everything else empty", () => {
    const list = parsed(body(item({ id: "1395615172492847", progressive_download_url: DL, duration_in_ms: 1000 })));
    expect(list.tracks).toEqual([
      { trackId: "1395615172492847", title: null, artist: null, durationMs: 1000, explicit: false, highlightsMs: [], downloadUrl: DL, coverUrl: null, monetization: null, licensedSubtype: null },
    ]);
  });

  test("a track without a duration is dropped as no-duration", () => {
    expect(parsed(body(item({ id: "1395615172492847", progressive_download_url: DL }))).dropped).toEqual([{ index: 0, reason: "no-duration" }]);
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["null", null],
    ["a string", "157412"],
    ["past a day", 24 * 3600 * 1000 + 1],
    ["an array", [1]],
  ])("a duration that is %s drops the track as no-duration", (_label, duration) => {
    expect(parsed(body(item(good({ duration_in_ms: duration })))).dropped).toEqual([{ index: 0, reason: "no-duration" }]);
  });

  test("a fractional duration is rounded to a whole ms; one ms and a whole day are accepted", () => {
    expect(parsed(body(item(good({ duration_in_ms: 1000.6 })))).tracks[0]?.durationMs).toBe(1001);
    expect(parsed(body(item(good({ duration_in_ms: 1 })))).tracks).toHaveLength(1);
    expect(parsed(body(item(good({ duration_in_ms: 24 * 3600 * 1000 })))).tracks).toHaveLength(1);
  });
});

describe("URLs must be https", () => {
  test.each([
    ["http", "http://scontent-fra3-1.cdninstagram.com/a.mp4"],
    ["a protocol-relative URL", "//scontent-fra3-1.cdninstagram.com/a.mp4"],
    ["javascript:", "javascript:alert(1)"],
    ["file:", "file:///etc/passwd"],
    ["data:", "data:audio/mp4;base64,AAAA"],
    ["a URL with credentials", "https://user:pass@scontent-fra3-1.cdninstagram.com/a.mp4"],
    ["not a URL at all", "not a url"],
    ["a relative path", "/o1/v/t2/a.mp4"],
    ["an https URL over 4096 chars", `https://scontent-fra3-1.cdninstagram.com/${"a".repeat(4100)}`],
  ])("a download URL that is %s drops the track as insecure-download-url", (_label, url) => {
    expect(parsed(body(item(good({ progressive_download_url: url })))).dropped).toEqual([{ index: 0, reason: "insecure-download-url" }]);
  });

  test.each([["a number", 5], ["null", null], ["an empty string", ""], ["an object", {}]])("a download URL that is %s drops the track as no-download-url", (_label, url) => {
    expect(parsed(body(item(good({ progressive_download_url: url })))).dropped).toEqual([{ index: 0, reason: "no-download-url" }]);
  });

  test("a cover URL that is not https leaves the track without a cover; the track stays", () => {
    const list = parsed(body(item(good({ cover_artwork_uri: "http://scontent-fra3-1.cdninstagram.com/c.jpg" }))));
    expect(list.tracks[0]?.coverUrl).toBeNull();
  });

  test("an https cover URL is kept", () => {
    const cover = "https://scontent-fra3-1.cdninstagram.com/c.jpg?oe=68DC1E2F";
    expect(parsed(body(item(good({ cover_artwork_uri: cover })))).tracks[0]?.coverUrl).toBe(cover);
  });

  test("the preview URL is never taken, whatever it holds", () => {
    const list = parsed(body(item(good({ web_30s_preview_download_url: "https://scontent-fra3-1.cdninstagram.com/p.mp4" }))));
    expect(JSON.stringify(list.tracks)).not.toContain("p.mp4");
  });
});

describe("every other field is optional, and a wrongly typed one reads as absent", () => {
  test("wrong types everywhere still leave the track alive", () => {
    const list = parsed(
      body(
        item(
          good({
            title: 5,
            display_artist: ["x"],
            highlight_start_times_in_ms: "soon",
            is_explicit: "yes",
            song_monetization_info: 3,
            licensed_music_subtype: {},
            cover_artwork_uri: 7,
          }),
          { is_trending_in_clips: "sometimes" },
        ),
      ),
    );
    expect(list.tracks[0]).toMatchObject({ title: null, artist: null, highlightsMs: [], explicit: false, monetization: null, licensedSubtype: null, coverUrl: null });
  });

  test("only a true is_explicit is explicit", () => {
    for (const value of [1, "true", "TRUE", null, 0, false]) expect(parsed(body(item(good({ is_explicit: value })))).tracks[0]?.explicit).toBe(false);
    expect(parsed(body(item(good({ is_explicit: true })))).tracks[0]?.explicit).toBe(true);
  });

  test("song_monetization_info and licensed_music_subtype are open strings, never enums", () => {
    const list = parsed(body(item(good({ song_monetization_info: "SOMETHING_NEW_2027", licensed_music_subtype: "WHATEVER" }))));
    expect(list.tracks[0]).toMatchObject({ monetization: "SOMETHING_NEW_2027", licensedSubtype: "WHATEVER" });
    expect(list.observed.monetizationValues).toEqual(["SOMETHING_NEW_2027"]);
  });

  test("the highlights keep the server's order and only whole, non-negative numbers", () => {
    const list = parsed(body(item(good({ highlight_start_times_in_ms: [30000, 1500, -1, 2.5, "x", null, 0, 12000] }))));
    expect(list.tracks[0]?.highlightsMs).toEqual([30000, 1500, 0, 12000]);
  });

  test("the highlights are bounded at 64", () => {
    const many = Array.from({ length: 200 }, (_, i) => i * 1000);
    expect(parsed(body(item(good({ highlight_start_times_in_ms: many })))).tracks[0]?.highlightsMs).toHaveLength(64);
  });

  test("a title is trimmed, stripped of control characters and cut to 120 characters; an empty one is absent", () => {
    const title = parsed(body(item(good({ title: `  A\u0000B‮c\n${"x".repeat(200)}  ` })))).tracks[0]?.title ?? "";
    expect(title.startsWith("AB")).toBe(true);
    expect(title).not.toMatch(/[\u0000-\u001f]/);
    expect([...title].length).toBe(120);
    expect(parsed(body(item(good({ title: "   " })))).tracks[0]?.title).toBeNull();
  });

  test("a title is cut on a character boundary, never in the middle of a surrogate pair", () => {
    const title = parsed(body(item(good({ title: "😀".repeat(130) })))).tracks[0]?.title ?? "";
    expect([...title]).toHaveLength(120);
    expect(title).toBe("😀".repeat(120));
  });

  test("the artist is the display_artist, never the uploader's ig_username", () => {
    const list = parsed(body(item(good({ display_artist: "Mafia In House", ig_username: "someone" }))));
    expect(list.tracks[0]?.artist).toBe("Mafia In House");
    expect(parsed(body(item(good({ ig_username: "someone" })))).tracks[0]?.artist).toBeNull();
  });
});

describe("the body and the items", () => {
  test.each([
    ["null", null],
    ["a string", "ok"],
    ["a number", 5],
    ["an array", []],
    ["an object without items", { status: "ok" }],
    ["items that is not an array", { status: "ok", items: {} }],
    ["items that is null", { status: "ok", items: null }],
  ])("%s is not a list", (_label, input) => {
    expect(parseFlashapiList(input).ok).toBe(false);
  });

  test("an empty list is a list with no tracks, not an error", () => {
    const list = parsed(body());
    expect(list.tracks).toEqual([]);
    expect(list.dropped).toEqual([]);
    expect(list.observed.itemCount).toBe(0);
  });

  test.each([["null", null], ["a number", 5], ["a string", "x"], ["an array", []], ["an item without a track", {}], ["a track that is a string", { track: "x" }], ["a track that is an array", { track: [] }]])(
    "an item that is %s is dropped as no-track and the rest is kept",
    (_label, bad) => {
      const list = parsed(body(bad, item(good())));
      expect(list.tracks).toHaveLength(1);
      expect(list.dropped).toEqual([{ index: 0, reason: "no-track" }]);
    },
  );

  test("at most 100 tracks are kept; the rest are dropped as over-limit", () => {
    const items = Array.from({ length: 150 }, (_, i) => item(good({ id: String(1_000_000_000 + i) })));
    const list = parsed(body(...items));
    expect(MAX_LISTED_TRACKS).toBe(100);
    expect(list.tracks).toHaveLength(100);
    expect(list.dropped).toHaveLength(50);
    expect(list.dropped.every((d) => d.reason === "over-limit")).toBe(true);
    expect(list.observed.itemCount).toBe(150);
  });

  test("a __proto__ key in the JSON changes no prototype and reaches no track", () => {
    const evil = JSON.parse('{"status":"ok","items":[{"track":{"id":"1395615172492847","progressive_download_url":"' + DL + '","duration_in_ms":5,"__proto__":{"polluted":true}},"__proto__":{"polluted":true}}]}') as unknown;
    const list = parsed(evil);
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
    expect(Reflect.get(list.tracks[0] ?? {}, "polluted")).toBeUndefined();
  });

  test("a large list of junk items parses in a fair time", () => {
    const junk = Array.from({ length: 20_000 }, (_, i) => (i % 2 === 0 ? null : { track: { id: i } }));
    const started = performance.now();
    parsed(body(...junk));
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("signedUrlExpiresAtMs", () => {
  test("reads the oe parameter, hex seconds since the epoch", () => {
    expect(signedUrlExpiresAtMs("https://h.example/a.mp4?oe=68DC1E2F&oh=1")).toBe(0x68dc1e2f * 1000);
  });

  test.each([
    ["no query", "https://h.example/a.mp4"],
    ["no oe", "https://h.example/a.mp4?oh=1"],
    ["an empty oe", "https://h.example/a.mp4?oe="],
    ["a non-hex oe", "https://h.example/a.mp4?oe=zzzz"],
    ["a decimal-looking oe with a letter", "https://h.example/a.mp4?oe=12x4"],
    ["an oe of 0", "https://h.example/a.mp4?oe=0"],
    ["an oe too big to be a time", "https://h.example/a.mp4?oe=ffffffffffffffff"],
    ["not a URL", "nope"],
  ])("is null for %s", (_label, url) => {
    expect(signedUrlExpiresAtMs(url)).toBeNull();
  });
});
