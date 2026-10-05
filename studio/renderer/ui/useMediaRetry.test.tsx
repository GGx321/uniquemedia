import { afterEach, expect, test } from "bun:test";
import { useCallback } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useMediaRetry } from "./useMediaRetry";

// Stage 3 security review round 2, L-2: `studio-media://` now answers 503 (no slot came free in time) and 504 (the disk ran past its deadline) instead of
// waiting forever. An element cannot read a status or a Retry-After, only that it failed, so a picture that failed once was a placeholder for good, though the
// next try a second later would have been served. One shared hook gives a failed element exactly ONE more try after a short pause, then the placeholder.

afterEach(cleanup);

const DELAY = 15;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function Probe({ src, loads }: { src: string | null; loads: string[] }) {
  const media = useMediaRetry(src, DELAY);
  // One entry per element that appears: each new element is a new load of the same address, which is how the browser asks again.
  const noted = useCallback((node: HTMLImageElement | null) => { if (node !== null) loads.push(`${media.key}:${src}`); }, [loads, media.key, src]);
  if (src === null || media.failed) return <p>placeholder</p>;
  return <img key={media.key} alt="shot" src={src} ref={noted} onError={media.onError} />;
}

const shot = (): HTMLImageElement => {
  const img = screen.getByRole("img", { name: "shot" });
  if (!(img instanceof HTMLImageElement)) throw new Error("not an img");
  return img;
};

test("a picture that loads is shown and never asked for twice", async () => {
  const loads: string[] = [];
  render(<Probe src="studio-media://photo/a/b" loads={loads} />);
  await act(() => pause(DELAY * 3));
  expect(shot()).toBeDefined();
  expect(loads).toEqual(["0:studio-media://photo/a/b"]);
});

test("a 503 and then a success: the picture is shown, after one more load of the same address", async () => {
  const loads: string[] = [];
  render(<Probe src="studio-media://photo/a/b" loads={loads} />);
  fireEvent.error(shot());
  // Not at once: the pause is what lets a busy gate drain.
  expect(loads).toEqual(["0:studio-media://photo/a/b"]);
  await act(() => pause(DELAY * 3));
  expect(screen.queryByText("placeholder") === null).toBe(true);
  expect(loads).toEqual(["0:studio-media://photo/a/b", "1:studio-media://photo/a/b"]);
  expect(shot()).toBeDefined();
});

test("two failures in a row: the placeholder, and no third try", async () => {
  const loads: string[] = [];
  render(<Probe src="studio-media://photo/a/b" loads={loads} />);
  fireEvent.error(shot());
  await act(() => pause(DELAY * 3));
  fireEvent.error(shot());
  expect(screen.getByText("placeholder")).toBeDefined();
  await act(() => pause(DELAY * 4));
  expect(loads).toHaveLength(2);
  expect(screen.getByText("placeholder")).toBeDefined();
});

test("the first failure alone does not show the placeholder", () => {
  render(<Probe src="studio-media://photo/a/b" loads={[]} />);
  fireEvent.error(shot());
  expect(screen.queryByText("placeholder") === null).toBe(true);
});

test("another address gets its own two chances: a failure of the old one is not carried over", async () => {
  const loads: string[] = [];
  const { rerender } = render(<Probe src="studio-media://photo/a/one" loads={loads} />);
  fireEvent.error(shot());
  await act(() => pause(DELAY * 3));
  fireEvent.error(shot());
  expect(screen.getByText("placeholder")).toBeDefined();
  rerender(<Probe src="studio-media://photo/a/two" loads={loads} />);
  expect(shot().getAttribute("src")).toBe("studio-media://photo/a/two");
  fireEvent.error(shot());
  expect(screen.queryByText("placeholder") === null).toBe(true);
});

test("the pending retry is dropped when the element goes away: nothing fires after unmount", async () => {
  const loads: string[] = [];
  const { unmount } = render(<Probe src="studio-media://photo/a/b" loads={loads} />);
  fireEvent.error(shot());
  unmount();
  await pause(DELAY * 3);
  expect(loads).toEqual(["0:studio-media://photo/a/b"]);
});

test("a failure that comes while the retry is waiting does not start a second retry", async () => {
  const loads: string[] = [];
  render(<Probe src="studio-media://photo/a/b" loads={loads} />);
  const img = shot();
  fireEvent.error(img);
  fireEvent.error(img);
  await act(() => pause(DELAY * 3));
  expect(loads).toEqual(["0:studio-media://photo/a/b", "1:studio-media://photo/a/b"]);
  expect(screen.queryByText("placeholder") === null).toBe(true);
});
