#!/usr/bin/env python3
# Version: 1.0.0
#
# Companion to minecraft-handshake-relay.py, opposite direction. MINECRAFT_PROXY_TRAVEL_PLAN.md's
# Phase 5 fix converts the bot world's backend from vanilla to Paper with spigot.yml's
# `bungeecord: true`, so Velocity's legacy-forwarded players land there without the
# invalid_public_key_signature kick vanilla couldn't avoid (Paper substitutes the proxy-forwarded
# UUID instead of computing an offline hash, so a real signed profile key matches). But
# `bungeecord: true` is global to the backend's one listening port: it rejects any connection that
# doesn't carry forwarded data -- which is exactly what the bots' own direct connections, and the
# architect's direct LAN/Tailscale login, send today.
#
# This relay sits in front of that port for the bots and the architect instead. It reads just
# enough of each connection (the Handshake, then the Login Start packet to learn the username) to
# synthesize a legacy-forwarding server-address field -- "host\0ip\0uuid\0properties" -- using the
# same offline-UUID formula (MD5("OfflinePlayer:<name>"), version/variant bits set) vanilla itself
# already used for every existing identity, confirmed byte-for-byte against the bot world's own
# usercache.json and players/data/*.dat filenames before this was written. No real client, no real
# Mojang key, no cryptography involved: every identity through this relay is a plain/offline one,
# so there's nothing to strip or validate, only to format correctly for a backend that now expects
# it. Every packet after Login Start, either direction, is piped unexamined until one side closes.
#
# Run: python3 tools/minecraft-handshake-injector.py
# Env: MC_INJECTOR_LISTEN_PORT (default 25584), MC_INJECTOR_UPSTREAM_HOST (default 127.0.0.1),
#      MC_INJECTOR_UPSTREAM_PORT (default 25580)
import asyncio
import hashlib
import logging
import os
import uuid

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = int(os.environ.get("MC_INJECTOR_LISTEN_PORT", "25584"))
UPSTREAM_HOST = os.environ.get("MC_INJECTOR_UPSTREAM_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.environ.get("MC_INJECTOR_UPSTREAM_PORT", "25580"))
FORWARDED_HOSTNAME = "localhost"
LOGIN_NEXT_STATE = 2

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("mc-handshake-injector")


def offline_uuid(name):
    digest = bytearray(hashlib.md5(f"OfflinePlayer:{name}".encode("utf-8")).digest())
    digest[6] = (digest[6] & 0x0F) | 0x30
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))


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


async def read_varint(reader):
    value = 0
    for shift in range(0, 35, 7):
        b = (await reader.readexactly(1))[0]
        value |= (b & 0x7F) << shift
        if not (b & 0x80):
            return value
    raise ValueError("varint too long")


async def read_packet(reader):
    length = await read_varint(reader)
    return await reader.readexactly(length)


def parse_handshake(body):
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
        raise ValueError(f"expected handshake (0x00), got 0x{packet_id:02x}")
    protocol_version = take_varint()
    addr_len = take_varint()
    pos += addr_len  # original address, discarded -- we synthesize our own
    rest = body[pos:]  # port (2 bytes) + next-state varint
    next_state = rest[-1]  # next-state is always the last byte: a single-byte varint (0-2)
    return protocol_version, next_state


def parse_login_start_username(body):
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
        raise ValueError(f"expected login start (0x00), got 0x{packet_id:02x}")
    name_len = take_varint()
    name = body[pos:pos + name_len].decode("utf-8")
    return name


def build_handshake(protocol_version, address, port, next_state):
    addr_bytes = address.encode("utf-8")
    body = (
        write_varint(0x00)
        + write_varint(protocol_version)
        + write_varint(len(addr_bytes))
        + addr_bytes
        + port.to_bytes(2, "big")
        + write_varint(next_state)
    )
    return write_varint(len(body)) + body


def build_packet(packet_id_and_rest_bytes):
    return write_varint(len(packet_id_and_rest_bytes)) + packet_id_and_rest_bytes


async def pipe(reader, writer):
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
    peer_ip = peer[0] if peer else "127.0.0.1"

    try:
        handshake_body = await read_packet(client_reader)
        protocol_version, next_state = parse_handshake(handshake_body)
    except (asyncio.IncompleteReadError, ValueError, IndexError) as exc:
        log.warning("%s: couldn't parse handshake (%s), dropping", peer, exc)
        client_writer.close()
        return

    if next_state != LOGIN_NEXT_STATE:
        log.info("%s: non-login next_state=%s, passing through unmodified", peer, next_state)
        try:
            upstream_reader, upstream_writer = await asyncio.open_connection(UPSTREAM_HOST, UPSTREAM_PORT)
        except OSError as exc:
            log.error("%s: can't reach upstream %s:%s: %s", peer, UPSTREAM_HOST, UPSTREAM_PORT, exc)
            client_writer.close()
            return
        upstream_writer.write(write_varint(len(handshake_body)) + handshake_body)
        await upstream_writer.drain()
        await asyncio.gather(
            pipe(client_reader, upstream_writer),
            pipe(upstream_reader, client_writer),
        )
        return

    try:
        login_start_body = await read_packet(client_reader)
        username = parse_login_start_username(login_start_body)
    except (asyncio.IncompleteReadError, ValueError, IndexError, UnicodeDecodeError) as exc:
        log.warning("%s: couldn't parse login start (%s), dropping", peer, exc)
        client_writer.close()
        return

    player_uuid = offline_uuid(username)
    forwarded_address = f"{FORWARDED_HOSTNAME}\x00{peer_ip}\x00{player_uuid}\x00[]"

    try:
        upstream_reader, upstream_writer = await asyncio.open_connection(UPSTREAM_HOST, UPSTREAM_PORT)
    except OSError as exc:
        log.error("%s: can't reach upstream %s:%s: %s", peer, UPSTREAM_HOST, UPSTREAM_PORT, exc)
        client_writer.close()
        return

    upstream_writer.write(build_handshake(protocol_version, forwarded_address, UPSTREAM_PORT, LOGIN_NEXT_STATE))
    upstream_writer.write(build_packet(login_start_body))
    await upstream_writer.drain()
    log.info("%s: forwarded login for %r as %s", peer, username, player_uuid)

    await asyncio.gather(
        pipe(client_reader, upstream_writer),
        pipe(upstream_reader, client_writer),
    )


async def main():
    server = await asyncio.start_server(handle_client, LISTEN_HOST, LISTEN_PORT)
    log.info("listening on %s:%s, upstream %s:%s", LISTEN_HOST, LISTEN_PORT, UPSTREAM_HOST, UPSTREAM_PORT)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
