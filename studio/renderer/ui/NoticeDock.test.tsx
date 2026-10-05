import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Docked, NoticeDockProvider } from "./NoticeDock";
import { Notice } from "./Notice";

// Review r1 LOW-2 / r2 LOW-1: a window notice drawn again (moved into or out of a dock, which remounts it) is said politely, not as a new
// alert; its role follows its key, so a key that changes in place (a repeat of the notice) is news again, and a key seen before is not.

afterEach(cleanup);

function Window({ noticeKey, shown = true }: { noticeKey: string; shown?: boolean }) {
  return (
    <NoticeDockProvider>
      <Docked>
        {shown && (
          <Notice tone="warn" title="Движок перезапускался" noticeKey={noticeKey}>
            работа могла быть потеряна
          </Notice>
        )}
      </Docked>
    </NoticeDockProvider>
  );
}

const role = (): string | null => screen.getByText("Движок перезапускался").closest(".notice")?.getAttribute("role") ?? null;

describe("a window notice's role", () => {
  test("an alert the first time; drawn again, polite; a new key in place is an alert again; a key seen before is polite", () => {
    const { rerender } = render(<Window noticeKey="engine:a:1" />);
    expect(role()).toBe("alert");
    rerender(<Window noticeKey="engine:a:1" shown={false} />);
    rerender(<Window noticeKey="engine:a:1" />);
    expect(role()).toBe("status");
    rerender(<Window noticeKey="engine:a:2" />);
    expect(role()).toBe("alert");
    rerender(<Window noticeKey="engine:a:1" />);
    expect(role()).toBe("status");
  });
});
