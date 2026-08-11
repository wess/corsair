"""
A minimal SMTP server that really performs a STARTTLS upgrade.

    python3 starttlsserver.py <cert.pem> <key.pem> <port> <verdict.json>

It exists because Bun cannot perform a server-side TLS upgrade — neither
`socket.upgradeTLS()` on a `Bun.listen` socket nor
`new tls.TLSSocket(sock, { isServer: true })` completes a handshake — so the
outbound client's upgrade path cannot be exercised by a peer written in Bun.

Blocking sockets on purpose. `asyncio`'s `start_tls` requires rewiring the
reader and writer transports by hand, and getting that subtly wrong produces a
server that upgrades but then never sees another command, which looks exactly
like a client bug and is not one.

Accepts one connection, records what it saw, writes the verdict as JSON, exits.
"""

import json
import socket
import ssl
import sys

CERT, KEY, PORT, OUT = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]

seen = {"upgraded": False, "body_after_upgrade": False, "commands": []}


def flush():
    """Written after every step, not once at the end.

    A server that stalls mid-session is exactly the failure this test exists to
    catch, and a verdict that only appears on a clean exit tells you nothing
    about where it stopped."""
    with open(OUT, "w") as handle:
        json.dump(seen, handle)


flush()

srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", PORT))
srv.listen(1)
print("READY", flush=True)

conn, _ = srv.accept()
conn.settimeout(8)
stream = conn.makefile("rwb")
upgraded = False


def send(payload):
    stream.write(payload)
    stream.flush()


def readline():
    raw = stream.readline()
    if not raw:
        raise EOFError("peer closed")
    return raw.decode("latin1").rstrip("\r\n")


send(b"220 probe.invalid ESMTP\r\n")

try:
    while True:
        command = readline()
        if not command:
            break

        seen["commands"].append(
            ("tls:" if upgraded else "plain:") + command.split(" ")[0].upper()
        )
        flush()
        verb = command.upper()

        if verb.startswith("EHLO") or verb.startswith("HELO"):
            # STARTTLS is offered only before the upgrade, as a real MX does.
            reply = b"250-probe.invalid\r\n250-SIZE 10485760\r\n"
            if not upgraded:
                reply += b"250-STARTTLS\r\n"
            send(reply + b"250 HELP\r\n")

        elif verb.startswith("STARTTLS"):
            send(b"220 ready\r\n")
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(CERT, KEY)
            conn = context.wrap_socket(conn, server_side=True)
            conn.settimeout(8)
            stream = conn.makefile("rwb")
            upgraded = True
            seen["upgraded"] = True
            flush()

        elif verb.startswith("MAIL"):
            send(b"250 2.1.0 ok\r\n")

        elif verb.startswith("RCPT"):
            send(b"250 2.1.5 ok\r\n")

        elif verb.startswith("DATA"):
            send(b"354 go\r\n")
            while True:
                body = readline()
                if body == ".":
                    break
                if "STARTTLS-PROBE-BODY" in body and upgraded:
                    seen["body_after_upgrade"] = True
                    flush()
            send(b"250 2.0.0 accepted\r\n")

        elif verb.startswith("QUIT"):
            send(b"221 bye\r\n")
            break

        else:
            send(b"250 ok\r\n")

except Exception as error:  # noqa: BLE001 - recorded for the test to report
    seen["error"] = "{}: {}".format(type(error).__name__, error)

seen["finished"] = True
flush()
