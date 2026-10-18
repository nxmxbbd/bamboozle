import { isIPv4, isIPv6, SocketAddress } from 'node:net';

/** An address in canonical form, with its IPv6 zone (interface) if it has one. */
export interface PeerAddress {
  address: string;
  zone: string | null;
}

/**
 * Canonical form for comparing addresses: IPv6 compressed and lower case
 * (`2001:0db8:0:0:0:0:0:1` → `2001:db8::1`), IPv4-mapped IPv6 as plain IPv4,
 * the zone kept apart. Null when it is not an IP address.
 */
export function peerAddress(raw: string): PeerAddress | null {
  const percent = raw.indexOf('%');
  const host = percent === -1 ? raw : raw.slice(0, percent);
  const zone = percent === -1 ? null : raw.slice(percent + 1);
  const family = isIPv4(host) ? 'ipv4' : isIPv6(host) ? 'ipv6' : null;
  if (family === null) return null;
  let address: string;
  try {
    address = new SocketAddress({ address: host, family }).address;
  } catch {
    return null;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return { address: mapped[1]!, zone: null };
  return { address, zone: family === 'ipv6' && zone ? zone : null };
}

/**
 * Whether `sender` is the peer we expect. The addresses must be the same;
 * when both carry a zone the zones must be the same too. A peer named
 * without a zone matches on any interface: the Home app cannot know our
 * interface names, so the address it gives us has none.
 */
export function isSamePeer(expected: PeerAddress | null, sender: string): boolean {
  const actual = peerAddress(sender);
  if (expected === null || actual === null || expected.address !== actual.address) return false;
  return expected.zone === null || actual.zone === null || expected.zone === actual.zone;
}
