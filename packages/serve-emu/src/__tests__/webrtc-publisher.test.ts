import { describe, expect, test } from "bun:test";
import type nodeDataChannel from "node-datachannel";
import { injectVideoSsrc, selectH264Media, WebRtcPublisher } from "../webrtc-publisher.ts";
import { WebRtcSignalingError } from "../webrtc-signaling.ts";

const OFFER_SDP = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 109",
  "a=mid:video0",
  "a=recvonly",
  "a=rtpmap:109 H264/90000",
  "a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
].join("\r\n");

const ANSWER_SDP = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 109",
  "a=mid:video0",
  "a=sendonly",
].join("\r\n");

class FakeMediaHandler {
  addToChain(_handler: FakeMediaHandler): void {}
}

class FakeRtpPacketizationConfig {
  timestamp = 0;

  constructor(
    readonly ssrc: number,
    readonly cname: string,
    readonly payloadType: number,
    readonly clockRate: number,
  ) {}
}

class FakeTrack {
  mid(): string {
    return "video0";
  }
  close(): void {}
  sendMessageBinary(): boolean {
    return true;
  }
  isOpen(): boolean {
    return true;
  }
  onOpen(_cb: () => void): void {}
  onClosed(_cb: () => void): void {}
  onError(_cb: (err: string) => void): void {}
  setMediaHandler(_handler: FakeMediaHandler): void {}
}

class FakePeerConnection {
  private localDescriptionCallback: ((sdp: string, type: string) => void) | null = null;
  private trackCallback: ((track: FakeTrack) => void) | null = null;
  private readonly answerDelayMs: number;

  constructor(_label: string, config: { answerDelayMs?: number } = {}) {
    this.answerDelayMs = config.answerDelayMs ?? 0;
  }

  onTrack(cb: (track: FakeTrack) => void): void {
    this.trackCallback = cb;
  }
  onDataChannel(_cb: unknown): void {}
  onStateChange(_cb: (state: string) => void): void {}
  onIceStateChange(_cb: (state: string) => void): void {}
  onGatheringStateChange(_cb: (state: string) => void): void {}
  setRemoteDescription(_sdp: string, _type: string): void {
    this.trackCallback?.(new FakeTrack());
  }
  onLocalDescription(cb: (sdp: string, type: string) => void): void {
    this.localDescriptionCallback = cb;
  }
  setLocalDescription(type: string): void {
    setTimeout(() => this.localDescriptionCallback?.(ANSWER_SDP, type), this.answerDelayMs);
  }
  gatheringState(): string {
    return "complete";
  }
  localDescription(): { type: string; sdp: string } {
    return { type: "answer", sdp: ANSWER_SDP };
  }
  close(): void {}
}

function fakeNodeDataChannel(answerDelayMs = 0): typeof nodeDataChannel {
  return {
    PeerConnection: class extends FakePeerConnection {
      constructor(label: string) {
        super(label, { answerDelayMs });
      }
    },
    RtpPacketizationConfig: FakeRtpPacketizationConfig,
    H264RtpPacketizer: FakeMediaHandler,
    RtcpSrReporter: FakeMediaHandler,
    RtcpNackResponder: FakeMediaHandler,
  } as unknown as typeof nodeDataChannel;
}

describe("WebRTC publisher SDP helpers", () => {
  test("selects a browser-offered H.264 packetization-mode=1 payload type", () => {
    expect(
      selectH264Media(
        [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 96 110 109",
          "a=mid:video0",
          "a=rtpmap:96 VP8/90000",
          "a=rtpmap:110 H264/90000",
          "a=fmtp:110 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640c1f",
          "a=rtpmap:109 H264/90000",
          "a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        ].join("\r\n"),
      ),
    ).toEqual({ payloadType: 109, mid: "video0" });
  });

  test("prefers constrained baseline H.264 when multiple compatible payloads exist", () => {
    expect(
      selectH264Media(
        [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 111 109",
          "a=mid:0",
          "a=rtpmap:111 H264/90000",
          "a=fmtp:111 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f",
          "a=rtpmap:109 H264/90000",
          "a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        ].join("\n"),
      ),
    ).toEqual({ payloadType: 109, mid: "0" });
  });

  test("keeps H.264 payload selection scoped to the selected video mid", () => {
    expect(
      selectH264Media(
        [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 111",
          "a=mid:video0",
          "a=recvonly",
          "a=rtpmap:111 H264/90000",
          "a=fmtp:111 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640c1f",
          "m=video 9 UDP/TLS/RTP/SAVPF 109",
          "a=mid:video1",
          "a=recvonly",
          "a=rtpmap:109 H264/90000",
          "a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        ].join("\r\n"),
      ),
    ).toEqual({ payloadType: 109, mid: "video1" });
  });

  test("rejects offers without packetization-mode=1 H.264 video", () => {
    expect(() =>
      selectH264Media(
        [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 110",
          "a=mid:video0",
          "a=rtpmap:110 H264/90000",
          "a=fmtp:110 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640c1f",
        ].join("\r\n"),
      ),
    ).toThrow("WebRTC offer does not include H.264 packetization-mode=1 video");
  });

  test("injects the selected SSRC into the matching video section", () => {
    const answer = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:audio0",
      "m=video 9 UDP/TLS/RTP/SAVPF 109",
      "a=mid:video0",
      "a=sendonly",
    ].join("\r\n");

    expect(injectVideoSsrc(answer, "video0", 1234)).toBe(
      [
        "v=0",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111",
        "a=mid:audio0",
        "m=video 9 UDP/TLS/RTP/SAVPF 109",
        "a=mid:video0",
        "a=ssrc:1234 cname:serve-emu",
        "a=sendonly",
      ].join("\r\n"),
    );
  });

  test("adds the exact packetizer SSRC even when other SSRC lines exist", () => {
    const answer = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 109",
      "a=mid:video0",
      "a=ssrc:9999 cname:old",
    ].join("\n");

    expect(injectVideoSsrc(answer, "video0", 1234)).toBe(
      [
        "v=0",
        "m=video 9 UDP/TLS/RTP/SAVPF 109",
        "a=mid:video0",
        "a=ssrc:1234 cname:serve-emu",
        "a=ssrc:9999 cname:old",
      ].join("\n"),
    );
  });

  test("leaves SDP unchanged when the exact SSRC is already present", () => {
    const answer = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 109",
      "a=mid:video0",
      "a=ssrc:1234 cname:serve-emu",
    ].join("\r\n");

    expect(injectVideoSsrc(answer, "video0", 1234)).toBe(answer);
  });

  test("throws when the answer does not contain the selected video mid", () => {
    expect(() => injectVideoSsrc("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 109\r\na=mid:other", "video0", 1234))
      .toThrow('WebRTC answer does not include the selected video mid "video0"');
  });
});

describe("WebRTC publisher signaling", () => {
  test("rejects concurrent offers, including duplicate session IDs", async () => {
    const publisher = new WebRtcPublisher(fakeNodeDataChannel(10), {
      settings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [{ urls: ["stun:stun.example:3478"] }],
        iceTransportPolicy: "all",
      },
      onKeyframeRequest() {},
    });
    const sessionId = "00000000-0000-4000-8000-000000000000";
    const first = publisher.handleOffer({ type: "offer", sdp: OFFER_SDP, sessionId });
    try {
      await publisher.handleOffer({ type: "offer", sdp: OFFER_SDP, sessionId });
      throw new Error("Expected duplicate offer to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(WebRtcSignalingError);
      expect((err as WebRtcSignalingError).status).toBe(409);
      expect((err as WebRtcSignalingError).code).toBe("webrtc_session_busy");
    }
    await expect(first).resolves.toMatchObject({ type: "answer" });
  });

  test("uses only host-configured ICE servers for native peers", async () => {
    const peerConfigs: Array<{ iceServers?: string[] }> = [];
    const ndc = {
      ...fakeNodeDataChannel(),
      PeerConnection: class extends FakePeerConnection {
        constructor(label: string, config: { iceServers?: string[] }) {
          super(label);
          peerConfigs.push(config);
        }
      },
    } as unknown as typeof nodeDataChannel;
    const publisher = new WebRtcPublisher(ndc, {
      settings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [{ urls: ["turn:trusted.example:3478"], username: "u", credential: "p" }],
        iceTransportPolicy: "all",
      },
      onKeyframeRequest() {},
    });

    await publisher.handleOffer({ type: "offer", sdp: OFFER_SDP, sessionId: "00000000-0000-4000-8000-000000000000" });

    expect(peerConfigs[0]?.iceServers).toEqual(["turn:u:p@trusted.example:3478"]);
  });
});
