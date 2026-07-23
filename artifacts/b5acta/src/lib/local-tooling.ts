export function isLocalToolingHost(hostname: string): boolean {
  if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return true;

  const octets = hostname.split(".").map(part => Number(part));
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;

  return false;
}
