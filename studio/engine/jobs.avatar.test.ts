import { describe, expect, test } from "bun:test";
import { JobRegistry } from "./jobs";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// «Удалить аватар»: an avatar with a candidates job, a photo run or a render queued or running is not deleted; the finished jobs of a
// deleted avatar are forgotten, so the snapshot does not list a job of an avatar that is gone.

const AVATAR = "avatar-00000001";
const OTHER = "avatar-00000002";

describe("hasLiveJobFor", () => {
  test("is true for a running candidates job of the avatar", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000001", AVATAR, 4);

    expect(jobs.hasLiveJobFor(AVATAR)).toBe(true);
  });

  test("is true for a running photo run of the avatar", () => {
    const jobs = new JobRegistry();
    jobs.startRun("job-00000001", { runId: "run-00000001", avatarId: AVATAR, total: 6, done: 0 });

    expect(jobs.hasLiveJobFor(AVATAR)).toBe(true);
  });

  test("is true for a queued render and for a running one", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", { videoId: "video-00000001", avatarId: AVATAR, montageId: null }, 90);
    expect(jobs.hasLiveJobFor(AVATAR)).toBe(true);

    jobs.startRender("job-00000001");
    expect(jobs.hasLiveJobFor(AVATAR)).toBe(true);
  });

  test("is false once the job ended, however it ended", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000001", AVATAR, 4);
    jobs.finish("job-00000001", { status: "cancelled" });
    jobs.queueRender("job-00000002", { videoId: "video-00000002", avatarId: AVATAR, montageId: null }, 90);
    jobs.finishRender("job-00000002", { status: "cancelled" });

    expect(jobs.hasLiveJobFor(AVATAR)).toBe(false);
  });

  test("is false for an avatar another avatar's job runs for", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000001", OTHER, 4);

    expect(jobs.hasLiveJobFor(AVATAR)).toBe(false);
  });

  test("an own-media import belongs to no avatar", () => {
    const jobs = new JobRegistry();
    jobs.startImport("job-00000001", { mediaKind: "photo", name: "a.jpg" }, 1000);

    expect(jobs.hasLiveJobFor(AVATAR)).toBe(false);
  });
});

describe("forgetFinishedFor", () => {
  test("drops the finished jobs of the avatar and keeps its running ones and every other avatar's", () => {
    const jobs = new JobRegistry();
    jobs.startCandidates("job-00000001", AVATAR, 4);
    jobs.finish("job-00000001", { status: "cancelled" });
    jobs.startCandidates("job-00000002", OTHER, 4);
    jobs.finish("job-00000002", { status: "cancelled" });
    jobs.startCandidates("job-00000003", AVATAR, 4);

    jobs.forgetFinishedFor(AVATAR);

    expect(jobs.states().map((s) => s.jobId).sort()).toEqual(["job-00000002", "job-00000003"]);
  });

  test("forgets a finished render of the avatar too", () => {
    const jobs = new JobRegistry();
    jobs.queueRender("job-00000001", { videoId: "video-00000001", avatarId: AVATAR, montageId: null }, 90);
    jobs.finishRender("job-00000001", { status: "cancelled" });

    jobs.forgetFinishedFor(AVATAR);

    expect(jobs.states()).toEqual([]);
  });
});
