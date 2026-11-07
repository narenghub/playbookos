#!/usr/bin/env bash
# ── FETCH THE DATABASE'S CERTIFICATE SO IT CAN BE PINNED ──────────────────────────────────────────
#
#   scripts/fetch-db-cert.sh <host> <port> [outfile]
#
# Ruling 49 item 1. Railway's Postgres presents a self-signed certificate and publishes no CA, so
# `sslmode=verify-full` against the public PKI is not available. Pinning its certificate is the
# stronger remaining option: the connection then trusts exactly one key rather than every CA in the
# world not to mis-issue for that hostname.
#
# This script prints the certificate and its SHA-256 fingerprint. Compare that fingerprint against
# what you see from a DIFFERENT network — a phone hotspot is enough — before you trust it. A pin
# captured through an attacker is an attacker's pin, and nothing downstream can tell.
#
# It takes a host and a port and NOTHING ELSE. No username, no password, no connection string: the
# certificate is presented before authentication, so no credential is needed to read it and none
# should be typed into this command, where shell history would keep it.
set -u

HOST="${1:-}"
PORT="${2:-}"
OUT="${3:-./db-server.crt}"

if [ -z "$HOST" ] || [ -z "$PORT" ]; then
  echo "usage: scripts/fetch-db-cert.sh <host> <port> [outfile]" >&2
  echo "" >&2
  echo "  Host and port only. Do not pass a connection string — this needs no credentials," >&2
  echo "  and a credential on this command line would be kept in your shell history." >&2
  exit 2
fi

case "$HOST" in
  *:*|*@*|postgres*://*)
    echo "refusing: \"$HOST\" looks like a URL or carries credentials. Pass the host alone." >&2
    exit 2 ;;
esac

command -v openssl >/dev/null 2>&1 || { echo "openssl not found" >&2; exit 2; }

# -starttls postgres speaks the SSLRequest handshake Postgres expects before TLS begins. Without it
# openssl sends a TLS ClientHello to a server that is waiting for a startup packet, and the
# connection simply hangs — which looks like a network problem and is not one.
if ! openssl s_client -starttls postgres -connect "$HOST:$PORT" -showcerts </dev/null \
       > /tmp/fetch-db-cert.$$ 2>/dev/null; then
  echo "could not complete a TLS handshake with $HOST:$PORT" >&2
  echo "  If this openssl predates 1.1.1 it has no '-starttls postgres' and cannot do this." >&2
  rm -f /tmp/fetch-db-cert.$$
  exit 1
fi

awk '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/' /tmp/fetch-db-cert.$$ > "$OUT"
rm -f /tmp/fetch-db-cert.$$

if [ ! -s "$OUT" ]; then
  echo "no certificate was returned by $HOST:$PORT — is TLS enabled on that server?" >&2
  rm -f "$OUT"
  exit 1
fi

FP="$(openssl x509 -in "$OUT" -noout -fingerprint -sha256 | sed 's/^.*=//')"
SUBJ="$(openssl x509 -in "$OUT" -noout -subject)"
DATES="$(openssl x509 -in "$OUT" -noout -dates | tr '\n' ' ')"

echo ""
echo "  certificate written to $OUT"
echo "  subject     $SUBJ"
echo "  validity    $DATES"
echo "  SHA-256     $FP"
echo ""
echo "  Compare that fingerprint from another network before trusting it, then:"
echo ""
echo "      export DATABASE_CA_CERT_FILE=\"\$(cd \"\$(dirname \"$OUT\")\" && pwd)/$(basename "$OUT")\""
echo "      export DATABASE_SSL_FINGERPRINT=\"$FP\""
echo ""
echo "  With both set, the connection is refused unless the server presents exactly this"
echo "  certificate. Without them, behaviour is unchanged: encrypted, certificate not verified."
echo ""
