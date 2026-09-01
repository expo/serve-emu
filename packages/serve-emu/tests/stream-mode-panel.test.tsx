import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamModePanel } from "../src/ui/components/stream-mode-panel";

describe("StreamModePanel", () => {
  test("renders an accessible, unavailable-until-loaded radio group", () => {
    const markup = renderToStaticMarkup(<StreamModePanel />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('aria-describedby="stream-mode-help"');
    expect(markup).toContain('<legend class="visually-hidden">Stream source</legend>');
    expect(markup).toContain('type="radio"');
    expect(markup.match(/type="radio"/g)?.length).toBe(2);
    expect(markup.match(/disabled=""/g)?.length).toBe(2);
    expect(markup).toContain('value="scrcpy"');
    expect(markup).toContain('value="grpc-screenshot"');
    expect(markup).toContain("On-device capture");
    expect(markup).toContain("Emulator host capture");
    expect(markup).toContain("Checking the available stream sources…");
  });
});
