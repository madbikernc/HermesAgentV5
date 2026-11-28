#!/usr/bin/env python3
# Version: 1.0.0
#
# Sits between Velocity and the bot world's vanilla server (MINECRAFT_PROXY_TRAVEL_PLAN.md Phase
# 5): that vanilla build rejects Velocity's legacy-forwarded handshake outright ("unable to
# connect to server botworld... remote server does not have BungeeCord IP forwarding correctly
# enabled"), and forwarding mode is one proxy-wide Velocity setting, not configurable per backend,
# so the default world (which needs it for the whitelist) and the bot world (which can't take it)
# can't both be satisfied by Velocity alone.
#
# This relay only ever looks at the first packet of a connection -- the handshake -- and only to
# strip a forwarded hostname back to something plain if one is present. Every packet after that,
# either direction, is piped unexamined until one side closes. The bot world's real listener
# (:25580, bots connecting directly) is untouched; only Velocity's "botworld" entry points here
# instead.
#
# Run: python3 tools/minecraft-handshake-relay.py
# Env: MC_RELAY_LISTEN_PORT (default 25582), MC_RELAY_UPSTREAM_HOST (default 127.0.0.1),
#      MC_RELAY_UPSTREAM_PORT (default 25580)
import asyncio
import logging
import os

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = int(os.environ.get("MC_RELAY_LISTEN_PORT", "25582"))
UPSTREAM_HOST = os.environ.get("MC_RELAY_UPSTREAM_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.environ.get("MC_RELAY_UPSTREAM_PORT", "25580"))
PLAIN_HOSTNAME = "localhost"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("mc-handshake-relay")


async def read_varint(reader):
    value = 0
    for shift in range(0, 35, 7):
        b = (await reader.readexactly(1))[0]
        value |= (b & 0x7F) << shift
        if not (b & 0x80):
            return value
    raise ValueError("varint too long")


def write_varint(value):
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def rewrite_handshake(body):
    """Parse a handshake packet body; if its server-address field carries a BungeeCord/Velocity
    legacy-forwarded blob (null-byte-delimited), rewrite it to a plain hostname. Returns the
    (possibly unchanged) body, and whether a rewrite happened."""
    pos = 0

    def take_varint():
        nonlocal pos
        value = 0
        for shift in range(0, 35, 7):
            b = body[pos]
            pos += 1
            value |= (b & 0x7F) << shift
            if not (b & 0x80):
                return value
        raise ValueError("varint too long")

    packet_id = take_varint()
    if packet_id != 0x00:
        return body, False  # not a handshake; leave it alone

    protocol_version = take_varint()
    addr_len = take_varint()
    address = body[pos:pos + addr_len]
    pos += addr_len
    rest = body[pos:]  # port (2 bytes) + next-state varint, untouched

    if b"\x00" not in address:
        return body, False

    new_address = PLAIN_HOSTNAME.encode("utf-8")
    new_body = (
        write_varint(packet_id)
        + write_varint(protocol_version)
        + write_varint(len(new_address))
        + new_address
        + rest
    )
    return new_body, True


async def pipe(reader, writer, label):
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError):
        pass
    finally:
        writer.close()


async def handle_client(client_reader, client_writer):
    peer = client_writer.get_extra_info("peername")
    try:
        upstream_reader, upstream_writer = await asyncio.open_connection(UPSTREAM_HOST, UPSTREAM_PORT)
    except OSError as exc:
        log.error("%s: can't reach upstream %s:%s: %s", peer, UPSTREAM_HOST, UPSTREAM_PORT, exc)
        client_writer.close()
        return

    try:
        length = await read_varint(client_reader)
        body = await client_reader.readexactly(length)
        new_body, rewritten = rewrite_handshake(body)
        upstream_writer.write(write_varint(len(new_body)) + new_body)
        await upstream_writer.drain()
        log.info("%s: handshake forwarded (rewritten=%s)", peer, rewritten)
    except (asyncio.IncompleteReadError, ValueError, IndexError) as exc:
        # Not a well-formed handshake as the first packet -- fail open, forward the raw bytes
        # we already consumed unchanged, then fall through to the plain pipe below.
        log.warning("%s: couldn't parse first packet (%s), passing through unmodified", peer, exc)
        upstream_writer.write(locals().get("body", b""))
        await upstream_writer.drain()

    await asyncio.gather(
        pipe(client_reader, upstream_writer, "c->s"),
        pipe(upstream_reader, client_writer, "s->c"),
    )


async def main():
    server = await asyncio.start_server(handle_client, LISTEN_HOST, LISTEN_PORT)
    log.info("listening on %s:%s, upstream %s:%s", LISTEN_HOST, LISTEN_PORT, UPSTREAM_HOST, UPSTREAM_PORT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
