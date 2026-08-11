import { describe, expect, it } from "vitest";

import { addressIsRestricted } from "./egress-policy.service";

/**
 * V5-1: a private IPv4 wrapped in a transitional IPv6 embedding must be
 * restricted exactly like the bare IPv4; a public embedded IPv4 must pass
 * normal policy (the transitional prefixes are not blanket-restricted).
 */
describe("transitional IPv6 embeddings", () => {
  describe("private embedded IPv4 is restricted", () => {
    it.each([
      ["IPv4-mapped", "::ffff:10.0.0.1"],
      ["IPv4-mapped uppercase", "::FFFF:10.0.0.1"],
      ["IPv4-mapped hex groups", "::ffff:a00:1"],
      ["NAT64 well-known", "64:ff9b::10.0.0.1"],
      ["NAT64 hex groups", "64:ff9b::a00:1"],
      ["NAT64 loopback", "64:ff9b::7f00:1"],
      ["6to4 private", "2002:a00:1::"],
      ["6to4 loopback", "2002:7f00:1::"],
      ["6to4 link-local", "2002:a9fe:a9fe::"],
      ["IPv4-compatible", "::10.0.0.1"],
      ["IPv4-compatible metadata", "::169.254.169.254"],
      ["Teredo private server", "2001:0:a00:1::"],
      // Teredo client 10.0.0.1 → low 32 bits are ~0x0a000001 = f5ff:fffe.
      ["Teredo private client (inverted)", "2001:0:808:808:0:0:f5ff:fffe"],
    ])("restricts %s", (_label, address) => {
      expect(addressIsRestricted(address)).toBe(true);
    });
  });

  describe("public embedded IPv4 follows normal policy", () => {
    it.each([
      ["IPv4-mapped public", "::ffff:8.8.8.8"],
      ["NAT64 public", "64:ff9b::808:808"],
      ["6to4 public", "2002:808:808::"],
      ["plain global unicast", "2607:f8b0:4004:c07::71"],
    ])("does not restrict %s", (_label, address) => {
      expect(addressIsRestricted(address)).toBe(false);
    });
  });

  describe("native IPv6 special ranges stay restricted", () => {
    it.each([
      ["unspecified", "::"],
      ["loopback", "::1"],
      ["unique local", "fc00::1"],
      ["unique local fd", "fd12:3456:789a::1"],
      ["link local", "fe80::1"],
      ["multicast", "ff02::1"],
    ])("restricts %s", (_label, address) => {
      expect(addressIsRestricted(address)).toBe(true);
    });
  });

  describe("bare IPv4 baseline", () => {
    it.each([
      ["10.0.0.1", true],
      ["127.0.0.1", true],
      ["169.254.169.254", true],
      ["172.16.0.1", true],
      ["192.168.1.1", true],
      ["100.64.0.1", true],
      ["8.8.8.8", false],
      ["203.0.113.42", false],
    ])("addressIsRestricted(%s) === %s", (address, restricted) => {
      expect(addressIsRestricted(address)).toBe(restricted);
    });
  });
});
