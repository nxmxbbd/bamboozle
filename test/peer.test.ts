// Which sender counts as the viewer, for the RTCP idle check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSamePeer, peerAddress } from '../src/camera/peer.ts';

const same = (expected: string, sender: string) => isSamePeer(peerAddress(expected), sender);

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

// Preservation checks: these held before as well.
test('a peer named without a zone matches on any interface', () => {
  assert.equal(same('fe80::1234', 'fe80::1234%eth1'), true);
  assert.equal(same('FE80::1234', 'fe80::1234'), true);
});

test('IPv4 and IPv4-mapped IPv6 are the same peer; other addresses are not', () => {
  assert.equal(same('192.0.2.50', '::ffff:192.0.2.50'), true);
  assert.equal(same('::FFFF:192.0.2.50', '192.0.2.50'), true);
  assert.equal(same('192.0.2.50', '192.0.2.51'), false);
  assert.equal(same('2001:db8::1', '2001:db8::2'), false);
});
