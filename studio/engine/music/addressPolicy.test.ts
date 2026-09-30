import { describe, expect, test } from "bun:test";
import { isPublicAddress } from "./addressPolicy";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The SSRF defence at connect time: an address a CDN host name resolves to is used only when it is a public unicast
// one. Every range a request could be steered into (this host, the LAN, cloud metadata, multicast, reserved) is refused.

describe("IPv4 addresses that are refused", () => {
  test.each([
    ["this network", "0.0.0.0"],
    ["this network, high end", "0.255.255.255"],
    ["loopback", "127.0.0.1"],
    ["loopback, high end", "127.255.255.254"],
    ["private 10/8", "10.0.0.1"],
    ["private 10/8, high end", "10.255.255.255"],
    ["private 172.16/12, low end", "172.16.0.1"],
    ["private 172.16/12, high end", "172.31.255.255"],
    ["private 192.168/16", "192.168.1.1"],
    ["link-local, and the cloud metadata address", "169.254.169.254"],
    ["carrier-grade NAT 100.64/10, low end", "100.64.0.1"],
    ["carrier-grade NAT 100.64/10, high end", "100.127.255.255"],
    ["IETF protocol assignments 192.0.0/24", "192.0.0.8"],
    ["documentation 192.0.2/24", "192.0.2.1"],
    ["6to4 relay anycast 192.88.99/24", "192.88.99.1"],
    ["benchmarking 198.18/15, low end", "198.18.0.1"],
    ["benchmarking 198.18/15, high end", "198.19.255.255"],
    ["documentation 198.51.100/24", "198.51.100.7"],
    ["documentation 203.0.113/24", "203.0.113.9"],
    ["multicast, low end", "224.0.0.1"],
    ["multicast, high end", "239.255.255.255"],
    ["reserved 240/4", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
  ])("%s (%s)", (_label, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe("IPv4 addresses that are public, next to the refused ranges", () => {
  test.each([
    ["one below 10/8", "9.255.255.255"],
    ["one above 10/8", "11.0.0.1"],
    ["one below 172.16/12", "172.15.255.255"],
    ["one above 172.16/12", "172.32.0.1"],
    ["one below 192.168/16", "192.167.255.255"],
    ["one above 192.168/16", "192.169.0.1"],
    ["one below 100.64/10", "100.63.255.255"],
    ["one above 100.64/10", "100.128.0.1"],
    ["one below link-local", "169.253.255.255"],
    ["one above link-local", "169.255.0.1"],
    ["one below 198.18/15", "198.17.255.255"],
    ["one above 198.18/15", "198.20.0.1"],
    ["one below multicast", "223.255.255.255"],
    ["a public resolver", "8.8.8.8"],
    ["a Facebook edge", "157.240.22.35"],
  ])("%s (%s)", (_label, address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("IPv6 addresses that are refused", () => {
  test.each([
    ["unspecified", "::"],
    ["loopback", "::1"],
    ["loopback, spelled out", "0:0:0:0:0:0:0:1"],
    ["unique local fc00::/7", "fc00::1"],
    ["unique local, high end", "fdff:ffff::1"],
    ["link-local fe80::/10", "fe80::1"],
    ["link-local, high end", "febf::1"],
    ["site-local (deprecated) fec0::/10", "fec0::1"],
    ["multicast ff00::/8", "ff02::1"],
    ["documentation 2001:db8::/32", "2001:db8::1"],
    ["discard-only 100::/64", "100::1"],
    ["Teredo 2001::/32", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["an IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["an IPv4-mapped loopback in hex", "::ffff:7f00:1"],
    ["an IPv4-mapped private address", "::ffff:10.1.2.3"],
    ["an IPv4-mapped metadata address", "::ffff:169.254.169.254"],
    ["an IPv4-compatible loopback (deprecated)", "::127.0.0.1"],
    ["NAT64 carrying a loopback address", "64:ff9b::7f00:1"],
    ["NAT64 carrying a private address", "64:ff9b::a00:1"],
    ["6to4 carrying a loopback address", "2002:7f00:1::1"],
    ["6to4 carrying a private address", "2002:c0a8:101::1"],
    ["an address with a zone id", "fe80::1%eth0"],
  ])("%s (%s)", (_label, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe("IPv6 addresses that are public", () => {
  test.each([
    ["Facebook's range", "2a03:2880:f12f:83:face:b00c:0:25de"],
    ["a Cloudflare address", "2606:4700:4700::1111"],
    ["an IPv4-mapped public address (judged by its IPv4 part)", "::ffff:8.8.8.8"],
    ["NAT64 carrying a public address", "64:ff9b::808:808"],
    ["6to4 carrying a public address", "2002:808:808::1"],
  ])("%s (%s)", (_label, address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("what is not an address at all", () => {
  test.each([
    ["an empty string", ""],
    ["a host name", "scontent-fra3-1.cdninstagram.com"],
    ["a dotted quad with a fifth part", "1.2.3.4.5"],
    ["an octet over 255", "1.2.3.256"],
    ["a leading-zero octet (read as octal by some resolvers)", "010.0.0.1"],
    ["a decimal IPv4", "2130706433"],
    ["a hex IPv4", "0x7f000001"],
    ["IPv6 with two double colons", "1::2::3"],
    ["IPv6 with a group over four digits", "12345::1"],
    ["text with a newline", "8.8.8.8\n127.0.0.1"],
  ])("%s is refused: it is not a public address", (_label, text) => {
    expect(isPublicAddress(text)).toBe(false);
  });
});
