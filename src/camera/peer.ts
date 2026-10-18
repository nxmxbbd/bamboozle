import { BlockList, isIPv4, isIPv6, SocketAddress } from 'node:net';

/** An address in canonical form, with its IPv6 zone (interface) if it has one. */
export interface PeerAddress {
  address: string;
  zone: string | null;
}

const LINK_LOCAL = new BlockList();
LINK_LOCAL.addSubnet('fe80::', 10, 'ipv6');

/**
 * Canonical form for comparing addresses: IPv6 compressed and lower case
 * (`2001:0db8:0:0:0:0:0:1` → `2001:db8::1`), IPv4-mapped IPv6 as plain IPv4
 * without a zone, the zone of other IPv6 kept apart. Null unless the whole
 * string is an IP address as `net.isIP` reads it, so a zone on IPv4, an
 * empty zone or a second `%` gives null.
 */
export function peerAddress(raw: string): PeerAddress | null {
  const family = isIPv4(raw) ? 'ipv4' : isIPv6(raw) ? 'ipv6' : null;
  if (family === null) return null;
  // Only IPv6 can get here with a zone, and never an empty one.
  const percent = raw.indexOf('%');
  const host = percent === -1 ? raw : raw.slice(0, percent);
  const zone = percent === -1 ? null : raw.slice(percent + 1);
  let address: string;
  try {
    address = new SocketAddress({ address: host, family }).address;
  } catch {
    return null;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return { address: mapped[1]!, zone: null };
  return { address, zone };
}

/**
 * The viewer a prepare request names, for isSamePeer. `target` is the
 * address the Home app gave (null if it is not an address); `localAddress`
 * is our end of the HAP connection the request came on. A zone names one
 * of our own interfaces, which the Home app cannot know, so any zone on
 * `target` is ignored. A link-local target (fe80::/10) takes the zone of
 * `localAddress`, which Node writes as `fe80::…%eth0`, or none when that
 * has no zone or is not an address; any other target has no zone.
 */
export function viewerPeer(target: string, localAddress: string | undefined): PeerAddress | null {
  const viewer = peerAddress(target);
  if (viewer === null) return null;
  const linkLocal = isIPv6(viewer.address) && LINK_LOCAL.check(viewer.address, 'ipv6');
  const zone = linkLocal && localAddress !== undefined ? (peerAddress(localAddress)?.zone ?? null) : null;
  return { address: viewer.address, zone };
}

/**
 * Our address for a stream's media: `localAddress`, our end of the HAP
 * connection the prepare request came on, in canonical form (see
 * peerAddress: IPv4-mapped IPv6 as IPv4, an IPv6 zone kept). `ipv6` is
 * whether the stream is IPv6. Null when `localAddress` is missing, is not
 * an address, or is of the other family (IPv6 for an IPv4 stream or the
 * other way round); the stream socket then binds on all interfaces and
 * HAP-NodeJS chooses the address it advertises.
 */
export function localMediaAddress(localAddress: string | undefined, ipv6: boolean): PeerAddress | null {
  const local = localAddress === undefined ? null : peerAddress(localAddress);
  if (local === null || isIPv6(local.address) !== ipv6) return null;
  return local;
}

/**
 * `peer` as a host string for a socket (bind, send) or ffmpeg: the address
 * with `%zone` appended when it has a zone, the address alone otherwise.
 */
export function socketHost(peer: PeerAddress): string {
  return peer.zone === null ? peer.address : `${peer.address}%${peer.zone}`;
}

/**
 * Whether `sender`, a datagram's source as Node reports it, is the
 * `expected` peer. Null `expected` never matches, nor does a sender that
 * is not an address (see peerAddress). The canonical addresses must be the
 * same. When `expected` has a zone, the sender's must be exactly the same;
 * a sender without one does not match. When `expected` has no zone, a
 * sender with any zone or none matches. That is intended for a viewer that
 * is not link-local, which viewerPeer gives no zone. The one remaining
 * limitation: a link-local viewer gets no zone when our own address had
 * none to give, and then the same address on any interface counts.
 */
export function isSamePeer(expected: PeerAddress | null, sender: string): boolean {
  const actual = peerAddress(sender);
  if (expected === null || actual === null || expected.address !== actual.address) return false;
  return expected.zone === null || expected.zone === actual.zone;
}
