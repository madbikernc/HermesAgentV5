#!/usr/bin/env python3
# Version: 1.0.0
"""
hermes-nest-framegrab.py — the one genuinely new piece of infrastructure this capability needed:
a WebRTC peer that negotiates a Nest camera's live stream and pulls one decoded frame out of it.

Run as its OWN detached subprocess by tools/hermes-nest.py, never imported/called in-process — same
isolation reasoning tools/hermes-probe.py already established for nmap: an external, network-
dependent operation that can hang (WebRTC ICE negotiation across a NAT is a real place for that to
happen) is walled off behind a hard timeout and its own process group, so it can never wedge the
specialist's own claim/poll loop. Uses the dedicated venv at /opt/hermes/venvs/nest/ (aiortc + its
transitive binary deps — not the shared system Python).

Owns the WHOLE WebRTC lifecycle, not just the receive half: an SDP offer has to be built before
GenerateWebRtcStream is ever called (SDM's own command takes the offer as input and returns the
answer), so this script imports hermes_nest_common directly rather than being handed a
pre-negotiated stream.

Flow: build an aiortc RTCPeerConnection offer (recvonly video) -> wait for ICE gathering to
actually finish (SDM's API takes a complete, non-trickle SDP — sending gathering-in-progress SDP
is a classic WebRTC mistake) -> hermes_nest_common.generate_webrtc_stream() -> setRemoteDescription
on the returned answer -> wait for one decoded frame on the incoming track -> save it as PNG ->
stop_webrtc_stream() to clean up -> exit 0. Any failure prints a plain error to stderr and exits
non-zero — hermes-nest.py treats a non-zero exit as the honest failure it is, never invents a
result.

NOT YET LIVE-TESTED (no Device Access sandbox credentials existed to test against as of writing).
The WebRTC mechanics here follow documented aiortc/SDM behavior, not a confirmed live trace — per
infra/hermes-nest/README.md's Verification section, this must be run standalone against a real
registered camera, with its real wall-clock cost measured, before hermes-nest.py's own
NEST_TASK_TIMEOUT_SECONDS default is trusted.

Usage: hermes-nest-framegrab.py <device-name> <output-png-path>
  device-name       full SDM resource name (enterprises/.../devices/...), already resolved —
                    this script does no nickname matching itself (see
                    hermes_nest_common.find_device())
  output-png-path   where to write the captured frame
"""

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_nest_common  # noqa: E402

FRAME_WAIT_TIMEOUT_SECONDS = 20  # time budget for a frame to arrive once the connection is up;
                                  # the process's own overall hard-kill timeout lives in
                                  # hermes-nest.py's launch_framegrab(), not here


async def _wait_ice_gathering_complete(pc):
    if pc.iceGatheringState == "complete":
        return
    done = asyncio.Event()

    @pc.on("icegatheringstatechange")
    def _on_change():
        if pc.iceGatheringState == "complete":
            done.set()

    await done.wait()


async def grab_frame(device_name, out_path):
    from aiortc import RTCPeerConnection

    pc = RTCPeerConnection()
    # recvonly: this side never sends media, only asks to receive the camera's video track.
    pc.addTransceiver("video", direction="recvonly")

    frame_future = asyncio.get_event_loop().create_future()

    @pc.on("track")
    def _on_track(track):
        if track.kind != "video":
            return

        async def _consume_one_frame():
            try:
                frame = await asyncio.wait_for(track.recv(), timeout=FRAME_WAIT_TIMEOUT_SECONDS)
                if not frame_future.done():
                    frame_future.set_result(frame)
            except Exception as exc:
                if not frame_future.done():
                    frame_future.set_exception(exc)

        asyncio.ensure_future(_consume_one_frame())

    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await _wait_ice_gathering_complete(pc)  # SDM needs a complete, non-trickle offer

    media_session_id = None
    try:
        response = hermes_nest_common.generate_webrtc_stream(
            device_name, pc.localDescription.sdp)
        results = response.get("results", {})
        answer_sdp = results.get("answerSdp")
        media_session_id = results.get("mediaSessionId")
        if not answer_sdp:
            raise RuntimeError(f"GenerateWebRtcStream returned no answerSdp: {response}")

        from aiortc import RTCSessionDescription
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer_sdp, type="answer"))

        frame = await frame_future
        frame.to_image().save(out_path, "PNG")
    finally:
        if media_session_id:
            try:
                hermes_nest_common.stop_webrtc_stream(device_name, media_session_id)
            except Exception as exc:
                print(f"WARNING: stop_webrtc_stream failed (non-fatal, stream will "
                      f"self-expire): {exc}", file=sys.stderr)
        await pc.close()


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: hermes-nest-framegrab.py <device-name> <output-png-path>")
    device_name, out_path = sys.argv[1], sys.argv[2]

    started = time.time()
    try:
        asyncio.run(grab_frame(device_name, out_path))
    except Exception as exc:
        print(f"ERROR: frame grab failed for {device_name}: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"OK: frame written to {out_path} in {time.time() - started:.1f}s")


if __name__ == "__main__":
    main()
