// Which sender counts as the viewer, for the RTCP idle check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSamePeer, localMediaAddress, peerAddress, socketHost, viewerPeer } from '../src/camera/peer.ts';

const same = (expected: string, sender: string) => isSamePeer(peerAddress(expected), sender);
const viewer = (target: string, local: string | undefined, sender: string) => isSamePeer(viewerPeer(target, local), sender);

// Our end of the HAP connection, as Node names a link-local address.
const LOCAL = 'fe80::abcd%eth0';

test('the same IPv6 address in another spelling is the same peer', () => {
  assert.equal(same('2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001'), true);
  assert.equal(same('2001:0DB8::0001', '2001:db8::1'), true);
});

test('the same link-local address on another interface is not the same peer', () => {
  assert.equal(same('fe80::1234%eth0', 'fe80::1234%eth1'), false);
  assert.equal(same('fe80::1234%eth0', 'fe80::1234%eth0'), true);
});

test('something that is not an address never matches', () => {
  assert.equal(peerAddress('viewer.local'), null);
  assert.equal(same('viewer.local', 'viewer.local'), false);
  assert.equal(same('', ''), false);
  assert.equal(same('192.0.2.50', 'not an address'), false);
});

for (const [raw, host] of [
  ['192.0.2.50%eth0', '192.0.2.50'],
  ['fe80::1%', 'fe80::1'],
  ['fe80::1%eth0%other', 'fe80::1%eth0'],
] as const) {
  test(`'${raw}' is not an address, as a viewer or a sender`, () => {
    assert.equal(peerAddress(raw), null);
    assert.equal(viewerPeer(raw, LOCAL), null);
    assert.equal(same(host, raw), false);
  });
}

test('a link-local viewer counts only on the interface of our HAP connection', () => {
  assert.deepEqual(viewerPeer('fe80::1234', LOCAL), { address: 'fe80::1234', zone: 'eth0' });
  assert.equal(viewer('fe80::1234', LOCAL, 'fe80::1234%eth0'), true);
  assert.equal(viewer('fe80::1234', LOCAL, 'fe80::1234%eth1'), false);
  assert.equal(viewer('fe80::1234', LOCAL, 'fe80::1234'), false);
  // Link-local is fe80::/10.
  assert.equal(viewerPeer('febf::1', LOCAL)?.zone, 'eth0');
  assert.equal(viewerPeer('fec0::1', LOCAL)?.zone, null);
});

test("the viewer address's own zone is ignored; ours decides", () => {
  assert.deepEqual(viewerPeer('fe80::1234%en0', LOCAL), { address: 'fe80::1234', zone: 'eth0' });
  assert.equal(viewer('fe80::1234%en0', LOCAL, 'fe80::1234%eth0'), true);
  assert.equal(viewer('fe80::1234%en0', LOCAL, 'fe80::1234%en0'), false);
});

test('a global IPv6 or IPv4 viewer ignores zones and matches any spelling', () => {
  assert.deepEqual(viewerPeer('2001:0DB8::0001%en0', LOCAL), { address: '2001:db8::1', zone: null });
  assert.equal(viewer('2001:db8::1', LOCAL, '2001:0db8:0000:0000:0000:0000:0000:0001'), true);
  assert.equal(viewer('2001:0DB8::0001', LOCAL, '2001:db8::1%eth1'), true);
  assert.equal(viewer('2001:db8::1%en0', LOCAL, '2001:db8::1'), true);
  assert.equal(viewer('2001:db8::1', LOCAL, '2001:db8::2'), false);
  assert.equal(viewer('192.0.2.50', '192.0.2.5', '::ffff:192.0.2.50'), true);
  assert.equal(viewer('::FFFF:192.0.2.50', '192.0.2.5', '192.0.2.50'), true);
  assert.equal(viewer('192.0.2.50', '192.0.2.5', '192.0.2.51'), false);
});

// The documented limitation: with no zone on our own address there is no
// interface to hold a link-local viewer to.
test('limitation: with no local zone known, a link-local viewer matches on any interface', () => {
  assert.equal(viewer('fe80::1234', 'fe80::abcd', 'fe80::1234%eth1'), true);
  assert.equal(viewer('fe80::1234', undefined, 'fe80::1234%eth1'), true);
  assert.equal(viewer('fe80::1234', 'not an address', 'fe80::1234%eth1'), true);
});

// Our media address: our end of the HAP connection, when it fits the stream.
test('our media address is our end of the HAP connection in canonical form', () => {
  assert.deepEqual(localMediaAddress('::ffff:192.0.2.33', false), { address: '192.0.2.33', zone: null });
  assert.deepEqual(localMediaAddress('192.0.2.33', false), { address: '192.0.2.33', zone: null });
  assert.deepEqual(localMediaAddress('fe80::abcd%eth0', true), { address: 'fe80::abcd', zone: 'eth0' });
  assert.deepEqual(localMediaAddress('2001:db8::5', true), { address: '2001:db8::5', zone: null });
});

test('there is no media address of another family than the stream, or without an address', () => {
  assert.equal(localMediaAddress('192.0.2.33', true), null);
  assert.equal(localMediaAddress('fe80::abcd%eth0', false), null);
  assert.equal(localMediaAddress(undefined, false), null);
  assert.equal(localMediaAddress('not an address', true), null);
});

test('a host string carries the zone after a %, and nothing else', () => {
  assert.equal(socketHost({ address: 'fe80::abcd', zone: 'eth0' }), 'fe80::abcd%eth0');
  assert.equal(socketHost({ address: '2001:db8::5', zone: null }), '2001:db8::5');
  assert.equal(socketHost({ address: '192.0.2.33', zone: null }), '192.0.2.33');
});

// A udp6 socket (and ffmpeg's IPv6 target) cannot take a bare IPv4 address.
test('for an IPv6 socket an IPv4 peer is written IPv4-mapped', () => {
  assert.equal(socketHost({ address: '192.0.2.50', zone: null }, true), '::ffff:192.0.2.50');
  assert.equal(socketHost({ address: '192.0.2.50', zone: null }, false), '192.0.2.50');
  assert.equal(socketHost({ address: '2001:db8::5', zone: null }, true), '2001:db8::5');
  assert.equal(socketHost({ address: 'fe80::abcd', zone: 'eth0' }, true), 'fe80::abcd%eth0');
});

// Preservation checks: these held before as well.
test('an expected peer without a zone matches a sender on any interface', () => {
  assert.equal(same('fe80::1234', 'fe80::1234%eth1'), true);
  assert.equal(same('FE80::1234', 'fe80::1234'), true);
});

test('IPv4 and IPv4-mapped IPv6 are the same peer; other addresses are not', () => {
  assert.equal(same('192.0.2.50', '::ffff:192.0.2.50'), true);
  assert.equal(same('::FFFF:192.0.2.50', '192.0.2.50'), true);
  assert.equal(same('192.0.2.50', '192.0.2.51'), false);
  assert.equal(same('2001:db8::1', '2001:db8::2'), false);
});

test('a well-formed zone is kept apart from the address', () => {
  assert.deepEqual(peerAddress('FE80::1234%eth0'), { address: 'fe80::1234', zone: 'eth0' });
  assert.deepEqual(peerAddress('::ffff:192.0.2.50%eth0'), { address: '192.0.2.50', zone: null });
  assert.deepEqual(peerAddress('192.0.2.50'), { address: '192.0.2.50', zone: null });
});
