import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GrpcImageModeSelector,
  StreamModePanel,
} from "../src/ui/components/stream-mode-panel";

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
    expect(markup.match(/<input type="radio"[^>]*disabled=""/g)?.length).toBe(2);
    expect(markup).toContain('value="scrcpy"');
    expect(markup).toContain('value="grpc-screenshot"');
    expect(markup).toContain("On-device capture");
    expect(markup).toContain("Emulator host capture");
    expect(markup).toContain("Checking the available stream sources…");
    expect(markup).not.toContain("gRPC image mode");
  });

  test("renders an accessible explicit PNG/MMAP selector for the gRPC source", () => {
    const markup = renderToStaticMarkup(
      <GrpcImageModeSelector
        value="mmap"
        disabled={false}
        onChange={() => {}}
      />,
    );

    expect(markup).toContain("<legend>gRPC image mode</legend>");
    expect(markup).toContain('aria-describedby="stream-mode-help"');
    expect(markup.match(/name="grpc-image-mode"/g)?.length).toBe(2);
    expect(markup).toContain('value="png"');
    expect(markup).toContain('checked="" value="mmap"');
    expect(markup).toContain("Compressed in-band images");
    expect(markup).toContain("Shared-memory raw pixels");
    expect(markup).not.toContain("disabled");

    const disabledMarkup = renderToStaticMarkup(
      <GrpcImageModeSelector
        value="png"
        disabled
        onChange={() => {}}
      />,
    );
    expect(disabledMarkup).toContain("<fieldset");
    expect(disabledMarkup).toContain("disabled=\"\"");
  });
});
