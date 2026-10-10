/**
 * A small symmetric avatar drawn from a wallet address, so every trader in a
 * feed is recognisable without loading third-party images.
 */
const HUES = [142, 160, 190, 210, 260, 290, 320, 20, 40, 55];

function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export function Identicon({ address, size = 36 }: { address: string | null; size?: number }) {
  const seed = hash(address ?? "unknown");
  const hue = HUES[seed % HUES.length];
  const cells: Array<[number, number]> = [];
  for (let index = 0; index < 15; index += 1) {
    if ((seed >>> (index + 4)) & 1) {
      const column = Math.floor(index / 5);
      const row = index % 5;
      cells.push([column, row]);
      if (column < 2) cells.push([4 - column, row]);
    }
  }
  return <svg className="identicon" width={size} height={size} viewBox="0 0 5 5" aria-hidden="true" shapeRendering="crispEdges">
    <rect width="5" height="5" fill={`hsl(${hue} 30% 14%)`} />
    {cells.map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={`hsl(${hue} 70% 62%)`} />)}
  </svg>;
}
