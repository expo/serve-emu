import { describe, expect, test } from "bun:test";
import { readBoundedBody, RequestBodyTooLargeError } from "../request-body.ts";

function streamingRequest(chunks: string[], headers?: HeadersInit): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("http://localhost/test", { method: "POST", headers, body });
}

describe("bounded request bodies", () => {
  test("reads a chunked body up to the configured limit", async () => {
    const body = await readBoundedBody(streamingRequest(["abc", "def"]), 6);
    expect(body.toString("utf8")).toBe("abcdef");
  });

  test("stops reading an oversized chunked body without Content-Length", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("abcd"));
          controller.enqueue(encoder.encode("efgh"));
        },
        cancel() {
          cancelled = true;
        },
      }),
    });

    await expect(readBoundedBody(request, 7)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
    expect(cancelled).toBe(true);
  });

  test("does not trust an understated Content-Length", async () => {
    const request = streamingRequest(["oversized"], { "Content-Length": "1" });
    await expect(readBoundedBody(request, 4)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  test("rejects an oversized declared body before consuming it", async () => {
    const request = streamingRequest(["small"], { "Content-Length": "100" });
    await expect(readBoundedBody(request, 10)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});
