/**
 * Random selection with a half-pool cooldown.
 *
 * Once an item is chosen it stays unavailable for floor(n / 2) later picks.
 * This keeps variety high without turning the order into a predictable shuffle.
 */
export function createCooldownPicker<T>(
  items: readonly T[],
  fallback: T,
  random: () => number = Math.random,
): () => T {
  const recent: number[] = [];
  const cooldown = Math.floor(items.length / 2);

  return () => {
    if (items.length === 0) return fallback;
    if (cooldown <= 0) {
      return items[Math.floor(random() * items.length)] ?? fallback;
    }

    const blocked = new Set(recent);
    const available: number[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if (!blocked.has(index)) available.push(index);
    }
    const pool =
      available.length > 0 ? available : items.map((_, index) => index);
    const chosen = pool[Math.floor(random() * pool.length)] ?? pool[0]!;

    recent.push(chosen);
    if (recent.length > cooldown) recent.shift();
    return items[chosen] ?? fallback;
  };
}
