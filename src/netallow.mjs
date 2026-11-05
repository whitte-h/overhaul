// Source-address allowlist, so the hub can listen on 0.0.0.0 (any LAN or VPN IP, even after
// DHCP changes) while Docker bridges and other networks are refused. The list comes from
// config.yaml `allow_from`; with none, only this machine.
import net from "node:net";

export const DEFAULT_ALLOW = ["127.0.0.0/8", "::1/128"];

export function allowList(cidrs = DEFAULT_ALLOW) {
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    const [addr, bits] = cidr.split("/");
    const type = net.isIPv6(addr) ? "ipv6" : "ipv4";
    list.addSubnet(addr, Number(bits ?? (type === "ipv6" ? 128 : 32)), type);
  }
  return (remote) => {
    if (!remote) return false;
    const v4 = remote.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (v4) return list.check(v4, "ipv4");
    return list.check(remote, net.isIPv6(remote) ? "ipv6" : "ipv4");
  };
}
